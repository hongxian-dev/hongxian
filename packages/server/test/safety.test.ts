/**
 * 三条防护（C2）服务端侧测试
 *
 * 覆盖《三条防护话术定稿》v0.9 里服务端能守的部分：
 *   防护二 · 举报即断 —— 行为规格 §3.1 三条 + 验收判据 §3.5 五条
 *   防护三 · 披露声明 —— §4.1「官网/服务端可读全文」+ §4.5 第 3 条（版本可追溯）
 *
 * 防护一（风险提示）是纯客户端行为，测在 packages/mcp/test/safety-ack.test.ts。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import {
  PUBLISH_DISCLOSURE_BRIEF,
  PUBLISH_DISCLOSURE_TEXT,
  PUBLISH_DISCLOSURE_VERSION,
  SCHEMA_VERSION,
  canonicalBytes,
  fromBase64,
  toBase64,
  uuidV7,
  type MatchCardEnvelope,
  type MsgEnvelope,
} from '@hongxian/schema';
import { createApp, type PublishConfig } from '../src/app.js';
import { ServerStore } from '../src/store.js';
import { AUTH_HEADER, buildAuthHeader } from '../src/auth.js';
import type { Mailer } from '../src/mailer.js';

// ---------- 助手（与 api.test.ts 同构，故意重复以便单文件可读） ----------

interface TestKey {
  pubB64: string;
  sign: (msg: Uint8Array) => Uint8Array;
}

function genKey(): TestKey {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  return { pubB64: toBase64(pub), sign: (m: Uint8Array) => ed25519.sign(m, priv) };
}

function keyIdOf(pubB64: string): string {
  return toBase64(sha256(fromBase64(pubB64)));
}

const opaqueOf = (k: TestKey) => keyIdOf(k.pubB64);

function signedCard(signer: TestKey): MatchCardEnvelope {
  const now = Date.now();
  const meta = {
    schema_version: SCHEMA_VERSION,
    card_id: uuidV7(),
    owner_key_id: keyIdOf(signer.pubB64),
    sig_public: signer.pubB64,
    kx_public: genKey().pubB64,
    version: 1,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 30 * 86400_000).toISOString(),
    card_type: 'plaza_card' as const,
    depth: { interview_rounds: 3, completeness: 0.75, model_tier: 'local' as const },
    algo: { sig: 'ed25519' as const, aead: 'aes-256-gcm' as const, kex: 'x25519' as const },
  };
  const body = { meta, payload_L1: { nonce: 'AAAA', ct: 'BBBB' }, payload_L2: { nonce: 'CCCC', ct: 'DDDD' } };
  return { ...body, signature: toBase64(signer.sign(canonicalBytes(body))) };
}

function signedMsg(signer: TestKey): MsgEnvelope {
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
    target_card_id: uuidV7(),
    depth: { interview_rounds: 3, completeness: 0.75, model_tier: 'local' as const },
    algo: { sig: 'ed25519' as const, aead: 'aes-256-gcm' as const, kex: 'x25519' as const },
  };
  const payload = { nonce: '', ct: 'c2VhbGVk' };
  return { meta, payload, signature: toBase64(signer.sign(canonicalBytes({ meta, payload }))) };
}

const enc = encodeURIComponent;

// ---------- 测试体 ----------

describe('防护二 · 举报即断', () => {
  let dir: string;
  let store: ServerStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hx-block-'));
    store = new ServerStore(dir);
    app = createApp(store, { instance: 'test.instance' });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function register(key: TestKey) {
    const res = await app.request('/v2/identity/register', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [AUTH_HEADER]: buildAuthHeader(opaqueOf(key), 'POST /v2/identity/register', key.sign),
      },
      body: JSON.stringify({ opaque_id: opaqueOf(key), sig_public: key.pubB64, kx_public: genKey().pubB64 }),
    });
    expect(res.status).toBe(201);
  }

  function deliver(sender: TestKey, recipientId: string, env = signedMsg(sender)) {
    return app.request(`/v2/mailbox/${enc(recipientId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(env),
    });
  }

  function report(reporter: TestKey, targetId: string, reason = 'fraud_suspicion') {
    return app.request('/v2/reports', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [AUTH_HEADER]: buildAuthHeader(opaqueOf(reporter), 'POST /v2/reports', reporter.sign),
      },
      body: JSON.stringify({ target_opaque_id: targetId, reason_code: reason }),
    });
  }

  function pull(owner: TestKey) {
    return app.request(`/v2/mailbox/${enc(opaqueOf(owner))}`, {
      headers: {
        [AUTH_HEADER]: buildAuthHeader(
          opaqueOf(owner),
          `GET /v2/mailbox/${opaqueOf(owner)}`,
          owner.sign,
        ),
      },
    });
  }

  it('举报后对方投递 → 信道已断（举报者信箱里收不到）', async () => {
    const alice = genKey();
    const bob = genKey();
    await register(alice);
    await register(bob);

    expect((await report(alice, opaqueOf(bob))).status).toBe(201);
    expect((await deliver(bob, opaqueOf(alice))).status).toBe(201);

    const items = ((await (await pull(alice)).json()) as { items: unknown[] }).items;
    expect(items).toHaveLength(0);
  });

  it('响应与正常投递逐字段一致（对发件人完全不可见，否则等于告诉骗子谁举报了他）', async () => {
    const alice = genKey();
    const bob = genKey();
    const carol = genKey();
    for (const k of [alice, bob, carol]) await register(k);

    // 正常投递
    const normalEnv = signedMsg(carol);
    const normal = await deliver(carol, opaqueOf(alice), normalEnv);
    // 阻断后的投递
    await report(alice, opaqueOf(bob));
    const blockedEnv = signedMsg(bob);
    const blocked = await deliver(bob, opaqueOf(alice), blockedEnv);

    expect(blocked.status).toBe(normal.status);
    const nBody = (await normal.json()) as Record<string, unknown>;
    const bBody = (await blocked.json()) as Record<string, unknown>;
    expect(Object.keys(bBody).sort()).toEqual(Object.keys(nBody).sort());
    expect(bBody.entered_mailbox).toBe(nBody.entered_mailbox);
    // id 都是自己的 card_id——形状与语义完全一致
    expect(bBody.id).toBe(blockedEnv.meta.card_id);
    expect(nBody.id).toBe(normalEnv.meta.card_id);
  });

  it('双向闭合：举报者也投不到被举报者（单向会成为"举报了还能试探"的漏洞）', async () => {
    const alice = genKey();
    const bob = genKey();
    await register(alice);
    await register(bob);
    await report(alice, opaqueOf(bob));

    expect((await deliver(alice, opaqueOf(bob))).status).toBe(201);
    const items = ((await (await pull(bob)).json()) as { items: unknown[] }).items;
    expect(items).toHaveLength(0);
  });

  it('不通知被举报者：他自己的信箱里没有任何"你被举报了"的信', async () => {
    const alice = genKey();
    const bob = genKey();
    await register(alice);
    await register(bob);
    await report(alice, opaqueOf(bob));

    const items = ((await (await pull(bob)).json()) as { items: unknown[] }).items;
    expect(items).toHaveLength(0);
    // 汇总仍然只有本人能查，且只有数字（不含举报人任何信息）
    const mine = await app.request(`/v2/reports/${enc(opaqueOf(bob))}`, {
      headers: {
        [AUTH_HEADER]: buildAuthHeader(opaqueOf(bob), `GET /v2/reports/${opaqueOf(bob)}`, bob.sign),
      },
    });
    const summary = ((await mine.json()) as { summary: Record<string, unknown> }).summary;
    expect(summary.reports).toBe(1);
    expect(JSON.stringify(summary)).not.toContain(opaqueOf(alice));
  });

  it('不做裁决：不过阈值就不摘卡，卡仍在广场列表里', async () => {
    const alice = genKey();
    const bob = genKey();
    await register(alice);
    await register(bob);
    await app.request('/v2/cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signedCard(bob)),
    });
    await report(alice, opaqueOf(bob));

    const page = (await (await app.request('/v2/cards')).json()) as { items: { meta: { owner_key_id: string } }[] };
    expect(page.items.map((c) => c.meta.owner_key_id)).toContain(opaqueOf(bob));
  });

  it('数据面不留「谁断了谁」的明表（拖走目录也还原不出关系）', async () => {
    const alice = genKey();
    const bob = genKey();
    await register(alice);
    await register(bob);
    await report(alice, opaqueOf(bob));

    const files = readdirSync(join(dir, 'blocks'));
    expect(files.length).toBe(2); // 双向两条
    for (const f of files) {
      const raw = readFileSync(join(dir, 'blocks', f), 'utf-8');
      // 阻断记录里不得出现对方的 opaque_id（两个方向都要查）
      expect(raw).not.toContain(opaqueOf(alice));
      expect(raw).not.toContain(opaqueOf(bob));
      expect(raw).toMatch(/"tag":"[0-9a-f]{32}"/);
    }
  });

  it('幂等：同一对重复举报不会把阻断记录刷成一串', async () => {
    const alice = genKey();
    const bob = genKey();
    await register(alice);
    await register(bob);
    await report(alice, opaqueOf(bob));
    await report(alice, opaqueOf(bob), 'harassment');

    expect(store.blockCount(opaqueOf(alice))).toBe(1);
    expect(store.blockCount(opaqueOf(bob))).toBe(1);
    expect(store.getReportSummary(opaqueOf(bob)).reports).toBe(1);
  });

  it('注销时阻断记录一并清掉', async () => {
    const alice = genKey();
    const bob = genKey();
    await register(alice);
    await register(bob);
    await report(alice, opaqueOf(bob));
    expect(store.blockCount(opaqueOf(alice))).toBe(1);

    expect(store.deleteIdentity(opaqueOf(alice))).toBeGreaterThan(0);
    expect(store.blockCount(opaqueOf(alice))).toBe(0);
  });
});

describe('防护三 · 贴卡前披露声明', () => {
  let dir: string;
  let store: ServerStore;
  let app: ReturnType<typeof createApp>;
  const EMAIL = 'alice.wang@example.com';
  const nonce = randomBytes(16).toString('base64url');
  const sent: { to: string; code: string }[] = [];

  const mailer: Mailer = {
    kind: 'fake',
    async sendPublishCode(to: string, code: string) {
      sent.push({ to, code });
      return { ok: true };
    },
  };

  function build(publish: PublishConfig | undefined) {
    app = createApp(store, { instance: 'test.instance', publish });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hx-disclosure-'));
    store = new ServerStore(dir);
    sent.length = 0;
    build({ required: true, mailer, verifyBase: 'https://hongxian.dev/publish-verify/' });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function register(key: TestKey) {
    const res = await app.request('/v2/identity/register', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [AUTH_HEADER]: buildAuthHeader(opaqueOf(key), 'POST /v2/identity/register', key.sign),
      },
      body: JSON.stringify({ opaque_id: opaqueOf(key), sig_public: key.pubB64, kx_public: genKey().pubB64 }),
    });
    expect(res.status).toBe(201);
  }

  it('公开可读：无需认证、无需安装工具，就能拿到全文与版本号', async () => {
    const res = await app.request('/v2/publish/disclosure');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.version).toBe(PUBLISH_DISCLOSURE_VERSION);
    expect(body.full).toBe(PUBLISH_DISCLOSURE_TEXT);
    expect(body.brief).toBe(PUBLISH_DISCLOSURE_BRIEF);
    expect(body.require_ack).toBe(true);
    expect(String(body.ack_label)).toContain('邮箱哈希');
  });

  it('声明正文守住三条写作约束：不承诺绝对、不写实名、给出不贴广场的路', async () => {
    const body = (await (await app.request('/v2/publish/disclosure')).json()) as { full: string };
    expect(body.full).toContain('边界在哪');
    expect(body.full).toContain('不是"绝对不可能"');
    expect(body.full).not.toContain('实名认证');
    expect(body.full).toContain('只在认识的人之间换卡');
    expect(body.full).toContain('不验证你是谁');
  });

  it('认领凭据时记录 people 看过的声明版本（事后可追溯，不只是本地记录）', async () => {
    const key = genKey();
    await register(key);

    const otp = await app.request('/v2/publish/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, carrier: EMAIL }),
    });
    expect(otp.status).toBe(201);
    const code = sent[sent.length - 1]!.code;
    const v = await app.request('/v2/publish/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, code }),
    });
    expect(v.status).toBe(200);
    const permit = ((await v.json()) as { permit: string }).permit;

    const put = await app.request('/v2/publish/credential', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        [AUTH_HEADER]: buildAuthHeader(opaqueOf(key), 'PUT /v2/publish/credential', key.sign),
      },
      body: JSON.stringify({ nonce, permit, disclosure_version: PUBLISH_DISCLOSURE_VERSION }),
    });
    expect(put.status).toBe(201);

    const got = await app.request('/v2/publish/credential', {
      headers: {
        [AUTH_HEADER]: buildAuthHeader(opaqueOf(key), 'GET /v2/publish/credential', key.sign),
      },
    });
    const body = (await got.json()) as Record<string, unknown>;
    expect(body.verified).toBe(true);
    expect(body.disclosure_version).toBe(PUBLISH_DISCLOSURE_VERSION);
    expect(body.current_disclosure_version).toBe(PUBLISH_DISCLOSURE_VERSION);
    // 仍然不回答"用哪个邮箱"——服务端自己也不留那个明文
    expect(JSON.stringify(body)).not.toContain(EMAIL);
  });
});
