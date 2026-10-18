/**
 * 红线 Hongxian · 匿名计数器（Cloudflare Worker + KV）
 * ============================================================
 * 定位：独立于月老 Skill 与红线协议的「纯计数器」。
 * 法律性质 ≈ 网站访问计数器——不存储任何用户数据、不参与任何匹配流程、
 * 不认识任何用户。这是它能进 v1（零服务端军规）的原因。
 *
 * 端点：
 *   POST /bump   月老 Skill（opt-in）上报匿名计数
 *                 请求体：{ metric, bucket, salt, nonce }
 *                 - 指标白名单：cards/gender/age_band/exchanges
 *                 - 工作量证明：sha256(salt|metric|bucket|nonce) 前 N 位为 0
 *                 - 限速：同一 IP 哈希每天 120 次（只存哈希，不存 IP）
 *                 - 无日志：不记录 IP、时间戳与任何请求内容
 *   GET  /stats  公开只读聚合数据（网站透明数据区渲染源）
 *
 * KV 键布局：
 *   t:<family>:<bucket>          总计（不过期）
 *   d:<family>:<bucket>:<日期>    日桶（TTL 45 天，用于滚动 30 天统计）
 *   dd:cards:active:<日期>:<iphash>  当日活跃去重（TTL 45 天）
 *   rl:<iphash>                  限速计数（TTL 24 小时）
 */

const FAMILIES = {
  cards: ['total', 'active'],                       // cards_total / cards_active_30d
  gender: ['female', 'male'],                       // gender_female / gender_male
  age_band: ['18_25', '26_30', '31_35', '36_40', '40_plus'],
  exchanges: ['total']                              // exchanges_total
};

const AGE_BANDS = FAMILIES.age_band;
const RL_LIMIT = 120;                // 每 IP 哈希每天上报上限
const RL_TTL = 86400;
const DAILY_TTL = 45 * 86400;        // 日桶保留 45 天（覆盖 30 天滚动窗口）

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    }, extraHeaders)
  });
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function resolveMetric(metric, bucket) {
  if (typeof metric !== 'string' || typeof bucket !== 'string') return null;
  const allowed = FAMILIES[metric];
  if (!allowed || allowed.indexOf(bucket) === -1) return null;
  if (!/^[a-z0-9_]{1,32}$/.test(metric) || !/^[a-z0-9_]{1,32}$/.test(bucket)) return null;
  return metric + '_' + bucket; // 如 cards_total / gender_female / age_band_26_30
}

async function handleBump(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid json' }, 400);
  }

  const { metric, bucket, salt, nonce } = body || {};
  const name = resolveMetric(metric, bucket);
  if (!name) return json({ error: 'unknown metric' }, 400);

  /* ---- 工作量证明：防刷数字（数字被刷爆会反噬信任） ---- */
  const difficulty = Math.min(8, Math.max(1, parseInt(env.POW_DIFFICULTY || '4', 10) || 4));
  const required = '0'.repeat(difficulty);
  const hash = await sha256hex([salt, metric, bucket, nonce].join('|'));
  if (!hash.startsWith(required)) {
    return json({ error: 'pow required', difficulty }, 403, CORS);
  }

  /* ---- 限速：按 IP 哈希计数，只存哈希、不存 IP ---- */
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = (await sha256hex(ip + '|' + (env.RL_SALT || 'hongxian-default'))).slice(0, 32);
  const rlKey = 'rl:' + ipHash;
  const rlCount = parseInt((await env.COUNTER.get(rlKey)) || '0', 10);
  if (rlCount >= RL_LIMIT) {
    return json({ error: 'rate limited' }, 429, CORS);
  }
  await env.COUNTER.put(rlKey, String(rlCount + 1), { expirationTtl: RL_TTL });

  /* ---- 当日活跃去重：同一 IP 哈希每天只计一次 ---- */
  const date = today();
  if (bucket === 'active') {
    const ddKey = 'dd:' + metric + ':' + bucket + ':' + date + ':' + ipHash;
    if (await env.COUNTER.get(ddKey)) {
      return json({ ok: true, metric: name, deduped: true }, 202, CORS);
    }
    await env.COUNTER.put(ddKey, '1', { expirationTtl: DAILY_TTL });
  }

  /* ---- 计数：总计 + 日桶 ---- */
  const tKey = 't:' + metric + ':' + bucket;
  const dKey = 'd:' + metric + ':' + bucket + ':' + date;
  const tVal = parseInt((await env.COUNTER.get(tKey)) || '0', 10);
  const dVal = parseInt((await env.COUNTER.get(dKey)) || '0', 10);
  await env.COUNTER.put(tKey, String(tVal + 1));
  await env.COUNTER.put(dKey, String(dVal + 1), { expirationTtl: DAILY_TTL });

  return json({ ok: true, metric: name }, 200, CORS);
}

async function handleStats(env) {
  const counters = {};

  /* 总计 */
  const totals = await env.COUNTER.list({ prefix: 't:' });
  await Promise.all((totals.keys || []).map(async (k) => {
    const name = k.name.slice(2).replace(':', '_'); // t:cards:total -> cards_total
    counters[name] = parseInt((await env.COUNTER.get(k.name)) || '0', 10);
  }));

  /* 滚动 30 天活跃卡数：对 d:cards:active:<date> 按日期窗口求和 */
  const cutoff = daysAgo(29); // 含今天共 30 天
  const dailies = await env.COUNTER.list({ prefix: 'd:cards:active:' });
  let active30 = 0;
  await Promise.all((dailies.keys || []).map(async (k) => {
    const date = k.name.split(':').pop();
    if (date >= cutoff) {
      active30 += parseInt((await env.COUNTER.get(k.name)) || '0', 10);
    }
  }));
  if (active30 > 0 || !('cards_active' in counters)) {
    counters.cards_active_30d = active30;
  }

  return json({
    counters,
    updated_at: new Date().toISOString(),
    notice: '匿名聚合数据 · opt-in 上报 · 无用户标识 · 无 IP 记录'
  }, 200, Object.assign({
    'Cache-Control': 'public, max-age=300'
  }, CORS));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === '/stats' && request.method === 'GET') {
      return handleStats(env);
    }
    if (url.pathname === '/bump' && request.method === 'POST') {
      return handleBump(request, env);
    }
    return json({ error: 'not found' }, 404, CORS);
  }
};
