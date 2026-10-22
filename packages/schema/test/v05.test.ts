/**
 * Schema v0.5 · 声明式圈层（declared_filters）契约测试
 *
 * 要点：
 * 1. 只允许 plaza_card 携带——match_card 是私交名片，没有圈层的消费者；
 * 2. 空对象拒绝——"我声明了"却什么都不声明，只会误导对方；
 * 3. 字段受控（6 位国标城市码 / 枚举性别与年龄段 / 三种可见范围）；
 * 4. 未知字段走 §7.2 向前兼容告警，不炸整个信封。
 */

import { describe, expect, it } from 'vitest';
import { MatchCardEnvelope, SCHEMA_VERSION, validateEnvelope } from '../src/index.js';

const keyId = Buffer.alloc(32, 7).toString('base64');
const sigPub = Buffer.alloc(32, 8).toString('base64');
const kxPub = Buffer.alloc(32, 9).toString('base64');

const baseMeta = {
  schema_version: SCHEMA_VERSION,
  card_id: '019515f4-7d4e-7c3a-9b1d-2e8a6c0f1234',
  owner_key_id: keyId,
  sig_public: sigPub,
  kx_public: kxPub,
  version: 1,
  created_at: '2026-10-19T00:00:00.000Z',
  expires_at: '2026-11-18T00:00:00.000Z',
  depth: { interview_rounds: 3, completeness: 0.75, model_tier: 'local' },
  algo: { sig: 'ed25519', aead: 'aes-256-gcm', kex: 'x25519' },
};

const payloads = {
  payload_L1: { nonce: 'AAAA', ct: 'BBBB' },
  payload_L2: { nonce: 'CCCC', ct: 'DDDD' },
  signature: 'c2ln',
};

function makeEnvelope(cardType: 'match_card' | 'plaza_card', declared?: Record<string, unknown>) {
  return {
    meta: {
      ...baseMeta,
      card_type: cardType,
      ...(declared ? { declared_filters: declared } : {}),
    },
    ...payloads,
  };
}

describe('v0.5 · declared_filters 位置约束', () => {
  it('plaza_card 可携带完整声明', () => {
    const r = validateEnvelope(
      makeEnvelope('plaza_card', {
        gender: 'female',
        seeking: 'male',
        city: '310000',
        age_band: '26_30',
        visible_to: 'same_city',
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.data?.meta.declared_filters).toEqual({
      gender: 'female',
      seeking: 'male',
      city: '310000',
      age_band: '26_30',
      visible_to: 'same_city',
    });
  });

  it('plaza_card 不声明 → 合法（圈层是可选项，不是必填）', () => {
    const r = validateEnvelope(makeEnvelope('plaza_card'));
    expect(r.ok).toBe(true);
    expect(r.data?.meta.declared_filters).toBeUndefined();
  });

  it('match_card 携带声明 → 拒收（私交名片没有圈层消费者，只会多一条泄露面）', () => {
    const r = validateEnvelope(makeEnvelope('match_card', { city: '310000' }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('declared_filters');
  });

  it('空对象声明 → 拒收（"我声明了"却什么都没声明，只会误导对方）', () => {
    const r = validateEnvelope(makeEnvelope('plaza_card', {}));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('至少声明一个字段');
  });
});

describe('v0.5 · declared_filters 取值约束', () => {
  it('城市必须是 6 位国标码', () => {
    const r = validateEnvelope(makeEnvelope('plaza_card', { city: '3100' }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('6 位国标码');
  });

  it('性别/择偶方向只接受受控枚举', () => {
    const bad = validateEnvelope(makeEnvelope('plaza_card', { gender: 'other' }));
    expect(bad.ok).toBe(false);
    const good = validateEnvelope(makeEnvelope('plaza_card', { gender: 'male', seeking: 'female' }));
    expect(good.ok).toBe(true);
  });

  it('visible_to 只接受 all / same_city / same_age_band', () => {
    expect(validateEnvelope(makeEnvelope('plaza_card', { visible_to: 'friends_only' })).ok).toBe(false);
    expect(validateEnvelope(makeEnvelope('plaza_card', { visible_to: 'same_age_band' })).ok).toBe(true);
  });

  it('未知字段按 §7.2 忽略并告警，不炸信封', () => {
    const r = validateEnvelope(makeEnvelope('plaza_card', { city: '310000', income: 'high' }));
    // 未知字段在 meta.declared_filters 内部——由 zod 默认 strip 处理；信封本身仍合法
    expect(r.ok).toBe(true);
    expect(r.data?.meta.declared_filters).toEqual({ city: '310000' });
  });

  it('MatchCardEnvelope 直接解析同样执行约束（不经 validateEnvelope 也拦得住）', () => {
    const parsed = MatchCardEnvelope.safeParse(makeEnvelope('match_card', { city: '310000' }));
    expect(parsed.success).toBe(false);
  });
});
