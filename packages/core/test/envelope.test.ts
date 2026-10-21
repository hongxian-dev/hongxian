import { describe, expect, it } from 'vitest';
import { canonicalize, fromBase64 } from '@hongxian/schema';
import {
  assertL3Signable,
  assertSignable,
  cardFingerprint,
  decryptLayer,
  openMessageBody,
  resignCard,
  sealMessageBody,
  signMatchCard,
  unwrapLayerKey,
  verifyCardSignature,
  verifyMatchCard,
  wrapLayerKey,
} from '../src/card/envelope.js';
import { l3ContainerKey, l3FieldKey, l3FieldNamesIn, openL3Field } from '../src/card/l3.js';
import { makeTestKeyProvider, sampleL1, sampleL2 } from './helpers.js';

const depth = { interview_rounds: 3, completeness: 0.8, model_tier: 'local' as const };

describe('信封工厂（S4：卡能签出来、能验、能互传）', () => {
  it('签发：meta + 三层密文 + 签名，结构合法', () => {
    const { key } = makeTestKeyProvider();
    const card = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, key);
    expect(card.meta.schema_version).toBe(1);
    expect(card.meta.card_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(card.meta.version).toBe(1);
    expect(card.meta.owner_key_id).toHaveLength(44); // 32B base64
    expect(card.signature.length).toBeGreaterThan(10);
    expect(card.payload_L1.nonce).not.toBe(card.payload_L2.nonce);
    expect(card.payload_L3).toBeUndefined();
  });

  it('L1 密钥随卡：对方拿到卡 + 我方交付的 key_L1 即可解出 L1 明文', () => {
    const { key, km } = makeTestKeyProvider();
    const card = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, key);
    // 模拟对方：从可信渠道获得 key_L1（Schema §8 拍板①：L1 也加密，key 随卡携带）
    const opened = decryptLayer(card, 'L1', km.layerKeys.L1);
    expect(opened.ok).toBe(true);
    expect((opened as { payload: { nickname: string } }).payload.nickname).toBe('阿泽');
  });

  it('无层密钥者解不开任何层（第三方截获仅得密文）', () => {
    const { key } = makeTestKeyProvider();
    const other = makeTestKeyProvider();
    const card = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, key);
    const wrong = decryptLayer(card, 'L1', other.km.layerKeys.L1);
    expect(wrong.ok).toBe(false);
  });

  it('验签：整卡通过；任何一层被篡改 → 签名无效（§7.4 不降级）', () => {
    const { key, km } = makeTestKeyProvider();
    const card = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, key);
    const pub = km.identityPublic;
    expect(verifyCardSignature(card, pub)).toBe(true);
    const tampered = {
      ...card,
      payload_L2: { nonce: card.payload_L2.nonce, ct: Buffer.from(Buffer.from(card.payload_L2.ct, 'base64')).toString('base64') },
    };
    // 翻转 L2 密文一字节
    const raw = Buffer.from(card.payload_L2.ct, 'base64');
    raw[0] ^= 0xff;
    const tampered2 = { ...card, payload_L2: { ...card.payload_L2, ct: raw.toString('base64') } };
    expect(verifyCardSignature(tampered2, pub)).toBe(false);
    expect(verifyCardSignature(tampered, pub)).toBe(true); // 仅 re-encode 不应改变内容
  });

  it('TTL：默认 30 天；verifyMatchCard 标记过期', () => {
    const { key } = makeTestKeyProvider();
    const card = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, key);
    expect(Date.parse(card.meta.expires_at) - Date.parse(card.meta.created_at)).toBe(30 * 86400_000);
    expect(verifyMatchCard(card).expired).toBe(false);
    const expiredCard = { ...card, meta: { ...card.meta, expires_at: '2020-01-01T00:00:00.000Z' } };
    const r = verifyMatchCard(expiredCard);
    expect(r.expired).toBe(true);
    expect(r.warnings.some((w) => w.includes('过期'))).toBe(true);
  });

  it('未知字段容错：带未来字段的卡仍可通过（向前兼容）', () => {
    const { key } = makeTestKeyProvider();
    const card = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, key);
    const withFuture = { ...card, meta: { ...card.meta, v2_future_field: 'x' } };
    const r = verifyMatchCard(withFuture);
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.includes('v2_future_field'))).toBe(true);
  });

  it('重签：version+1，签名变化（旧 version 作废）', () => {
    const { key } = makeTestKeyProvider();
    const v1 = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, key);
    const v2 = resignCard(v1, { depth, l1: { ...sampleL1, bio: '更新后的介绍' }, l2: sampleL2 }, key);
    expect(v2.meta.version).toBe(2);
    expect(v2.meta.card_id).not.toBe(v1.meta.card_id);
    expect(v2.signature).not.toBe(v1.signature);
  });

  it('L3 见面层：逐字段独立密钥（D13）——只交容器钥匙 + 单字段子密钥，读不到其他字段', () => {
    const { key, km } = makeTestKeyProvider();
    const card = signMatchCard(
      { depth, l1: sampleL1, l2: sampleL2, l3: { contact_wechat: 'yuelao2026', contact_phone: '13800000000' } },
      key,
    );
    expect(card.payload_L3).toBeDefined();

    // 用 L3 层密钥解不开外层——外层用的是容器子密钥（否则交层密钥等于交全部字段）
    expect(decryptLayer(card, 'L3', km.layerKeys.L3).ok).toBe(false);

    const container = decryptLayer(card, 'L3', l3ContainerKey(km.layerKeys.L3));
    expect(container.ok).toBe(true);
    const payload = (container as { payload: unknown }).payload;
    expect(l3FieldNamesIn(payload).sort()).toEqual(['contact_phone', 'contact_wechat']);

    // 只授予 contact_wechat：拿得到微信号，拿不到手机号
    const wx = openL3Field(payload, 'contact_wechat', l3FieldKey(km.layerKeys.L3, 'contact_wechat'));
    expect(wx.ok && wx.value).toBe('yuelao2026');
    const phoneWithWxKey = openL3Field(payload, 'contact_phone', l3FieldKey(km.layerKeys.L3, 'contact_wechat'));
    expect(phoneWithWxKey.ok).toBe(false); // 子密钥不通用

    // 字段名不在白名单：拒绝签发
    expect(() =>
      signMatchCard({ depth, l1: sampleL1, l2: sampleL2, l3: { id_card: 'x' } as never }, key),
    ).toThrow(/白名单/);
  });

  it('签发前置校验：缺 age_attested / 非受控词表拒绝', () => {
    const { key } = makeTestKeyProvider();
    expect(() => assertSignable({ ...sampleL1, age_attested: false }, sampleL2)).toThrow(/公开层/);
    expect(() => assertSignable({ ...sampleL1, interests: ['不存在的兴趣'] }, sampleL2)).toThrow(/公开层/);
    expect(() => assertSignable(sampleL1, { ...sampleL2, money_view: '随便花' })).toThrow(/匹配层/);
    expect(() => assertL3Signable({})).toThrow(/至少要有一个字段/);
  });
});

describe('grant 层密钥交付（D5 对称互换：只交付密钥不解密文）', () => {
  it('wrapLayerKey → 对端私钥解封得到同一层密钥', () => {
    const a = makeTestKeyProvider();
    const b = makeTestKeyProvider();
    const wrapped = wrapLayerKey(a.km.layerKeys.L2, b.kxOther);
    const opened = unwrapLayerKey(wrapped, b.key);
    expect(opened).not.toBeNull();
    expect(Buffer.from(opened!).equals(Buffer.from(a.km.layerKeys.L2))).toBe(true);
  });

  it('非对端私钥解不开（第三方截获 grant 信封无用）', () => {
    const a = makeTestKeyProvider();
    const b = makeTestKeyProvider();
    const eve = makeTestKeyProvider();
    const wrapped = wrapLayerKey(a.km.layerKeys.L2, b.kxOther);
    expect(unwrapLayerKey(wrapped, eve.key)).toBeNull();
  });
});

describe('消息信封加封/拆封（九类信封的 payload 层）', () => {
  it('定向消息：对端公钥加封 → 对端私钥拆封', () => {
    const a = makeTestKeyProvider();
    const b = makeTestKeyProvider();
    const body = { from_card_id: '019515f4-7d4e-7c3a-9b1d-2e8a6c0f1234', round: 1, topic: '周末怎么过' };
    const block = sealMessageBody(body, b.kxOther, a.key);
    const opened = openMessageBody(block, b.key);
    expect(opened.ok).toBe(true);
    expect((opened as { body: { topic: string } }).body.topic).toBe('周末怎么过');
  });

  it('指纹：确定性 + 16 位十六进制（QR 交换确认码）', () => {
    const { key } = makeTestKeyProvider();
    const card = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, key);
    expect(cardFingerprint(card)).toMatch(/^[0-9a-f]{16}$/);
    expect(cardFingerprint(card)).toBe(cardFingerprint(card));
  });

  it('canonicalize 用于签名：键序不影响签名验证', () => {
    const { key, km } = makeTestKeyProvider();
    const card = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, key);
    const reordered = {
      signature: card.signature,
      payload_L2: card.payload_L2,
      key_l1: card.key_l1,
      payload_L1: card.payload_L1,
      meta: card.meta,
    };
    // 重新序列化为规范化 JSON 应等价（canonicalize 排序键）
    expect(canonicalize(reordered)).toBe(canonicalize(card));
    expect(verifyCardSignature(card, km.identityPublic)).toBe(true);
  });
});
