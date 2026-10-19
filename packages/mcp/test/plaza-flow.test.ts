/**
 * 广场流共享逻辑测试（M1.3）——completeMessageBody / routeEnvelope
 *
 * 真实 Session（Argon2id 派生密钥一次，文件状态逐测试重置）+
 * 真实密码学（sealed box 往返）。HTTP 路径由 E2E 对真实服务端覆盖。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyMaterial, keyIdFromPublicKey, openBox, sealBox, signDetached, type KeyMaterial } from '@hongxian/crypto';
import {
  canonicalBytes,
  fromBase64,
  toBase64,
  uuidV7,
  type MsgEnvelope,
  type MatchCardEnvelope,
} from '@hongxian/schema';
import { signMatchCard, sealMessageBody, toPlazaCard, cardFingerprint, type KeyProvider } from '@hongxian/core';
import { Session } from '../src/session.js';
import { store } from '../src/context.js';
import { completeMessageBody, routeEnvelope } from '../src/tools-exchange.js';
import { saveCachedPlazaCard, saveOwnPlazaCard } from '../src/plaza-store.js';

const depth = { interview_rounds: 9, completeness: 0.7, model_tier: 'local' as const };
const sampleL1 = {
  nickname: '阿泽',
  gender: 'male' as const,
  seeking: 'female' as const,
  age_attested: true as const,
  age_band: '26_30' as const,
  city: { code: '310100', name: '上海' },
  height_band: '171_175' as const,
  marital_status: 'never_married' as const,
  job_category: 'tech' as const,
  education_band: 'bachelor' as const,
  interests: ['outdoor', 'reading', 'food'],
  bio: '写代码也爬山',
  goal: 'marriage_oriented' as const,
  econ_signal: ['independent' as const],
};
const sampleL2 = {
  values_tags: [{ tag: 'family_first' as const, weight: 0.8 }],
  lifestyle: { sleep: 'normal', smoking: 'never', drinking: 'occasionally', exercise: 'regularly', social: 'medium' },
  family_view: { parents_relation: 'harmonious', childbearing: 'want', cohabit_with_parents: 'reluctant' },
  money_view: 'balanced',
  assets_brief: { house: 'not_yet', car: 'owned' },
  dealbreakers: [],
  values_qa: [
    { question: '理想的一天？', answer: '早起爬山下午写代码' },
    { question: '钱为什么吵架？', answer: '提前说好大额支出' },
    { question: '家是什么？', answer: '可以说累的地方' },
  ],
  partner_pref: '情绪稳定，愿意沟通',
};

let home: string;
let session: Session;
const prevHome = process.env.HONGXIAN_HOME;

function foreignProvider(km: KeyMaterial): KeyProvider {
  return {
    sign: (bytes) => signDetached(bytes, km.identityPrivate),
    identityPublic: () => km.identityPublic,
    keyId: () => keyIdFromPublicKey(km.identityPublic),
    layerKey: (layer) => km.layerKeys[layer],
    sealFor: (recipientPub, plaintext) => sealBox(plaintext, recipientPub),
    openSealed: (sealed) => openBox(sealed, km.kxPrivate),
    kexPublic: () => km.kxPublic,
  };
}

/** 以"对方"身份构造一封密封给本方 session 的消息信封 */
function envelopeFrom(
  km: KeyMaterial,
  msgType: string,
  body: unknown,
  targetCardId?: string,
): MsgEnvelope {
  const fk = foreignProvider(km);
  const block = sealMessageBody(body, session.keyProvider().kexPublic(), fk);
  const now = Date.now();
  const meta = {
    schema_version: 1,
    card_id: uuidV7(),
    owner_key_id: toBase64(fk.keyId()),
    sig_public: toBase64(fk.identityPublic()),
    kx_public: toBase64(fk.kexPublic()),
    version: 1,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 7 * 86400_000).toISOString(),
    card_type: 'match_card',
    msg_type: msgType,
    ...(targetCardId ? { target_card_id: targetCardId } : {}),
    depth,
    algo: { sig: 'ed25519', aead: 'aes-256-gcm', kex: 'x25519' },
  };
  return { meta: meta as never, payload: block, signature: toBase64(fk.sign(canonicalBytes({ meta, payload: block }))) };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'hx-mcp-plaza-'));
  process.env.HONGXIAN_HOME = home;
  session = new Session();
  await session.initIdentity();
});

beforeEach(() => {
  // 重置文件状态（保留内存中的解锁会话——Argon2id 只跑一次）
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
});

afterAll(() => {
  session.lock();
  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.HONGXIAN_HOME;
  else process.env.HONGXIAN_HOME = prevHome;
});

/** 本方签一张匹配卡并写入 cards/mine */
function signMyCard(): MatchCardEnvelope {
  const card = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, session.keyProvider());
  store().write(`cards/mine/${card.meta.card_id}.json`, card);
  return card;
}

describe('completeMessageBody · upgrade_request 自动补全（v0.4）', () => {
  it('缺 requester_kx_public 时派生本方协商公钥', () => {
    const s = store();
    const myCard = signMyCard();
    const r = completeMessageBody('upgrade_request', {}, session, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.requester_kx_public).toBe(toBase64(session.keyProvider().kexPublic()));
    expect(r.body.from_card_id).toBe(myCard.meta.card_id);
    expect(r.body.attach_card_ref).toBe(`card:${myCard.meta.card_id}`);
    expect(r.recipientKx).toBeUndefined(); // 收件人公钥由调用方从卡片解析
  });

  it('已贴广场卡时引用本方广场卡', () => {
    const s = store();
    const myCard = signMyCard();
    const plaza = toPlazaCard(myCard, session.keyProvider());
    saveOwnPlazaCard(s, plaza);
    const r = completeMessageBody('upgrade_request', {}, session, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.from_card_id).toBe(plaza.meta.card_id);
    expect(r.body.attach_card_ref).toBe(`plaza:${plaza.meta.card_id}`);
  });

  it('显式传入的字段原样保留（含待校验的非法值——校验是下一步的事）', () => {
    const s = store();
    signMyCard();
    const r = completeMessageBody('upgrade_request', { requester_kx_public: 'garbage', from_card_id: 'x', attach_card_ref: 'y' }, session, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.requester_kx_public).toBe('garbage');
    expect(r.body.from_card_id).toBe('x');
  });

  it('无任何卡片时明确报错', () => {
    const r = completeMessageBody('upgrade_request', {}, session, store());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('sign_card');
  });
});

describe('completeMessageBody · grant_l1 密封钥匙派生（V6）', () => {
  function ownPlaza(): { card: MatchCardEnvelope; km: KeyMaterial } {
    const km = generateKeyMaterial();
    const card = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, foreignProvider(km));
    return { card, km };
  }

  it('由 card_fingerprint + requester_kx_public 派生 sealed_key_l1（请求方可解封得钥匙）', () => {
    const s = store();
    // 本位场景：卡主 = 本方 session（工具密封的是本方 L1 层密钥）
    const myCard = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, session.keyProvider());
    const plaza = toPlazaCard(myCard, session.keyProvider());
    saveOwnPlazaCard(s, plaza);
    const fp = cardFingerprint(plaza);

    const requester = generateKeyMaterial();
    const r = completeMessageBody(
      'grant_l1',
      { card_fingerprint: fp, requester_kx_public: toBase64(requester.kxPublic) },
      session,
      s,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipientKx).toEqual(requester.kxPublic);
    expect(r.body.sealed_key_l1).toBeTypeOf('string');
    expect(r.body.from_card_id).toBe(plaza.meta.card_id);
    // 请求方视角：解封得到的正是卡主（本方）的 L1 层密钥
    const requesterProvider = foreignProvider(requester);
    const opened = requesterProvider.openSealed(fromBase64(r.body.sealed_key_l1 as string));
    expect(opened).not.toBeNull();
    expect(toBase64(opened!)).toBe(toBase64(session.keyMaterial().layerKeys.L1));
  });

  it('指纹不匹配 / 缺公钥 / 指纹畸形 → 明确报错', () => {
    const s = store();
    const { card } = ownPlaza();
    const plaza = toPlazaCard(card, foreignProvider(generateKeyMaterial()));
    saveOwnPlazaCard(s, plaza);
    const requester = generateKeyMaterial();

    const wrongFp = completeMessageBody('grant_l1', { card_fingerprint: '0123456789abcdef', requester_kx_public: toBase64(requester.kxPublic) }, session, s);
    expect(wrongFp.ok).toBe(false);
    const noKx = completeMessageBody('grant_l1', { card_fingerprint: cardFingerprint(plaza) }, session, s);
    expect(noKx.ok).toBe(false);
    const badFp = completeMessageBody('grant_l1', { card_fingerprint: 'zzz', requester_kx_public: toBase64(requester.kxPublic) }, session, s);
    expect(badFp.ok).toBe(false);
  });

  it('其他类型原样透传', () => {
    const body = { from_card_id: 'a', round: 1, topic: 't', followups: [], reason: 'r', channel: 'yuelao' };
    const r = completeMessageBody('topic_pack', body, session, store());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toEqual(body);
    expect(r.recipientKx).toBeUndefined();
  });
});

describe('routeEnvelope · 广场/文件双流判别', () => {
  it('广场敲门：target_card_id 命中本方广场卡 → 指引 grant_l1', () => {
    const s = store();
    const myCard = signMyCard();
    const plaza = toPlazaCard(myCard, session.keyProvider());
    saveOwnPlazaCard(s, plaza);
    const fp = cardFingerprint(plaza);

    const km = generateKeyMaterial();
    const env = envelopeFrom(km, 'upgrade_request', { from_card_id: 'x', attach_card_ref: 'plaza', requester_kx_public: toBase64(km.kxPublic) }, plaza.meta.card_id);
    const result = routeEnvelope(env, session);
    const t = result.content[0]!.text;
    expect(t).toContain('敲门请求解锁一阶名片');
    expect(t).toContain('grant_l1');
    expect(t).toContain(fp);
    expect(t).toContain(toBase64(foreignProvider(km).keyId())); // 对方地址
  });

  it('文件流升级请求（无本方广场卡）→ 指引 grant_l2', () => {
    const km = generateKeyMaterial();
    const env = envelopeFrom(km, 'upgrade_request', { from_card_id: 'x', attach_card_ref: 'card', requester_kx_public: toBase64(km.kxPublic) }, '11111111-1111-7111-8111-111111111111');
    const result = routeEnvelope(env, session);
    expect(result.content[0]!.text).toContain('请求解锁匹配层');
  });

  it('一阶已解锁后的升级请求按 L2 流处理（状态判别）', () => {
    const s = store();
    const myCard = signMyCard();
    const plaza = toPlazaCard(myCard, session.keyProvider());
    saveOwnPlazaCard(s, plaza);
    const km = generateKeyMaterial();
    const lineDir = Buffer.from(keyIdFromPublicKey(km.identityPublic)).toString('hex');
    s.write(`lines/${lineDir}/layer-keys.json`, { key_l1: 'x' }); // 一阶已解锁
    const env = envelopeFrom(km, 'upgrade_request', { from_card_id: 'x', attach_card_ref: 'plaza', requester_kx_public: toBase64(km.kxPublic) }, plaza.meta.card_id);
    const result = routeEnvelope(env, session);
    expect(result.content[0]!.text).toContain('请求解锁匹配层');
  });

  it('grant_l1 送达：解封得钥匙 + 层密钥落线 + 广场卡转联系人卡', () => {
    const s = store();
    // 对方的广场卡（本方浏览存证）
    const km = generateKeyMaterial();
    const fk = foreignProvider(km);
    const theirCard = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, fk);
    const theirPlaza = toPlazaCard(theirCard, fk);
    saveCachedPlazaCard(s, theirPlaza);
    const fp = cardFingerprint(theirPlaza);

    // 对方把 key_l1 密封给本方
    const sealed = fk.sealFor(session.keyProvider().kexPublic(), km.layerKeys.L1);
    const env = envelopeFrom(km, 'grant_l1', { from_card_id: theirPlaza.meta.card_id, card_fingerprint: fp, sealed_key_l1: toBase64(sealed) });
    const result = routeEnvelope(env, session);
    expect(result.content[0]!.text).toContain('一阶名片已解锁');

    const lineDir = Buffer.from(keyIdFromPublicKey(km.identityPublic)).toString('hex');
    const keys = s.read<{ key_l1?: string; key_l2?: string }>(`lines/${lineDir}/layer-keys.json`);
    expect(keys?.key_l1).toBe(toBase64(km.layerKeys.L1));
    expect(existsSync(join(home, 'cards', 'contacts', lineDir, `${theirPlaza.meta.card_id}.json`))).toBe(true);
  });

  it('grant_l1 之后 grant_l2 不清掉 key_l1（层密钥合并）', () => {
    const s = store();
    const km = generateKeyMaterial();
    const fk = foreignProvider(km);
    const theirCard = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, fk);
    const theirPlaza = toPlazaCard(theirCard, fk);
    saveCachedPlazaCard(s, theirPlaza);
    const fp = cardFingerprint(theirPlaza);
    const sealedL1 = fk.sealFor(session.keyProvider().kexPublic(), km.layerKeys.L1);
    routeEnvelope(envelopeFrom(km, 'grant_l1', { from_card_id: 'x', card_fingerprint: fp, sealed_key_l1: toBase64(sealedL1) }), session);

    const wrappedL2 = fk.sealFor(session.keyProvider().kexPublic(), km.layerKeys.L2);
    routeEnvelope(envelopeFrom(km, 'grant_l2', { from_card_id: 'x', wrapped_key_l2: toBase64(wrappedL2) }), session);

    const lineDir = Buffer.from(keyIdFromPublicKey(km.identityPublic)).toString('hex');
    const keys = s.read<{ key_l1?: string; key_l2?: string }>(`lines/${lineDir}/layer-keys.json`);
    expect(keys?.key_l1).toBe(toBase64(km.layerKeys.L1));
    expect(keys?.key_l2).toBe(toBase64(km.layerKeys.L2));
  });

  it('grant_l1 但本地无广场卡存证 → 提示重新浏览（不假装成功）', () => {
    const km = generateKeyMaterial();
    const fk = foreignProvider(km);
    const sealed = fk.sealFor(session.keyProvider().kexPublic(), km.layerKeys.L1);
    const env = envelopeFrom(km, 'grant_l1', { from_card_id: 'x', card_fingerprint: '0123456789abcdef', sealed_key_l1: toBase64(sealed) });
    const result = routeEnvelope(env, session);
    expect(result.content[0]!.text).toContain('找不到对应的广场卡');
  });

  it('拉黑的线：一切信封不再呈报', () => {
    const s = store();
    const km = generateKeyMaterial();
    const lineDir = Buffer.from(keyIdFromPublicKey(km.identityPublic)).toString('hex');
    s.write(`lines/${lineDir}/state.json`, { line_id: 'l', owner_dir: lineDir, status: 'card_received', unresponded_upgrades: 0, rounds_total: 0, created_at: new Date().toISOString(), last_activity: new Date().toISOString(), blocked: true, notes: [] });
    const env = envelopeFrom(km, 'upgrade_request', { from_card_id: 'x', attach_card_ref: 'p', requester_kx_public: toBase64(km.kxPublic) });
    const result = routeEnvelope(env, session);
    expect(result.content[0]!.text).toContain('不再呈报');
  });
});
