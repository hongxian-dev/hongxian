import { describe, expect, it } from 'vitest';
import {
  CardMeta,
  MatchCardEnvelope,
  PayloadL1,
  PayloadL2,
  PayloadL3,
  SCHEMA_VERSION,
  isExpired,
  ttlRemainingMs,
  validateEnvelope,
  signatureObject,
} from '../src/card.js';
import {
  AGE_BANDS,
  COMPLETENESS_LOW_THRESHOLD,
  DEALBREAKER_DIMENSIONS,
  DEFAULT_TTL_DAYS,
  ECON_SIGNALS,
  INTERESTS,
  VALUES_TAGS,
} from '../src/vocab.js';
import { canonicalize, isBase64OfLength, isUuidV7, uuidV7 } from '../src/canonical.js';

const keyId = Buffer.alloc(32, 7).toString('base64');

const validMeta = {
  schema_version: SCHEMA_VERSION,
  card_id: '019515f4-7d4e-7c3a-9b1d-2e8a6c0f1234',
  owner_key_id: keyId,
  version: 1,
  created_at: '2026-10-19T00:00:00.000Z',
  expires_at: '2026-11-18T00:00:00.000Z',
  card_type: 'match_card',
  depth: { interview_rounds: 3, completeness: 0.75, model_tier: 'local' },
  algo: { sig: 'ed25519', aead: 'aes-256-gcm', kex: 'x25519' },
} as const;

const validL1 = {
  nickname: '阿泽',
  gender: 'male',
  seeking: 'female',
  age_attested: true,
  age_band: '26_30',
  city: { code: '310100', name: '上海' },
  height_band: '171_175',
  marital_status: 'never_married',
  job_category: 'tech',
  education_band: 'bachelor',
  interests: ['outdoor', 'reading'],
  bio: '写代码也爬山',
  goal: 'marriage_oriented',
  econ_signal: ['undisclosed'],
} as const;

const validL2 = {
  values_tags: [{ tag: 'family_first', weight: 0.8 }],
  lifestyle: {
    sleep: 'normal',
    smoking: 'never',
    drinking: 'occasionally',
    exercise: 'regularly',
    social: 'medium',
  },
  family_view: {
    parents_relation: 'harmonious',
    childbearing: 'want',
    cohabit_with_parents: 'reluctant',
  },
  money_view: 'balanced',
  assets_brief: { house: 'not_yet', car: 'owned' },
  dealbreakers: [{ dimension: 'smoking', note: '完全不能接受' }],
  values_qa: [
    { question: '理想的一天？', answer: '早起爬山下午写代码' },
    { question: '钱为什么吵架？', answer: '提前说好大额支出' },
    { question: '家是什么？', answer: '可以说累的地方' },
  ],
  partner_pref: '情绪稳定，愿意沟通',
} as const;

const validEnvelope = {
  meta: validMeta,
  payload_L1: { nonce: 'AAAA', ct: 'BBBB' },
  payload_L2: { nonce: 'CCCC', ct: 'DDDD' },
  signature: 'c2ln',
};

describe('受控词表 v0.1', () => {
  it('词表规模符合"少而精"首发口径', () => {
    expect(INTERESTS).toHaveLength(12);
    expect(VALUES_TAGS).toHaveLength(8);
    expect(DEALBREAKER_DIMENSIONS).toHaveLength(8);
    expect(AGE_BANDS).toContain('unspecified');
    expect(ECON_SIGNALS).toContain('undisclosed');
  });

  it('协议常量：默认 TTL 30 天、完整性阈值 0.6', () => {
    expect(DEFAULT_TTL_DAYS).toBe(30);
    expect(COMPLETENESS_LOW_THRESHOLD).toBe(0.6);
  });
});

describe('canonical JSON 与 UUIDv7', () => {
  it('键递归排序，序列化无空白', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('数组保序、undefined 剔除', () => {
    expect(canonicalize({ x: [3, 1, 2], y: undefined })).toBe('{"x":[3,1,2]}');
  });

  it('UUIDv7：形态合法且含版本位 7', () => {
    const id = uuidV7();
    expect(isUuidV7(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(uuidV7()).not.toBe(id);
  });

  it('base64 长度指纹校验', () => {
    expect(isBase64OfLength(keyId, 32)).toBe(true);
    expect(isBase64OfLength('short', 32)).toBe(false);
  });
});

describe('三层 payload 字段规则', () => {
  it('L1 合法样例通过', () => {
    expect(PayloadL1.safeParse(validL1).success).toBe(true);
  });

  it('age_attested 必须为 true（未成年人保护法律要求，v0.3）', () => {
    const bad = { ...validL1, age_attested: false };
    expect(PayloadL1.safeParse(bad).success).toBe(false);
  });

  it('L1 缺 gender / seeking 不通过（v0.3 补：匹配最低必要字段）', () => {
    const { gender, ...noGender } = validL1;
    expect(PayloadL1.safeParse(noGender).success).toBe(false);
    const { seeking, ...noSeeking } = validL1;
    expect(PayloadL1.safeParse(noSeeking).success).toBe(false);
  });

  it('econ_signal 为生活状态多选，不收收入数字', () => {
    const multi = PayloadL1.safeParse({
      ...validL1,
      econ_signal: ['independent', 'home_owner_no_mortgage'],
    });
    expect(multi.success).toBe(true);
    expect(PayloadL1.safeParse({ ...validL1, econ_signal: ['income_50w'] }).success).toBe(false);
  });

  it('L2 合法样例通过；values_qa 3–5 段（报告原话证据源）', () => {
    expect(PayloadL2.safeParse(validL2).success).toBe(true);
    const two = { ...validL2, values_qa: validL2.values_qa.slice(0, 2) };
    expect(PayloadL2.safeParse(two).success).toBe(false);
  });

  it('L3 整体可缺省；contact_phone 等默认关（逐字段 opt-in）', () => {
    expect(PayloadL3.safeParse({}).success).toBe(true);
    expect(PayloadL3.safeParse({ contact_wechat: 'yuelao2026' }).success).toBe(true);
    expect(PayloadL3.safeParse({ photo_refs: [{ hash: 'a'.repeat(64), key: 'a2V5' }] }).success).toBe(
      true,
    );
    // 照片哈希必须是 64 位十六进制
    expect(PayloadL3.safeParse({ photo_refs: [{ hash: 'xyz', key: 'k' }] }).success).toBe(false);
  });

  it('深度标记：completeness 0–1，model_tier 不声明型号', () => {
    expect(CardMeta.safeParse({ ...validMeta, depth: { ...validMeta.depth, completeness: 1.5 } }).success).toBe(
      false,
    );
    expect(
      CardMeta.safeParse({ ...validMeta, depth: { ...validMeta.depth, model_tier: 'gpt-4o' } }).success,
    ).toBe(false);
  });
});

describe('信封校验与容错（Schema §7）', () => {
  it('完整信封通过', () => {
    const r = validateEnvelope(validEnvelope);
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it('未知字段一律忽略并告警（向前兼容，§7.2）', () => {
    const r = validateEnvelope({
      ...validEnvelope,
      payload_L1: { ...validEnvelope.payload_L1, future_field: 1 },
      future_top: 'x',
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
    expect(r.warnings.some((w) => w.includes('future_field'))).toBe(true);
  });

  it('owner_key_id 非 32 字节指纹拒绝', () => {
    const r = validateEnvelope({ ...validEnvelope, meta: { ...validMeta, owner_key_id: 'x' } });
    expect(r.ok).toBe(false);
  });

  it('card_id 非 UUIDv7 拒绝', () => {
    const r = validateEnvelope({ ...validEnvelope, meta: { ...validMeta, card_id: 'not-a-uuid' } });
    expect(r.ok).toBe(false);
  });

  it('TTL：未过期返回剩余毫秒，过期为负', () => {
    expect(ttlRemainingMs({ expires_at: '2099-01-01T00:00:00.000Z' })).toBeGreaterThan(0);
    expect(isExpired({ expires_at: '2020-01-01T00:00:00.000Z' })).toBe(true);
    expect(isExpired({ expires_at: '2099-01-01T00:00:00.000Z' })).toBe(false);
  });

  it('签名对象含 meta + 三层密文整体（L3 缺省时不含）', () => {
    const obj = signatureObject(validEnvelope) as Record<string, unknown>;
    expect(Object.keys(obj)).toEqual(['meta', 'payload_L1', 'payload_L2']);
    const withL3 = signatureObject({ ...validEnvelope, payload_L3: { nonce: 'E', ct: 'F' } });
    expect(Object.keys(withL3 as Record<string, unknown>)).toContain('payload_L3');
  });
});
