import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION, uuidV7 } from '@hongxian/schema';
import { ServerStore, cardFingerprintOf, hexOf } from '../src/store.js';
import type { MatchCardEnvelope, MsgEnvelope } from '@hongxian/schema';

function makeCard(overrides: { card_type?: 'match_card' | 'plaza_card'; key_l1?: string } = {}): MatchCardEnvelope {
  const now = Date.now();
  return {
    meta: {
      schema_version: SCHEMA_VERSION,
      card_id: uuidV7(),
      owner_key_id: Buffer.alloc(32, 1).toString('base64'),
      sig_public: Buffer.alloc(32, 2).toString('base64'),
      kx_public: Buffer.alloc(32, 3).toString('base64'),
      version: 1,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 30 * 86400_000).toISOString(),
      card_type: overrides.card_type ?? 'plaza_card',
      depth: { interview_rounds: 3, completeness: 0.75, model_tier: 'local' },
      algo: { sig: 'ed25519', aead: 'aes-256-gcm', kex: 'x25519' },
    },
    ...(overrides.key_l1 ? { key_l1: overrides.key_l1 } : {}),
    payload_L1: { nonce: 'AAAA', ct: 'BBBB' },
    payload_L2: { nonce: 'CCCC', ct: 'DDDD' },
    signature: 'c2ln',
  };
}

function makeEnv(): MsgEnvelope {
  const now = Date.now();
  return {
    meta: {
      schema_version: SCHEMA_VERSION,
      card_id: uuidV7(),
      owner_key_id: Buffer.alloc(32, 4).toString('base64'),
      sig_public: Buffer.alloc(32, 5).toString('base64'),
      kx_public: Buffer.alloc(32, 6).toString('base64'),
      version: 1,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 7 * 86400_000).toISOString(),
      card_type: 'match_card',
      msg_type: 'upgrade_request',
      depth: { interview_rounds: 3, completeness: 0.75, model_tier: 'local' },
      algo: { sig: 'ed25519', aead: 'aes-256-gcm', kex: 'x25519' },
    },
    payload: { nonce: '', ct: 'c2VhbGVk' },
    signature: 'c2ln',
  };
}

describe('ServerStore', () => {
  let dir: string;
  let store: ServerStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hx-srv-'));
    store = new ServerStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const opaque = Buffer.alloc(32, 9).toString('base64');

  it('身份建档 / 查询 / 不存在返回 null', () => {
    store.putIdentity({ opaque_id: opaque, sig_public: 's', kx_public: 'k', created_at: new Date().toISOString() });
    expect(store.getIdentity(opaque)?.opaque_id).toBe(opaque);
    expect(store.getIdentity(Buffer.alloc(32, 10).toString('base64'))).toBeNull();
  });

  it('一人一卡：重签覆盖', () => {
    store.putCard(opaque, { envelope: makeCard(), uploaded_at: new Date().toISOString() });
    const second = makeCard();
    store.putCard(opaque, { envelope: second, uploaded_at: new Date().toISOString() });
    const list = store.listCards(null, 100);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.envelope.meta.card_id).toBe(second.meta.card_id);
  });

  it('广场卡池分页（哑管道全量 + cursor）', () => {
    for (let i = 0; i < 5; i++) {
      store.putCard(Buffer.alloc(32, 20 + i).toString('base64'), {
        envelope: makeCard(),
        uploaded_at: new Date(Date.now() + i * 1000).toISOString(),
      });
    }
    const p1 = store.listCards(null, 2);
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = store.listCards(p1.next_cursor, 2);
    expect(p2.items).toHaveLength(2);
    const p3 = store.listCards(p2.next_cursor, 2);
    expect(p3.items).toHaveLength(1);
    expect(p3.next_cursor).toBeNull();
  });

  it('信箱投递 / 拉取 / 删除', () => {
    const env = makeEnv();
    const id = store.putEnvelope(opaque, { envelope: env, delivered_at: new Date().toISOString() });
    const page = store.listEnvelopes(opaque, null, 100);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.envelope.meta.card_id).toBe(id);
    expect(store.deleteEnvelope(opaque, id)).toBe(true);
    expect(store.listEnvelopes(opaque, null, 100).items).toHaveLength(0);
    expect(store.deleteEnvelope(opaque, id)).toBe(false);
  });

  it('限速计数按日累计', () => {
    expect(store.bumpDeliveryCount(opaque, '2026-10-19')).toBe(1);
    expect(store.bumpDeliveryCount(opaque, '2026-10-19')).toBe(2);
    expect(store.bumpDeliveryCount(opaque, '2026-10-20')).toBe(1);
  });

  it('TTL 清扫：过期卡与超期信被删', () => {
    const expiredCard = makeCard();
    expiredCard.meta.expires_at = new Date(Date.now() - 1000).toISOString();
    store.putCard(opaque, { envelope: expiredCard, uploaded_at: new Date().toISOString() });
    const oldEnv = makeEnv();
    store.putEnvelope(opaque, { envelope: oldEnv, delivered_at: new Date(Date.now() - 31 * 86400_000).toISOString() });
    const freshEnv = makeEnv();
    store.putEnvelope(opaque, { envelope: freshEnv, delivered_at: new Date().toISOString() });
    const r = store.sweepExpired();
    expect(r.cards).toBe(1);
    expect(r.envelopes).toBe(1);
    expect(store.listEnvelopes(opaque, null, 100).items).toHaveLength(1);
  });

  it('注销级联删除（身份+卡+信箱+限速）', () => {
    store.putIdentity({ opaque_id: opaque, sig_public: 's', kx_public: 'k', created_at: new Date().toISOString() });
    store.putCard(opaque, { envelope: makeCard(), uploaded_at: new Date().toISOString() });
    store.putEnvelope(opaque, { envelope: makeEnv(), delivered_at: new Date().toISOString() });
    store.bumpDeliveryCount(opaque, '2026-10-19');
    const removed = store.deleteIdentity(opaque);
    expect(removed).toBe(4); // 身份 + 卡 + 信 + 限速文件
    expect(store.getIdentity(opaque)).toBeNull();
    expect(store.listCards(null, 100).items).toHaveLength(0);
    expect(store.listEnvelopes(opaque, null, 100).items).toHaveLength(0);
  });

  it('按指纹找卡（纯哈希，服务端可重算）', () => {
    const card = makeCard();
    store.putCard(opaque, { envelope: card, uploaded_at: new Date().toISOString() });
    const fp = cardFingerprintOf(card);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(store.findCardByFingerprint(fp)?.envelope.meta.card_id).toBe(card.meta.card_id);
    expect(store.findCardByFingerprint('ffffffffffffffff')).toBeNull();
  });

  it('hexOf 目录安全化', () => {
    expect(hexOf(Buffer.alloc(32, 1).toString('base64'))).toMatch(/^[0-9a-f]{64}$/);
  });

  // 回归：默认 DATA_DIR='./data' 这类相对路径曾让 resolve() 的越界判定恒为真
  // （join('./data','x')='data/x' 不以 './data' 开头），所有写入都被误判为非法
  it('相对路径数据目录可正常读写（默认 ./data 场景）', () => {
    const rel = new ServerStore('data-rel-test');
    try {
      const opaque = Buffer.alloc(32, 9).toString('base64');
      rel.putCard(opaque, { envelope: makeCard(), uploaded_at: new Date().toISOString() });
      expect(rel.getCardByOwner(opaque)).not.toBeNull();
      expect(rel.listCards(null, 10).items).toHaveLength(1);
    } finally {
      rmSync(rel.root, { recursive: true, force: true });
    }
  });

  it('越界路径被拒（含 ../ 逃逸）', () => {
    const opaque = Buffer.alloc(32, 7).toString('base64');
    expect(store.deleteEnvelope(opaque, '../../secret')).toBe(false);
    expect(store.hasEnvelope(opaque, '../x')).toBe(false);
  });
});
