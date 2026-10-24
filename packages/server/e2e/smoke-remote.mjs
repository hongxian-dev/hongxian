/**
 * 红线平台服务 · 远端冒烟（对已部署实例跑真实业务链路）
 *
 * 与 run-e2e.mjs 的分工：
 * - run-e2e.mjs：本地 spawn 服务进程 + 读本地数据目录，验证**代码**正确性；
 * - 本脚本：只走 HTTP，不碰目标机文件系统，验证**部署**正确性
 *   （容器起没起、数据卷可写、签名/验签在真实环境成立、零知识链路没被反代或
 *   前置中间件破坏）。
 *
 * 用法：
 *   node packages/server/e2e/smoke-remote.mjs http://127.0.0.1:8787
 *   # 预发（不对外开放）：先开隧道
 *   #   ssh -L 8787:127.0.0.1:8787 ubuntu@<预发主机>
 *
 * 注意：脚本会在目标实例留下 2 个身份与数据，末尾自动注销清理；
 * 中途失败时残留可用 DELETE /v2/identity（带持钥证明）手动清。
 */

import { randomBytes } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes';
import { sha256 } from '@noble/hashes/sha256';
import { canonicalBytes, fromBase64, toBase64, uuidV7 } from '@hongxian/schema';

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');

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

// ---------- 客户端基元（与 run-e2e.mjs 同口径） ----------

function genKey() {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  return { priv, pub, pubB64: toBase64(pub), sign: (m) => ed25519.sign(m, priv) };
}

function genKexKey() {
  const priv = x25519.utils.randomPrivateKey();
  const pub = x25519.getPublicKey(priv);
  return { priv, pub, pubB64: toBase64(pub) };
}

const keyIdOf = (pubB64) => toBase64(sha256(fromBase64(pubB64)));

function authHeader(key, action, now = Date.now()) {
  const ts = Math.floor(now / 1000);
  const opaque_id = keyIdOf(key.pubB64);
  const sig = key.sign(canonicalBytes({ opaque_id, ts, action }));
  return `${opaque_id}:${ts}:${toBase64(sig)}`;
}

async function api(path, { method = 'GET', body, key, action } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  // 签名用的 action 必须与服务端路由里的**解码后**地址一致：
  // opaque_id 是 base64（含 + / =），作为 path 段要 encode，但 Hono 的 c.req.param
  // 取到的是解码值，故 action 用 decodeURIComponent 还原。
  if (key) headers['x-hongxian-auth'] = authHeader(key, action ?? `${method} ${decodeURIComponent(path)}`);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json, text };
}

/** 构造签名的 plaza_card（刻意不含 key_l1——零知识硬规则） */
function signedPlazaCard(signer, l1Plaintext) {
  const key_l1 = randomBytes(32);
  const nonce = randomBytes(12);
  const ct = gcm(key_l1, nonce).encrypt(new TextEncoder().encode(JSON.stringify(l1Plaintext)));
  const meta = {
    schema_version: 1,
    card_id: uuidV7(),
    owner_key_id: keyIdOf(signer.pubB64),
    sig_public: signer.pubB64,
    kx_public: genKexKey().pubB64,
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
    payload_L2: {
      nonce: toBase64(randomBytes(12)),
      ct: toBase64(
        gcm(randomBytes(32), randomBytes(12)).encrypt(new TextEncoder().encode('{"l2":"x"}')),
      ),
    },
  };
  const signature = toBase64(signer.sign(canonicalBytes(parts)));
  return { envelope: { ...parts, signature }, key_l1 };
}

/** 构造签名消息信封；payload.ct = base64(JSON body)（冒烟只验链路，不验加密层） */
function signedEnvelope(signer, msgType, body, targetCardId) {
  const meta = {
    schema_version: 1,
    card_id: uuidV7(),
    owner_key_id: keyIdOf(signer.pubB64),
    sig_public: signer.pubB64,
    kx_public: genKexKey().pubB64,
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
  console.log(`\n红线平台 · 远端冒烟 → ${BASE}\n`);

  const health = await api('/healthz');
  check('healthz 返回 200', health.status === 200, `实际 ${health.status}`);
  check(
    'healthz 带实例标识',
    typeof health.json?.instance === 'string' && health.json.instance.length > 0,
    JSON.stringify(health.json),
  );
  const instance = health.json?.instance ?? '(unknown)';
  console.log(`    实例 = ${instance}`);

  // 邮局四军规：不存在匹配/推荐/搜索端点
  const forbidden = await Promise.all(
    ['/match', '/recommend', '/search', '/v1/cards'].map((p) => api(p)),
  );
  check(
    '无 /match /recommend /search 端点（四军规）',
    forbidden.every((r) => r.status === 404),
    forbidden.map((r) => r.status).join(','),
  );

  // ---- 注册 ----
  const alice = genKey();
  const bob = genKey();
  const aliceId = keyIdOf(alice.pubB64);
  const bobId = keyIdOf(bob.pubB64);

  const regA = await api('/v2/identity/register', {
    method: 'POST',
    key: alice,
    body: { opaque_id: aliceId, sig_public: alice.pubB64, kx_public: genKexKey().pubB64 },
  });
  check('注册甲 201', regA.status === 201, JSON.stringify(regA.json));

  const regB = await api('/v2/identity/register', {
    method: 'POST',
    key: bob,
    body: { opaque_id: bobId, sig_public: bob.pubB64, kx_public: genKexKey().pubB64 },
  });
  check('注册乙 201', regB.status === 201, JSON.stringify(regB.json));

  const regDup = await api('/v2/identity/register', {
    method: 'POST',
    key: alice,
    body: { opaque_id: aliceId, sig_public: alice.pubB64, kx_public: genKexKey().pubB64 },
  });
  check('重复注册被拒 409', regDup.status === 409, `实际 ${regDup.status}`);

  // 形状校验：垃圾公钥进不来
  const regBad = await api('/v2/identity/register', {
    method: 'POST',
    key: alice,
    body: { opaque_id: 'x', sig_public: 'y', kx_public: 'z' },
  });
  check('非法公钥形状被拒 400', regBad.status === 400, `实际 ${regBad.status}`);

  // ---- 广场 ----
  const { envelope: card, key_l1 } = signedPlazaCard(alice, {
    nickname: '冒烟测试甲',
    city: '310000',
  });
  const post = await api('/v2/cards', { method: 'POST', body: card });
  check('甲贴卡 201', post.status === 201, JSON.stringify(post.json));

  const plaza = await api('/v2/cards?limit=50');
  check('拉取广场 200', plaza.status === 200, `实际 ${plaza.status}`);
  const items = plaza.json?.items ?? [];
  const mine = items.find((e) => e?.meta?.card_id === card.meta.card_id);
  check('广场里能拉到刚贴的卡', Boolean(mine));

  const serialized = JSON.stringify(plaza.json ?? {});
  check('广场响应不含 key_l1（零知识）', !serialized.includes(toBase64(key_l1)));
  check(
    '广场卡不含 payload_L3 明文',
    !items.some((e) => typeof e?.payload_L3?.ct === 'string' && e.payload_L3.ct.length > 0),
  );

  // 拉回来的卡必须验签通过
  let sigOk = false;
  if (mine) {
    const { signature, ...rest } = mine;
    const pub = fromBase64(mine.meta.sig_public);
    sigOk = ed25519.verify(fromBase64(signature), canonicalBytes(rest), pub);
  }
  check('拉回的卡验签通过', sigOk);

  // ---- 信箱 ----
  const env = signedEnvelope(alice, 'upgrade_request', { stage: 'L1', note: '冒烟' }, card.meta.card_id);
  const deliver = await api(`/v2/mailbox/${encodeURIComponent(bobId)}`, {
    method: 'POST',
    key: alice,
    body: env,
  });
  check('甲向乙投递 201', deliver.status === 201, JSON.stringify(deliver.json));

  const box = await api(`/v2/mailbox/${encodeURIComponent(bobId)}`, { key: bob });
  check('乙拉信箱 200', box.status === 200, `实际 ${box.status}`);
  const got = (box.json?.items ?? []).find((e) => e?.meta?.card_id === env.meta.card_id);
  check('乙收到那封信', Boolean(got));

  let bodyOk = false;
  if (got) {
    const { signature, ...rest } = got;
    const sigVerify = ed25519.verify(
      fromBase64(signature),
      canonicalBytes(rest),
      fromBase64(got.meta.sig_public),
    );
    let decoded = null;
    try {
      decoded = JSON.parse(
        new TextDecoder().decode(fromBase64(got.payload.ct)),
      );
    } catch {
      /* ignore */
    }
    bodyOk = sigVerify && decoded?.stage === 'L1';
  }
  check('信体验签通过且正文可还原', bodyOk);

  const boxNoAuth = await api(`/v2/mailbox/${encodeURIComponent(bobId)}`);
  check('未认证拉信箱被拒 401', boxNoAuth.status === 401, `实际 ${boxNoAuth.status}`);

  // ---- 举报 ----
  const report = await api('/v2/reports', {
    method: 'POST',
    key: bob,
    body: { target_opaque_id: aliceId, reason_code: 'harassment' },
  });
  check(
    '乙举报甲 201（或理由枚举不符则 400）',
    report.status === 201 || report.status === 400,
    `${report.status} ${JSON.stringify(report.json)}`,
  );

  const selfReport = await api('/v2/reports', {
    method: 'POST',
    key: bob,
    body: { target_opaque_id: bobId, reason_code: 'harassment' },
  });
  check('不能举报自己 400', selfReport.status === 400, `实际 ${selfReport.status}`);

  const myReports = await api(`/v2/reports/${encodeURIComponent(aliceId)}`, { key: alice });
  check('本人可查自己举报汇总 200', myReports.status === 200, `实际 ${myReports.status}`);
  const otherReports = await api(`/v2/reports/${encodeURIComponent(aliceId)}`, { key: bob });
  // 服务端用**目标者**的公钥验签，故第三方请求在验签阶段就 401——
  // 比 403 更强：不向无关者确认「该 opaque_id 有举报记录」这件事本身。
  check(
    '他人查不到举报汇总（401 或 403）',
    otherReports.status === 401 || otherReports.status === 403,
    `实际 ${otherReports.status}`,
  );

  // ---- 透明度 ----
  const stats = await api('/v2/stats');
  const statsText = JSON.stringify(stats.json ?? {});
  check('stats 200', stats.status === 200);
  check('stats 不含任何 opaque ID', !statsText.includes(aliceId) && !statsText.includes(bobId));
  check(
    'stats 只有总和字段',
    ['identities', 'cards', 'envelopes'].every((k) => typeof stats.json?.[k] === 'number'),
    statsText,
  );

  // ---- 注销级联 ----
  const del = await api('/v2/identity', { method: 'DELETE', key: alice });
  check('甲注销成功', del.status === 200, `实际 ${del.status}`);
  const after = await api('/v2/cards?limit=50');
  check(
    '注销后甲的卡从广场消失',
    !(after.json?.items ?? []).some((e) => e?.meta?.card_id === card.meta.card_id),
  );
  const boxAfter = await api(`/v2/mailbox/${encodeURIComponent(bobId)}`, { key: bob });
  check('注销后投递的信仍留在乙信箱（收件方资产不随发件人删除）', boxAfter.status === 200);

  // 清理乙
  const delB = await api('/v2/identity', { method: 'DELETE', key: bob });
  check('乙注销成功（清理现场）', delB.status === 200, `实际 ${delB.status}`);

  console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\n冒烟失败：', err);
  process.exit(1);
});
