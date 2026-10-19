/**
 * 红线平台服务 · 双客户端 E2E（M1.2 验收）
 *
 * 真实子进程起服务 + 两个完整客户端（甲方 alice / 乙方 bob）走 HTTP 全流程：
 *   注册（持钥证明）→ 广场贴卡（无 key_l1）→ 拉池验签 → 敲门（upgrade_request）
 *   → 应答（grant_l1 密封 key_l1）→ 乙方开封解密 L1 → 注销级联清零
 * 附加验收：
 *   - 零知识数据级审计：服务端数据目录 grep 不到 key_l1 / L1 明文字段
 *   - 广场拉取响应中无 key_l1
 *   - 未认证拉取被 401 拒
 *
 * 运行：node packages/server/e2e/run-e2e.mjs（需先 npm run build）
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes';
import { sha256 } from '@noble/hashes/sha256';
import { canonicalBytes, fromBase64, toBase64, uuidV7 } from '@hongxian/schema';
import { sealBox, openBox } from '@hongxian/crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SERVER_ENTRY = join(ROOT, 'packages', 'server', 'dist', 'index.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

// ---------- 测试客户端 ----------

function genKey() {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  return { priv, pub, pubB64: toBase64(pub), sign: (m) => ed25519.sign(m, priv) };
}

/** X25519 协商密钥对（grant 类封装的收件人密钥——与 Ed25519 身份密钥分离） */
function genKexKey() {
  const priv = x25519.utils.randomPrivateKey();
  const pub = x25519.getPublicKey(priv);
  return { priv, pub, pubB64: toBase64(pub) };
}

/** opaque_id = SHA-256(签名公钥) 指纹（协议 §7） */
const keyIdOf = (pubB64) => toBase64(sha256(fromBase64(pubB64)));

function authHeader(key, action, now = Date.now()) {
  const ts = Math.floor(now / 1000);
  const sig = key.sign(canonicalBytes({ opaque_id: keyIdOf(key.pubB64), ts, action }));
  return `${keyIdOf(key.pubB64)}:${ts}:${toBase64(sig)}`;
}

const enc = encodeURIComponent;

async function api(base, path, { method = 'GET', body, key, action } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['x-hongxian-auth'] = authHeader(key, action ?? `${method} ${path}`);
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

/** 构造签名的 plaza_card（无 key_l1）+ 本地留存的 key_l1 与 L1 明文 */
function signedPlazaCard(signer, l1Plaintext) {
  const key_l1 = randomBytes(32);
  const nonce = randomBytes(12);
  const ct = gcm(key_l1, nonce).encrypt(new TextEncoder().encode(JSON.stringify(l1Plaintext)));
  const meta = {
    schema_version: 1,
    card_id: uuidV7(),
    owner_key_id: keyIdOf(signer.pubB64),
    sig_public: signer.pubB64,
    kx_public: genKey().pubB64,
    version: 1,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
    card_type: 'plaza_card',
    depth: { interview_rounds: 3, completeness: 0.8, model_tier: 'local' },
    algo: { sig: 'ed25519', aead: 'aes-256-gcm', kex: 'x25519' },
  };
  const parts = {
    meta,
    payload_L1: { nonce: toBase64(nonce), ct: toBase64(ct) },
    payload_L2: { nonce: toBase64(randomBytes(12)), ct: toBase64(gcm(randomBytes(32), randomBytes(12)).encrypt(new TextEncoder().encode('{"l2":"x"}'))) },
  };
  const signature = toBase64(signer.sign(canonicalBytes(parts)));
  return { envelope: { ...parts, signature }, key_l1 };
}

/** 构造签名信封；e2e 口径 payload.ct = base64(JSON body)（平台流程测试，不测信封加密） */
function signedEnvelope(signer, msgType, body, targetCardId) {
  const meta = {
    schema_version: 1,
    card_id: uuidV7(),
    owner_key_id: keyIdOf(signer.pubB64),
    sig_public: signer.pubB64,
    kx_public: genKey().pubB64,
    version: 1,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    card_type: 'match_card',
    msg_type: msgType,
    target_card_id: targetCardId,
    depth: { interview_rounds: 3, completeness: 0.8, model_tier: 'local' },
    algo: { sig: 'ed25519', aead: 'aes-256-gcm', kex: 'x25519' },
  };
  const payload = { nonce: '', ct: toBase64(new TextEncoder().encode(JSON.stringify(body))) };
  const signature = toBase64(signer.sign(canonicalBytes({ meta, payload })));
  return { meta, payload, signature };
}

// ---------- 主流程 ----------

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hx-srv-e2e-'));
  const port = 18700 + Math.floor(Math.random() * 800);
  const base = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, HONGXIAN_SERVER_DATA: dataDir, PORT: String(port), HONGXIAN_INSTANCE: 'e2e.instance' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (d) => {
    serverErr += d.toString();
  });

  const waitUp = async () => {
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`${base}/healthz`);
        if (r.ok) return true;
      } catch {
        /* 未起 */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  try {
    console.log('■ S0 服务启动');
    check('服务就绪（healthz）', await waitUp(), serverErr.slice(0, 200));

    const alice = genKey();
    const bob = genKey();
    const bobKx = genKexKey(); // 乙方协商密钥对（grant 封装的收件人——X25519）

    console.log('\n■ S1 注册（持钥证明）');
    const regA = await api(base, '/v2/identity/register', {
      method: 'POST',
      body: { opaque_id: keyIdOf(alice.pubB64), sig_public: alice.pubB64, kx_public: genKey().pubB64 },
      key: alice,
      action: 'POST /v2/identity/register',
    });
    check('甲方注册 201', regA.status === 201, regA.text.slice(0, 120));
    const regB = await api(base, '/v2/identity/register', {
      method: 'POST',
      body: { opaque_id: keyIdOf(bob.pubB64), sig_public: bob.pubB64, kx_public: genKey().pubB64 },
      key: bob,
      action: 'POST /v2/identity/register',
    });
    check('乙方注册 201', regB.status === 201, regB.text.slice(0, 120));

    console.log('\n■ S2 广场贴卡（零知识：无 key_l1）');
    const l1 = {
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
    };
    const { envelope: plazaCard, key_l1 } = signedPlazaCard(alice, l1);
    const up = await api(base, '/v2/cards', { method: 'POST', body: plazaCard });
    check('广场卡上传 201', up.status === 201, up.text.slice(0, 160));

    console.log('\n■ S3 乙方拉池 + 验签（只见 meta + 密文）');
    const pool = await api(base, '/v2/cards');
    check('拉取卡池 200', pool.status === 200);
    const items = pool.json?.items ?? [];
    check('池中一张卡', items.length === 1);
    const pulled = items[0];
    check('响应无 key_l1', pulled && pulled.key_l1 === undefined);
    const l1CtPlain = pulled ? Buffer.from(pulled.payload_L1.ct, 'base64').toString('utf-8') : '';
    check('L1 密文不含明文昵称', !l1CtPlain.includes('阿泽') && !l1CtPlain.includes('nickname'));

    console.log('\n■ S4 敲门：upgrade_request（定向投递至甲方信箱）');
    const knock = signedEnvelope(bob, 'upgrade_request', {
      from_card_id: uuidV7(),
      attach_card_ref: 'card.json',
      requester_kx_public: bobKx.pubB64,
    }, plazaCard.meta.card_id);
    const deliver = await api(base, `/v2/mailbox/${enc(keyIdOf(alice.pubB64))}`, { method: 'POST', body: knock });
    check('投递 201 + 已入信箱', deliver.status === 201 && deliver.json?.entered_mailbox === true, deliver.text.slice(0, 120));

    console.log('\n■ S5 甲方拉信箱（签名认证；无认证 → 401）');
    const noAuth = await api(base, `/v2/mailbox/${enc(keyIdOf(alice.pubB64))}`);
    check('未认证拉取 401', noAuth.status === 401);
    const inbox = await api(base, `/v2/mailbox/${enc(keyIdOf(alice.pubB64))}`, {
      key: alice,
      action: `GET /v2/mailbox/${keyIdOf(alice.pubB64)}`,
    });
    check('甲方拉取 200 且有一封', inbox.status === 200 && (inbox.json?.items ?? []).length === 1, inbox.text.slice(0, 120));

    console.log('\n■ S6 应答：grant_l1（key_l1 密封至乙方 kx 公钥）→ 乙方开封解密 L1');
    // 甲方从信封解出乙方的协商公钥，密封 key_l1 回送
    const knockBody = JSON.parse(Buffer.from(knock.payload.ct, 'base64').toString('utf-8'));
    const sealedKeyL1 = toBase64(sealBox(key_l1, fromBase64(knockBody.requester_kx_public)));
    const grant = signedEnvelope(alice, 'grant_l1', {
      from_card_id: plazaCard.meta.card_id,
      card_fingerprint: 'a1b2c3d4e5f6a7b8',
      sealed_key_l1: sealedKeyL1,
    }, knock.meta.card_id);
    const deliverGrant = await api(base, `/v2/mailbox/${enc(keyIdOf(bob.pubB64))}`, { method: 'POST', body: grant });
    check('grant_l1 投递 201', deliverGrant.status === 201, deliverGrant.text.slice(0, 120));

    const bobInbox = await api(base, `/v2/mailbox/${enc(keyIdOf(bob.pubB64))}`, {
      key: bob,
      action: `GET /v2/mailbox/${keyIdOf(bob.pubB64)}`,
    });
    check('乙方拉取 200 且有一封', bobInbox.status === 200 && (bobInbox.json?.items ?? []).length === 1);
    const grantBody = JSON.parse(Buffer.from(bobInbox.json.items[0].payload.ct, 'base64').toString('utf-8'));
    const opened = openBox(fromBase64(grantBody.sealed_key_l1), bobKx.priv);
    check('乙方开封得到 key_l1', opened !== null && Buffer.from(opened).equals(Buffer.from(key_l1)));
    // 用解得的 key_l1 解密广场卡 L1，与甲方原文比对
    const decrypted = gcm(opened, fromBase64(pulled.payload_L1.nonce)).decrypt(fromBase64(pulled.payload_L1.ct));
    const l1Back = JSON.parse(new TextDecoder().decode(decrypted));
    check('L1 解密后与甲方原文一致', l1Back.nickname === l1.nickname && l1Back.bio === l1.bio && l1Back.city.code === l1.city.code);

    console.log('\n■ S7 零知识数据级审计（服务端落盘）');
    const dataFiles = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else dataFiles.push(p);
      }
    };
    walk(dataDir);
    const allText = dataFiles.map((f) => readFileSync(f, 'utf-8')).join('\n');
    check('数据目录无 key_l1 字段', !allText.includes('"key_l1"'));
    check('数据目录无 L1 明文（昵称）', !allText.includes('阿泽'));
    check('数据目录无 L1 明文（bio）', !allText.includes('写代码也爬山'));

    console.log('\n■ S8 注销级联清零');
    const del = await api(base, '/v2/identity', {
      method: 'DELETE',
      key: alice,
      action: 'DELETE /v2/identity',
    });
    check('注销 200', del.status === 200, del.text.slice(0, 120));
    const poolAfter = await api(base, '/v2/cards');
    check('注销后广场池空', (poolAfter.json?.items ?? []).length === 0);
    const inboxAfter = await api(base, `/v2/mailbox/${enc(keyIdOf(alice.pubB64))}`, {
      key: alice,
      action: `GET /v2/mailbox/${keyIdOf(alice.pubB64)}`,
    });
    check('注销后信箱不存在（404）', inboxAfter.status === 404);
  } finally {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n===== 服务端 E2E 完成：${passed}/${passed + failed} 通过 =====`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E 运行异常：', e);
  process.exit(1);
});
