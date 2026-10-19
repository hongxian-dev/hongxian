import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import {
  MAX_DAILY_DELIVERIES,
  SCHEMA_VERSION,
  canonicalBytes,
  fromBase64,
  toBase64,
  uuidV7,
  type MatchCardEnvelope,
  type MsgEnvelope,
} from '@hongxian/schema';
import { createApp } from '../src/app.js';
import { ServerStore, cardFingerprintOf } from '../src/store.js';
import { AUTH_HEADER, buildAuthHeader } from '../src/auth.js';

// ---------- 测试助手：真实密钥与签名 ----------

interface TestKey {
  priv: Uint8Array;
  pub: Uint8Array;
  pubB64: string;
  sign: (msg: Uint8Array) => Uint8Array;
}

function genKey(): TestKey {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  return {
    priv,
    pub,
    pubB64: toBase64(pub),
    sign: (msg: Uint8Array) => ed25519.sign(msg, priv),
  };
}

/** owner_key_id / opaque_id = SHA-256(公钥) 指纹（协议 §2/§7 口径） */
function keyIdOf(pubB64: string): string {
  return toBase64(sha256(fromBase64(pubB64)));
}

function signedCard(
  signer: TestKey,
  opts: { card_type?: 'match_card' | 'plaza_card'; key_l1?: string; ttlDays?: number } = {},
): MatchCardEnvelope {
  const now = Date.now();
  const meta = {
    schema_version: SCHEMA_VERSION,
    card_id: uuidV7(),
    owner_key_id: keyIdOf(signer.pubB64),
    sig_public: signer.pubB64,
    kx_public: genKey().pubB64,
    version: 1,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + (opts.ttlDays ?? 30) * 86400_000).toISOString(),
    card_type: opts.card_type ?? 'plaza_card',
    depth: { interview_rounds: 3, completeness: 0.75, model_tier: 'local' as const },
    algo: { sig: 'ed25519' as const, aead: 'aes-256-gcm' as const, kex: 'x25519' as const },
  };
  const body = {
    meta,
    ...(opts.key_l1 ? { key_l1: opts.key_l1 } : {}),
    payload_L1: { nonce: 'AAAA', ct: 'BBBB' },
    payload_L2: { nonce: 'CCCC', ct: 'DDDD' },
  };
  const signature = toBase64(signer.sign(canonicalBytes(body)));
  return { ...body, signature };
}

function signedMsg(signer: TestKey, targetCardId: string): MsgEnvelope {
  const now = Date.now();
  const meta = {
    schema_version: SCHEMA_VERSION,
    card_id: uuidV7(),
    owner_key_id: keyIdOf(signer.pubB64),
    sig_public: signer.pubB64,
    kx_public: genKey().pubB64,
    version: 1,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 7 * 86400_000).toISOString(),
    card_type: 'match_card' as const,
    msg_type: 'upgrade_request' as const,
    target_card_id: targetCardId,
    depth: { interview_rounds: 3, completeness: 0.75, model_tier: 'local' as const },
    algo: { sig: 'ed25519' as const, aead: 'aes-256-gcm' as const, kex: 'x25519' as const },
  };
  const payload = { nonce: '', ct: 'c2VhbGVk' };
  const signature = toBase64(signer.sign(canonicalBytes({ meta, payload })));
  return { meta, payload, signature };
}

function opaqueOf(key: TestKey): string {
  return keyIdOf(key.pubB64); // 协议 §7：opaque_id = 签名公钥指纹
}

/**
 * URL 路径必须百分号编码（base64 含 + / =，会破坏路径段）——协议 §7 编码规则。
 * 注意：认证 action 字符串用**未编码**地址（服务端从解码后的 param 重建 action）。
 */
const enc = encodeURIComponent;

async function register(app: ReturnType<typeof createApp>, key: TestKey): Promise<Response> {
  return app.request('/v2/identity/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [AUTH_HEADER]: buildAuthHeader(opaqueOf(key), 'POST /v2/identity/register', key.sign),
    },
    body: JSON.stringify({ opaque_id: opaqueOf(key), sig_public: key.pubB64, kx_public: genKey().pubB64 }),
  });
}

// ---------- 测试体 ----------

describe('平台服务 API v1', () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hx-api-'));
    app = createApp(new ServerStore(dir), { instance: 'test.instance' });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('healthz 无追踪无计数', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  describe('身份注册（持钥证明）', () => {
    it('正确签名 → 201；重复注册 → 409；错误签名 → 401', async () => {
      const key = genKey();
      const first = await register(app, key);
      expect(first.status).toBe(201);
      const dup = await register(app, key);
      expect(dup.status).toBe(409);
      const other = genKey();
      const bad = await app.request('/v2/identity/register', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [AUTH_HEADER]: buildAuthHeader(opaqueOf(key), 'POST /v2/identity/register', other.sign),
        },
        body: JSON.stringify({ opaque_id: opaqueOf(key), sig_public: key.pubB64, kx_public: 'k' }),
      });
      expect(bad.status).toBe(401);
    });

    it('存在性查询 200/404', async () => {
      const key = genKey();
      await register(app, key);
      const ok = await app.request(`/v2/identity/${enc(opaqueOf(key))}`);
      expect(ok.status).toBe(200);
      const missing = await app.request(`/v2/identity/${enc(opaqueOf(genKey()))}`);
      expect(missing.status).toBe(404);
    });

    it('opaque_id 与 sig_public 指纹不匹配 → 400（协议 §7 绑定）', async () => {
      const key = genKey();
      const res = await app.request('/v2/identity/register', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [AUTH_HEADER]: buildAuthHeader('bogus-opaque', 'POST /v2/identity/register', key.sign),
        },
        body: JSON.stringify({ opaque_id: 'bogus-opaque', sig_public: key.pubB64, kx_public: 'k' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('广场（哑管道 + §10.5 零知识硬规则）', () => {
    it('签名 plaza_card 上传 → 201；拉取池中原样返回且无 key_l1', async () => {
      const key = genKey();
      await register(app, key);
      const card = signedCard(key);
      const up = await app.request('/v2/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(card) });
      expect(up.status).toBe(201);
      const pool = await app.request('/v2/cards');
      const items = ((await pool.json()) as { items: MatchCardEnvelope[] }).items;
      expect(items).toHaveLength(1);
      expect(items[0]!.key_l1).toBeUndefined();
      expect(items[0]!.meta.card_id).toBe(card.meta.card_id);
    });

    it('match_card 变体 → 400（文件直交不经服务端）', async () => {
      const key = genKey();
      await register(app, key);
      const card = signedCard(key, { card_type: 'match_card' });
      const res = await app.request('/v2/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(card) });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('plaza_card');
    });

    it('plaza_card 携 key_l1 → 400（§10.5 schema 层拒收）', async () => {
      const key = genKey();
      await register(app, key);
      const card = signedCard(key, { key_l1: 'a2V5' });
      const res = await app.request('/v2/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(card) });
      expect(res.status).toBe(400);
    });

    it('篡改卡片 → 400（验签失败）', async () => {
      const key = genKey();
      await register(app, key);
      const card = signedCard(key);
      (card.meta as { depth: { completeness: number } }).depth.completeness = 0.99;
      const res = await app.request('/v2/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(card) });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('验签');
    });

    it('未注册身份贴卡 → 409；TTL 超上限 → 400', async () => {
      const stranger = genKey();
      const res1 = await app.request('/v2/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedCard(stranger)) });
      expect(res1.status).toBe(409);
      const key = genKey();
      await register(app, key);
      const long = signedCard(key, { ttlDays: 200 });
      const res2 = await app.request('/v2/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(long) });
      expect(res2.status).toBe(400);
    });

    it('撤卡：非持钥人 → 401；持钥人 → 200；重复撤 → 404', async () => {
      const owner = genKey();
      await register(app, owner);
      const card = signedCard(owner);
      await app.request('/v2/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(card) });
      const fp = cardFingerprintOf(card);
      // 非持钥人（用另一把钥匙签认证头）——对不上登记的 sig_public
      const attacker = genKey();
      const bad = await app.request(`/v2/cards/${fp}`, {
        method: 'DELETE',
        headers: { [AUTH_HEADER]: buildAuthHeader(opaqueOf(owner), `DELETE /v2/cards/${fp}`, attacker.sign) },
      });
      expect(bad.status).toBe(401);
      const ok = await app.request(`/v2/cards/${fp}`, {
        method: 'DELETE',
        headers: { [AUTH_HEADER]: buildAuthHeader(opaqueOf(owner), `DELETE /v2/cards/${fp}`, owner.sign) },
      });
      expect(ok.status).toBe(200);
      const again = await app.request(`/v2/cards/${fp}`, {
        method: 'DELETE',
        headers: { [AUTH_HEADER]: buildAuthHeader(opaqueOf(owner), `DELETE /v2/cards/${fp}`, owner.sign) },
      });
      expect(again.status).toBe(404);
    });
  });

  describe('信箱（定向 + 限速 + 拉取认证）', () => {
    it('全流程：投递 → 拉取 → 删信；无认证拉取 → 401；错签名拉取 → 401', async () => {
      const alice = genKey();
      const bob = genKey();
      await register(app, alice);
      await register(app, bob);
      const bobCard = signedCard(bob);
      const env = signedMsg(alice, bobCard.meta.card_id);

      const deliver = await app.request(`/v2/mailbox/${enc(opaqueOf(bob))}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(env),
      });
      expect(deliver.status).toBe(201);
      expect((await deliver.json()).entered_mailbox).toBe(true);

      const noAuth = await app.request(`/v2/mailbox/${enc(opaqueOf(bob))}`);
      expect(noAuth.status).toBe(401);

      // 用 bob 的钥匙为"拉 alice 信箱"签名——对不上 alice 登记的 sig_public
      const wrongSigner = await app.request(`/v2/mailbox/${enc(opaqueOf(alice))}`, {
        headers: { [AUTH_HEADER]: buildAuthHeader(opaqueOf(bob), `GET /v2/mailbox/${opaqueOf(alice)}`, bob.sign) },
      });
      expect(wrongSigner.status).toBe(401);

      const pull = await app.request(`/v2/mailbox/${enc(opaqueOf(bob))}`, {
        headers: { [AUTH_HEADER]: buildAuthHeader(opaqueOf(bob), `GET /v2/mailbox/${opaqueOf(bob)}`, bob.sign) },
      });
      expect(pull.status).toBe(200);
      const items = ((await pull.json()) as { items: MsgEnvelope[] }).items;
      expect(items).toHaveLength(1);
      const del = await app.request(`/v2/mailbox/${enc(opaqueOf(bob))}/${items[0]!.meta.card_id}`, {
        method: 'DELETE',
        headers: { [AUTH_HEADER]: buildAuthHeader(opaqueOf(bob), `DELETE /v2/mailbox/${opaqueOf(bob)}/${items[0]!.meta.card_id}`, bob.sign) },
      });
      expect(del.status).toBe(200);
    });

    it('未注册收件人 → 404；跨实例地址 → 400', async () => {
      const alice = genKey();
      await register(app, alice);
      const env = signedMsg(alice, uuidV7());
      const toStranger = await app.request(`/v2/mailbox/${enc(opaqueOf(genKey()))}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(env),
      });
      expect(toStranger.status).toBe(404);
      const bob = genKey();
      await register(app, bob);
      const cross = await app.request(`/v2/mailbox/${enc(opaqueOf(bob))}@other.instance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(env),
      });
      expect(cross.status).toBe(400);
    });

    it(`限速：第 ${MAX_DAILY_DELIVERIES + 1} 封 → 429`, async () => {
      const alice = genKey();
      const bob = genKey();
      await register(app, alice);
      await register(app, bob);
      let last: Response | null = null;
      for (let i = 0; i <= MAX_DAILY_DELIVERIES; i++) {
        last = await app.request(`/v2/mailbox/${enc(opaqueOf(bob))}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(signedMsg(alice, uuidV7())),
        });
      }
      expect(last!.status).toBe(429);
    });

    it('注销：级联清空（信箱+卡+身份）', async () => {
      const key = genKey();
      await register(app, key);
      const card = signedCard(key);
      await app.request('/v2/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(card) });
      const res = await app.request('/v2/identity', {
        method: 'DELETE',
        headers: { [AUTH_HEADER]: buildAuthHeader(opaqueOf(key), 'DELETE /v2/identity', key.sign) },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).removed).toBe(2);
      const pool = await app.request('/v2/cards');
      expect(((await pool.json()) as { items: unknown[] }).items).toHaveLength(0);
    });
  });
});
