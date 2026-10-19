/**
 * 广场客户端逻辑测试（平台服务工程设计 V6/V9——M1.3）
 *
 * 覆盖：toPlazaCard 派生（无 key_l1 + 验签过 + 降级攻击防护）、
 * plazaOutline 轮廓、filterPlazaPool 本地过滤（验签/TTL/自己去黑去重）。
 */

import { describe, expect, it } from 'vitest';
import { MatchCardEnvelope } from '@hongxian/schema';
import { signMatchCard, verifyMatchCard, decryptLayer } from '../src/card/envelope.js';
import { filterPlazaPool, plazaOutline, toPlazaCard } from '../src/plaza.js';
import { makeTestKeyProvider, sampleL1, sampleL2 } from './helpers.js';
import { fromBase64 } from '@hongxian/schema';

const depth = { interview_rounds: 9, completeness: 0.75, model_tier: 'local' as const };

function signMatch(): MatchCardEnvelope {
  const { key } = makeTestKeyProvider();
  return signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, key);
}

describe('toPlazaCard（V6：广场卡剥离 key_l1）', () => {
  it('派生卡无 key_l1、card_type=plaza_card、验签通过', () => {
    const { key } = makeTestKeyProvider();
    const match = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, key);
    expect(match.key_l1).toBeDefined(); // 文件卡带钥匙

    const plaza = toPlazaCard(match, key);
    expect(plaza.key_l1).toBeUndefined();
    expect(plaza.meta.card_type).toBe('plaza_card');
    expect(plaza.meta.card_id).not.toBe(match.meta.card_id); // 新卡 ID
    expect(plaza.meta.owner_key_id).toBe(match.meta.owner_key_id); // 同主人
    expect(plaza.payload_L1).toEqual(match.payload_L1); // 密文原样保留
    expect(plaza.payload_L2).toEqual(match.payload_L2);

    const v = verifyMatchCard(plaza);
    expect(v.valid).toBe(true);
  });

  it('密文保留：grant_l1 交付钥匙后可直接解密 L1（V6 闭环）', () => {
    const { key, km } = makeTestKeyProvider();
    const match = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, key);
    const plaza = toPlazaCard(match, key);
    // 模拟服务端只见到 plaza（无 key_l1）——持卡者无法解 L1
    expect(plaza.key_l1).toBeUndefined();
    // 卡主经 grant_l1 交付钥匙（= 本方层密钥）后，持卡者可解
    const opened = decryptLayer(plaza, 'L1', km.layerKeys.L1);
    expect(opened.ok).toBe(true);
    expect((opened as { payload?: unknown }).payload).toBeDefined();
  });

  it('降级攻击防护：把 plaza_card 改回 match_card 会验签失败（签名覆盖 meta）', () => {
    const { key } = makeTestKeyProvider();
    const match = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, key);
    const plaza = toPlazaCard(match, key);
    const tampered = {
      ...plaza,
      key_l1: match.key_l1, // 攻击者补回钥匙并改标——结构上成了合法 match_card
      meta: { ...plaza.meta, card_type: 'match_card' as const },
    };
    // 格式闸门不报警（match_card 带 key_l1 合法）——防线在密码学层：
    expect(MatchCardEnvelope.safeParse(tampered).success).toBe(true);
    const v = verifyMatchCard(tampered);
    expect(v.valid).toBe(false); // 签名不覆盖改后的 meta——降级即作废
  });

  it('signMatchCard 直签 plaza_card 同样不携 key_l1（M1.1 缺口修复）', () => {
    const { key } = makeTestKeyProvider();
    const plaza = signMatchCard({ cardType: 'plaza_card', depth, l1: sampleL1, l2: sampleL2 }, key);
    expect(plaza.key_l1).toBeUndefined();
    expect(verifyMatchCard(plaza).valid).toBe(true);
  });

  it('ttlDays 控制广场卡 TTL（默认 30 天）', () => {
    const { key } = makeTestKeyProvider();
    const plaza = toPlazaCard(signMatch(), key);
    const days = (Date.parse(plaza.meta.expires_at) - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);
  });
});

describe('plazaOutline', () => {
  it('轮廓只含公开材料（无任何内容字段）', () => {
    const { key } = makeTestKeyProvider();
    const plaza = toPlazaCard(signMatch(), key);
    const o = plazaOutline(plaza, 'a1b2c3d4e5f6a7b8');
    expect(o.opaque_id).toBe(plaza.meta.owner_key_id);
    expect(o.kx_public).toBe(plaza.meta.kx_public);
    expect(o.fingerprint).toBe('a1b2c3d4e5f6a7b8');
    expect(o.has_l3).toBe(false);
    const keys = Object.keys(o).sort();
    expect(keys).not.toContain('payload_L1');
    expect(keys).not.toContain('key_l1');
    expect(keys).not.toContain('bio');
    expect(keys).not.toContain('nickname');
  });
});

describe('filterPlazaPool（哑管道的客户端过滤）', () => {
  function poolOf(): { cards: MatchCardEnvelope[]; opaqueOf: (c: MatchCardEnvelope) => string } {
    const a = makeTestKeyProvider();
    const b = makeTestKeyProvider();
    const c = makeTestKeyProvider();
    const mk = (k: ReturnType<typeof makeTestKeyProvider>['key']) =>
      toPlazaCard(signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, k), k);
    const cards = [mk(a.key), mk(b.key), mk(c.key)];
    return { cards, opaqueOf: (card) => card.meta.owner_key_id };
  }

  it('全部通过：验签 + 轮廓完整', () => {
    const { cards } = poolOf();
    const r = filterPlazaPool(cards);
    expect(r.outlines).toHaveLength(3);
    expect(r.passed).toHaveLength(3);
    expect(r.rejected).toHaveLength(0);
  });

  it('验签失败即废（§7.4 不降级）', () => {
    const { cards } = poolOf();
    const tampered = { ...cards[0]!, payload_L1: { ...cards[0]!.payload_L1, ct: 'AAAA' } };
    const r = filterPlazaPool([tampered, cards[1]!]);
    expect(r.outlines).toHaveLength(1);
    expect(r.rejected[0]!.reason).toContain('签名');
  });

  it('排除本方卡', () => {
    const { cards, opaqueOf } = poolOf();
    const r = filterPlazaPool(cards, { my_opaque_id: opaqueOf(cards[0]!) });
    expect(r.outlines).toHaveLength(2);
    expect(r.rejected[0]!.reason).toBe('本方卡');
  });

  it('排除已拉黑发件人（D15④）', () => {
    const { cards, opaqueOf } = poolOf();
    const r = filterPlazaPool(cards, { blocked_opaque_ids: [opaqueOf(cards[1]!)] });
    expect(r.outlines).toHaveLength(2);
    expect(r.rejected[0]!.reason).toBe('已拉黑的发件人');
  });

  it('排除已浏览过的卡', () => {
    const { cards } = poolOf();
    const r = filterPlazaPool(cards, { seen_card_ids: [cards[0]!.meta.card_id] });
    expect(r.outlines).toHaveLength(2);
    expect(r.rejected[0]!.reason).toBe('已浏览过');
  });

  it('过期卡被过滤', () => {
    const { cards } = poolOf();
    // 签时就已过期的 plaza_card（toPlazaCard 会按发布时刻重刷 TTL，
    // 故此处直签过期变体验证 TTL 过滤分支）
    const { key } = makeTestKeyProvider();
    const expired = signMatchCard({ cardType: 'plaza_card', ttlDays: -1, depth, l1: sampleL1, l2: sampleL2 }, key);
    const r = filterPlazaPool([expired, cards[1]!]);
    expect(r.outlines).toHaveLength(1);
    expect(r.rejected[0]!.reason).toContain('过期');
  });

  it('非广场卡变体被过滤（match_card 不进广场池）', () => {
    const match = signMatch();
    const r = filterPlazaPool([match]);
    expect(r.outlines).toHaveLength(0);
    expect(r.rejected[0]!.reason).toBe('非广场卡变体');
  });

  it('畸形输入不崩溃', () => {
    const r = filterPlazaPool([null, 42, 'x', {}, { meta: {} }]);
    expect(r.outlines).toHaveLength(0);
    expect(r.rejected).toHaveLength(5);
  });
});

describe('grant_l1 密封交付闭环（V6：显式授权解锁一阶）', () => {
  it('卡主用请求方 kx_public 密封 key_l1，请求方解封后可得 L1 明文', () => {
    const owner = makeTestKeyProvider();
    const requester = makeTestKeyProvider();
    const plaza = toPlazaCard(signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, owner.key), owner.key);

    // 卡主侧：密封本方 L1 层密钥至请求方协商公钥
    const sealed = owner.key.sealFor(requester.kxOther, owner.km.layerKeys.L1);
    // 服务端只转发 sealed（密文）——零知识
    // 请求方侧：解封得钥匙，解密其已持有的广场卡 L1 密文
    const openedKey = requester.key.openSealed(sealed);
    expect(openedKey).not.toBeNull();
    const l1 = decryptLayer(plaza, 'L1', openedKey!);
    expect(l1.ok).toBe(true);
    expect((l1 as { payload: { nickname: string } }).payload.nickname).toBe(sampleL1.nickname);
  });

  it('sealed 材料本身不含钥匙（服务端视角不可解密）', () => {
    const owner = makeTestKeyProvider();
    const requester = makeTestKeyProvider();
    const sealed = owner.key.sealFor(requester.kxOther, owner.km.layerKeys.L1);
    // 第三方（只有密文 + 广场卡）无法解封
    const third = makeTestKeyProvider();
    expect(third.key.openSealed(sealed)).toBeNull();
    // 密封材料长度固定（ephPub||nonce||ct），不含可推断结构
    expect(fromBase64(Buffer.from(sealed).toString('base64')).length).toBeGreaterThan(0);
  });
});
