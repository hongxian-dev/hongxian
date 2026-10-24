/**
 * 发布许可（C17 / D1 方案 B）服务端全链路测试
 *
 * 这一组断言对应验收方案新增的 TC-28 / TC-29 / TC-30：
 *   TC-28 未验证贴卡 → 403 + 可读指引 + 不泄露内部状态
 *   TC-29 验证后贴卡成功；解绑后再次贴卡 → 403
 *   TC-30 载体指纹不可逆查：库里只有哈希，无明文、无日志残留
 *
 * 另外守住《实名制处理口径决策备忘》§4.1 的四条硬约束中服务端能守的三条：
 * 不进登录链路（没有任何"用邮箱登录/找回"的入口）、不存明文、只拦贴卡。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import {
  PUBLISH_MAX_ATTEMPTS,
  SCHEMA_VERSION,
  canonicalBytes,
  fromBase64,
  toBase64,
  uuidV7,
  type MatchCardEnvelope,
} from '@hongxian/schema';
import { createApp, type PublishConfig } from '../src/app.js';
import { ServerStore } from '../src/store.js';
import { AUTH_HEADER, buildAuthHeader } from '../src/auth.js';
import type { Mailer } from '../src/mailer.js';

// ---------- 助手 ----------

interface TestKey {
  pubB64: string;
  sign: (msg: Uint8Array) => Uint8Array;
}

function realKey(): TestKey & { opaque: string } {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  const pubB64 = toBase64(pub);
  return {
    pubB64,
    sign: (m: Uint8Array) => ed25519.sign(m, priv),
    opaque: toBase64(sha256(pub)),
  };
}

interface FakeMailer extends Mailer {
  sent: { to: string; code: string }[];
}

function fakeMailer(opts: { fail?: boolean } = {}): FakeMailer {
  const sent: { to: string; code: string }[] = [];
  return {
    sent,
    kind: 'fake',
    async sendPublishCode(to: string, code: string) {
      if (opts.fail) return { ok: false, error: '发信服务返回 HTTP 500' };
      sent.push({ to, code });
      return { ok: true };
    },
  };
}

function signedPlazaCard(key: TestKey): MatchCardEnvelope {
  const now = Date.now();
  const meta = {
    schema_version: SCHEMA_VERSION,
    card_id: uuidV7(),
    owner_key_id: toBase64(sha256(fromBase64(key.pubB64))),
    sig_public: key.pubB64,
    kx_public: toBase64(ed25519.getPublicKey(ed25519.utils.randomPrivateKey())),
    version: 1,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 30 * 86400_000).toISOString(),
    card_type: 'plaza_card' as const,
    depth: { interview_rounds: 3, completeness: 0.75, model_tier: 'local' as const },
    algo: { sig: 'ed25519' as const, aead: 'aes-256-gcm' as const, kex: 'x25519' as const },
  };
  const body = { meta, payload_L1: { nonce: 'AAAA', ct: 'BBBB' }, payload_L2: { nonce: 'CCCC', ct: 'DDDD' } };
  return { ...body, signature: toBase64(key.sign(canonicalBytes(body))) };
}

const newNonce = () => randomBytes(16).toString('base64url');
const enc = encodeURIComponent;

// ---------- 测试体 ----------

describe('发布许可（服务端）', () => {
  let dir: string;
  let store: ServerStore;
  let mailer: FakeMailer;
  let app: ReturnType<typeof createApp>;

  const EMAIL = 'alice.wang@example.com';

  function build(publish: PublishConfig | undefined) {
    app = createApp(store, { instance: 'test.instance', publish });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hx-publish-'));
    store = new ServerStore(dir);
    mailer = fakeMailer();
    build({ required: true, mailer, verifyBase: 'https://hongxian.dev/publish-verify/' });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function register(key: TestKey & { opaque: string }) {
    const res = await app.request('/v2/identity/register', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [AUTH_HEADER]: buildAuthHeader(key.opaque, 'POST /v2/identity/register', key.sign),
      },
      body: JSON.stringify({
        opaque_id: key.opaque,
        sig_public: key.pubB64,
        kx_public: toBase64(ed25519.getPublicKey(ed25519.utils.randomPrivateKey())),
      }),
    });
    expect(res.status).toBe(201);
  }

  async function postCard(key: TestKey) {
    return app.request('/v2/cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signedPlazaCard(key)),
    });
  }

  /** 完整走一遍：发码 → 收码 → 验证 → 拿许可码 */
  async function verifyCarrier(nonce: string, email = EMAIL): Promise<string> {
    const otp = await app.request('/v2/publish/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, carrier: email }),
    });
    expect(otp.status, JSON.stringify(await otp.clone().json())).toBe(201);
    const code = mailer.sent[mailer.sent.length - 1]!.code;
    const v = await app.request('/v2/publish/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, code }),
    });
    expect(v.status).toBe(200);
    return ((await v.json()) as { permit: string }).permit;
  }

  function putCredential(key: TestKey & { opaque: string }, nonce: string, permit: string) {
    return app.request('/v2/publish/credential', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        [AUTH_HEADER]: buildAuthHeader(key.opaque, 'PUT /v2/publish/credential', key.sign),
      },
      body: JSON.stringify({ nonce, permit }),
    });
  }

  // ---------- TC-28：未验证不得贴卡 ----------

  it('TC-28 未验证贴卡 → 403，给出可执行的四步路径，且不泄露内部状态', async () => {
    const key = realKey();
    await register(key);
    const res = await postCard(key);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('publish_requires_verification');
    expect(Array.isArray(body.how)).toBe(true);
    expect((body.how as string[]).length).toBe(4);
    // 必须明确说出"不验证也完全没关系"——这不是实名认证，藏着不说就是骗人
    expect(String(body.still_works)).toContain('点对点投递');
    // 不得泄露内部状态：不能出现邮箱、不能出现"已绑谁"、不能出现具体天数
    const text = JSON.stringify(body);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toMatch(/carrier_hmac|opaque_id|\d+\s*天/);
  });

  it('TC-28 反向：required=false 的实例（自托管私有）照旧可直接贴卡', async () => {
    build(undefined);
    const key = realKey();
    await register(key);
    expect((await postCard(key)).status).toBe(201);
  });

  it('要求验证却没配发信通道 → 503 并明说这是运营方配置错误', async () => {
    build({ required: true, mailer: null });
    const key = realKey();
    await register(key);
    const res = await postCard(key);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('publish_verification_unavailable');
    expect(body.error).toContain('配置错误');
  });

  // ---------- TC-29：验证 → 贴卡 → 解绑 → 再贴卡被拒 ----------

  it('TC-29 验证后贴卡成功；解绑后再次贴卡 → 403', async () => {
    const key = realKey();
    await register(key);

    const nonce = newNonce();
    const permit = await verifyCarrier(nonce);
    const put = await putCredential(key, nonce, permit);
    expect(put.status, JSON.stringify(await put.clone().json())).toBe(201);
    expect(((await put.json()) as { verified: boolean }).verified).toBe(true);

    expect((await postCard(key)).status).toBe(201);

    const del = await app.request('/v2/publish/credential', {
      method: 'DELETE',
      headers: { [AUTH_HEADER]: buildAuthHeader(key.opaque, 'DELETE /v2/publish/credential', key.sign) },
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { unbound: boolean }).unbound).toBe(true);

    expect((await postCard(key)).status).toBe(403);
  });

  it('查询许可只回答"有没有"，不回答"用哪个邮箱"', async () => {
    const key = realKey();
    await register(key);
    const before = await app.request('/v2/publish/credential', {
      headers: { [AUTH_HEADER]: buildAuthHeader(key.opaque, 'GET /v2/publish/credential', key.sign) },
    });
    expect(((await before.json()) as { verified: boolean }).verified).toBe(false);

    const nonce = newNonce();
    await putCredential(key, nonce, await verifyCarrier(nonce));
    const after = await app.request('/v2/publish/credential', {
      headers: { [AUTH_HEADER]: buildAuthHeader(key.opaque, 'GET /v2/publish/credential', key.sign) },
    });
    const body = (await after.json()) as Record<string, unknown>;
    expect(body.verified).toBe(true);
    expect(typeof body.verified_at).toBe('string');
    // 响应体里不得出现任何载体痕迹
    expect(JSON.stringify(body)).not.toMatch(/example\.com|carrier|hmac/);
  });

  // ---------- 一对一约束 ----------

  it('一个邮箱只能绑一个密钥（防一人多号刷广场）', async () => {
    const a = realKey();
    const b = realKey();
    await register(a);
    await register(b);
    const n1 = newNonce();
    expect((await putCredential(a, n1, await verifyCarrier(n1))).status).toBe(201);

    const n2 = newNonce();
    const permit2 = await verifyCarrier(n2);
    const res = await putCredential(b, n2, permit2);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('publish_carrier_already_bound');
  });

  it('一个密钥只能绑一个邮箱（防囤积邮箱）', async () => {
    const a = realKey();
    await register(a);
    const n1 = newNonce();
    expect((await putCredential(a, n1, await verifyCarrier(n1))).status).toBe(201);

    const n2 = newNonce();
    const permit2 = await verifyCarrier(n2, 'alice.other@example.com');
    const res = await putCredential(a, n2, permit2);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('publish_owner_already_bound');
  });

  // ---------- 验证码与许可码 ----------

  it('验证码错满次数即作废，正确码也进不去', async () => {
    const nonce = newNonce();
    await app.request('/v2/publish/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, carrier: EMAIL }),
    });
    const code = mailer.sent[0]!.code;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < PUBLISH_MAX_ATTEMPTS; i += 1) {
      const r = await app.request('/v2/publish/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, code: wrong }),
      });
      expect(r.status).toBe(400);
    }
    const blocked = await app.request('/v2/publish/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, code }),
    });
    expect(blocked.status).toBe(429);
  });

  it('验证码一次性：换到许可码后再用同一个码无效', async () => {
    const nonce = newNonce();
    await app.request('/v2/publish/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, carrier: EMAIL }),
    });
    const code = mailer.sent[0]!.code;
    const first = await app.request('/v2/publish/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, code }),
    });
    expect(first.status).toBe(200);
    const again = await app.request('/v2/publish/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, code }),
    });
    expect(again.status).toBe(400);
  });

  it('许可码只能认领一次（第二次 409）', async () => {
    const key = realKey();
    await register(key);
    const nonce = newNonce();
    const permit = await verifyCarrier(nonce);
    expect((await putCredential(key, nonce, permit)).status).toBe(201);
    expect((await putCredential(key, nonce, permit)).status).toBe(409);
  });

  it('认领必须持钥证明：无认证头 / 错签名一律 401', async () => {
    const key = realKey();
    await register(key);
    const nonce = newNonce();
    const permit = await verifyCarrier(nonce);

    const noAuth = await app.request('/v2/publish/credential', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, permit }),
    });
    expect(noAuth.status).toBe(401);

    const badSig = await app.request('/v2/publish/credential', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        // 用另一个密钥签名（证明"知道有 nonce 与许可码"还不够，必须是自己那把钥匙）
        [AUTH_HEADER]: buildAuthHeader(key.opaque, 'PUT /v2/publish/credential', realKey().sign),
      },
      body: JSON.stringify({ nonce, permit }),
    });
    expect(badSig.status).toBe(401);
  });

  // ---------- 输入校验与限速 ----------

  it('载体格式错/一次性邮箱 → 400 且给出人话', async () => {
    for (const [carrier, expectText] of [
      ['not-an-email', '邮箱地址'],
      ['someone@mailinator.com', '一次性邮箱'],
      ['', '请填写'],
    ] as const) {
      const res = await app.request('/v2/publish/otp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: newNonce(), carrier }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(expectText);
    }
  });

  it('同一邮箱 1 分钟内只发一封（429 且告知等几秒）', async () => {
    const nonce = newNonce();
    const first = await app.request('/v2/publish/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, carrier: EMAIL }),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v2/publish/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, carrier: EMAIL }),
    });
    expect(second.status).toBe(429);
  });

  it('发信失败不静默：503 + 作废已生成的码', async () => {
    const failing = fakeMailer({ fail: true });
    build({ required: true, mailer: failing });
    const nonce = newNonce();
    const res = await app.request('/v2/publish/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, carrier: EMAIL }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain('请一两分钟后再点一次');
    // 码必须作废：否则一封"没发出去的信"留下了一个可被猜中的有效码
    expect(store.getChallenge(nonce)?.code_hmac).toBeUndefined();
  });

  it('nonce 不合法 → 400（防用畸形标识污染存储）', async () => {
    const res = await app.request('/v2/publish/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: 'short', carrier: EMAIL }),
    });
    expect(res.status).toBe(400);
  });

  // ---------- TC-30：不可逆查 ----------

  it('TC-30 数据目录里没有任何明文邮箱，只有不可反解的指纹', async () => {
    const key = realKey();
    await register(key);
    const nonce = newNonce();
    expect((await putCredential(key, nonce, await verifyCarrier(nonce))).status).toBe(201);

    const files: string[] = [];
    const walk = (p: string) => {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const full = join(p, e.name);
        if (e.isDirectory()) walk(full);
        else if (statSync(full).isFile()) files.push(full);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, 'utf-8');
      expect(text, f).not.toContain(EMAIL);
      expect(text, f).not.toContain('alice');
    }

    // 反向对照：指纹确实存在（证明"没写到盘上"不是因为压根没存）
    const hmac = store.carrierHmac(EMAIL);
    const credFile = join(dir, 'publish', `${hmac}.json`);
    expect(readFileSync(credFile, 'utf-8')).toContain(hmac);

    // 指纹不是裸哈希：同样的邮箱用"另一个实例的盐"算出来必然不同
    const other = new ServerStore(mkdtempSync(join(tmpdir(), 'hx-publish-other-')));
    try {
      expect(other.carrierHmac(EMAIL)).not.toBe(hmac);
    } finally {
      rmSync(other.root, { recursive: true, force: true });
    }
  });

  it('注销级联删除发布许可（同一邮箱可重新绑定新身份）', async () => {
    const a = realKey();
    await register(a);
    const nonce = newNonce();
    expect((await putCredential(a, nonce, await verifyCarrier(nonce))).status).toBe(201);
    expect(store.hasPublishCredential(a.opaque)).toBe(true);

    const del = await app.request('/v2/identity', {
      method: 'DELETE',
      headers: { [AUTH_HEADER]: buildAuthHeader(a.opaque, 'DELETE /v2/identity', a.sign) },
    });
    expect(del.status).toBe(200);
    expect(store.hasPublishCredential(a.opaque)).toBe(false);
    expect(store.findPublishCredentialByCarrier(store.carrierHmac(EMAIL))).toBeNull();

    // 换个身份用同一邮箱可以重新绑定——注销就该是这个效果
    const b = realKey();
    await register(b);
    const n2 = newNonce();
    expect((await putCredential(b, n2, await verifyCarrier(n2))).status).toBe(201);
  });

  // ---------- 对外声明 ----------

  it('healthz 告诉客户端这个实例要不要验证、通道通不通', async () => {
    const body = (await (await app.request('/healthz')).json()) as {
      publish: { required: boolean; available: boolean; verify_base: string | null };
    };
    expect(body.publish).toEqual({
      required: true,
      available: true,
      verify_base: 'https://hongxian.dev/publish-verify/',
    });

    build({ required: false, mailer: null });
    const off = (await (await app.request('/healthz')).json()) as { publish: { required: boolean; available: boolean } };
    expect(off.publish.required).toBe(false);
    expect(off.publish.available).toBe(false);
  });

  it('清扫会清掉超过存活期的挑战（不留垃圾）', async () => {
    const nonce = newNonce();
    await app.request('/v2/publish/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, carrier: EMAIL }),
    });
    expect(store.getChallenge(nonce)).not.toBeNull();
    const later = Date.now() + 31 * 60_000;
    const swept = store.sweepExpired(later);
    expect(swept.challenges).toBeGreaterThanOrEqual(1);
    expect(store.getChallenge(nonce)).toBeNull();
  });

  it('投递与信箱完全不受发布许可影响（约束 4：只在贴卡时要求）', async () => {
    const a = realKey();
    const b = realKey();
    await register(a);
    await register(b);
    // 未验证也能投递：这是"约束 4"的机器可验证形式
    const env = {
      meta: {
        schema_version: SCHEMA_VERSION,
        card_id: uuidV7(),
        owner_key_id: a.opaque,
        sig_public: a.pubB64,
        kx_public: toBase64(ed25519.getPublicKey(ed25519.utils.randomPrivateKey())),
        version: 1,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
        card_type: 'match_card' as const,
        msg_type: 'upgrade_request' as const,
        target_card_id: uuidV7(),
        depth: { interview_rounds: 3, completeness: 0.75, model_tier: 'local' as const },
        algo: { sig: 'ed25519' as const, aead: 'aes-256-gcm' as const, kex: 'x25519' as const },
      },
      payload: { nonce: '', ct: 'c2VhbGVk' },
    };
    const signature = toBase64(a.sign(canonicalBytes(env)));
    const res = await app.request(`/v2/mailbox/${enc(b.opaque)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...env, signature }),
    });
    expect(res.status).toBe(201);
  });
});
