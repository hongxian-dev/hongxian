import { describe, expect, it } from 'vitest';
import {
  Address,
  GrantL1Body,
  MatchCardEnvelope,
  SCHEMA_VERSION,
  UpgradeRequestBody,
  formatAddress,
  isPlazaCard,
  parseAddress,
  validateEnvelope,
} from '../src/index.js';
import {
  MAILBOX_RETENTION_DAYS,
  MAX_DAILY_DELIVERIES,
  PLAZA_PAGE_SIZE,
} from '../src/vocab.js';

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

const baseEnvelope = {
  payload_L1: { nonce: 'AAAA', ct: 'BBBB' },
  payload_L2: { nonce: 'CCCC', ct: 'DDDD' },
  signature: 'c2ln',
};

describe('v0.4 · 广场卡零知识规则（工程设计 V6）', () => {
  it('plaza_card 携带 key_l1 → 拒收（服务端不得持可解密 L1 的材料）', () => {
    const r = validateEnvelope({
      ...baseEnvelope,
      meta: { ...baseMeta, card_type: 'plaza_card' },
      key_l1: 'a2V5',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('key_l1');
  });

  it('plaza_card 无 key_l1 → 接受', () => {
    const r = validateEnvelope({
      ...baseEnvelope,
      meta: { ...baseMeta, card_type: 'plaza_card' },
    });
    expect(r.ok).toBe(true);
    expect(r.data?.meta.card_type).toBe('plaza_card');
  });

  it('match_card（文件直交）无 key_l1 → 仍接受（v0.3 向前兼容，§7.2）', () => {
    const r = validateEnvelope({
      ...baseEnvelope,
      meta: { ...baseMeta, card_type: 'match_card' },
    });
    expect(r.ok).toBe(true);
  });

  it('match_card 携带 key_l1 → 接受（熟人链即到即解锁）', () => {
    const r = validateEnvelope({
      ...baseEnvelope,
      meta: { ...baseMeta, card_type: 'match_card' },
      key_l1: 'a2V5',
    });
    expect(r.ok).toBe(true);
  });

  it('isPlazaCard 按 card_type 判别', () => {
    expect(isPlazaCard({ meta: { card_type: 'plaza_card' } })).toBe(true);
    expect(isPlazaCard({ meta: { card_type: 'match_card' } })).toBe(false);
  });

  it('信封 schema 直接 parse 也执行该规则（绕过 validateEnvelope 亦然）', () => {
    const r = MatchCardEnvelope.safeParse({
      ...baseEnvelope,
      meta: { ...baseMeta, card_type: 'plaza_card' },
      key_l1: 'a2V5',
    });
    expect(r.success).toBe(false);
  });
});

describe('v0.4 · grant_l1 一阶解锁消息体', () => {
  const valid = {
    from_card_id: '019515f4-7d4e-7c3a-9b1d-2e8a6c0f1234',
    card_fingerprint: 'a1b2c3d4e5f6a7b8',
    sealed_key_l1: 'c2VhbGVk',
  };

  it('接受合法 grant_l1', () => {
    expect(GrantL1Body.safeParse(valid).success).toBe(true);
  });

  it('拒绝畸形 fingerprint（非 16 hex）', () => {
    expect(GrantL1Body.safeParse({ ...valid, card_fingerprint: 'xyz' }).success).toBe(false);
    expect(GrantL1Body.safeParse({ ...valid, card_fingerprint: 'a1b2c3d4e5f6a7b8c9' }).success).toBe(false);
  });

  it('拒绝空 sealed_key_l1', () => {
    expect(GrantL1Body.safeParse({ ...valid, sealed_key_l1: '' }).success).toBe(false);
  });
});

describe('v0.4 · upgrade_request 正式化', () => {
  const valid = {
    from_card_id: '019515f4-7d4e-7c3a-9b1d-2e8a6c0f1234',
    attach_card_ref: 'card.json',
    requester_kx_public: Buffer.alloc(32, 9).toString('base64'),
  };

  it('接受带 requester_kx_public 的请求', () => {
    expect(UpgradeRequestBody.safeParse(valid).success).toBe(true);
  });

  it('拒绝缺 requester_kx_public 的请求（广场流无法回送钥匙）', () => {
    expect(
      UpgradeRequestBody.safeParse({
        from_card_id: valid.from_card_id,
        attach_card_ref: valid.attach_card_ref,
      }).success,
    ).toBe(false);
  });

  it('拒绝错误长度的 requester_kx_public', () => {
    expect(UpgradeRequestBody.safeParse({ ...valid, requester_kx_public: 'c2hvcnQ=' }).success).toBe(false);
  });
});

describe('v0.4 · 寻址 Address（工程设计 V8）', () => {
  const opaque = Buffer.alloc(32, 3).toString('base64');

  it('format/parse 往返（带实例域名）', () => {
    const addr = { opaque_id: opaque, instance: 'plaza.hongxian.dev' };
    const s = formatAddress(addr);
    expect(s).toBe(`${opaque}@plaza.hongxian.dev`);
    expect(parseAddress(s)).toEqual(addr);
  });

  it('format/parse 往返（无实例域名 = 本实例）', () => {
    const addr = { opaque_id: opaque };
    expect(formatAddress(addr)).toBe(opaque);
    expect(parseAddress(opaque)).toEqual(addr);
  });

  it('拒绝畸形输入', () => {
    expect(parseAddress('')).toBeNull();
    expect(parseAddress('not-base64!!')).toBeNull();
    expect(parseAddress(`${opaque}@bad domain`)).toBeNull();
    expect(parseAddress(`${opaque}@a@b`)).toBeNull();
  });

  it('Address schema 拒绝错误长度的 opaque_id', () => {
    expect(Address.safeParse({ opaque_id: 'c2hvcnQ=' }).success).toBe(false);
  });
});

describe('v0.4 · 平台服务常量', () => {
  it('信箱/限速/分页常量就位', () => {
    expect(MAILBOX_RETENTION_DAYS).toBe(30);
    expect(MAX_DAILY_DELIVERIES).toBe(20);
    expect(PLAZA_PAGE_SIZE).toBe(100);
  });
});
