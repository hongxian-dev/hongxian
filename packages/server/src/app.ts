/**
 * 红线平台服务 · HTTP 应用（API v1 终稿，工程设计 §6）
 *
 * 军规对照（每条都过邮局测试）：
 *   ❌ 无 /match、无 /recommend、无 /search——没有任何搜索/排序/评分端点
 *   ✅ 广场 = 哑管道：GET /v2/cards 返回全量池（cursor 分页），零过滤
 *   ✅ 投递只接受点对点定向地址；广播在协议层不可表达
 *   ✅ 无在线状态端点、无已读回执字段；发件方确认只到"已入信箱"
 *   ✅ 零知识：上传即验签 + 拒收携 key_l1 的广场卡（§10.5）；本服务不出网
 *
 * 认证（auth.ts）：注册即持钥证明；拉取/删除类操作需签名认证头。
 * 注册与贴卡都验签（Ed25519 公钥）——服务端自始至终不持任何解密材料。
 */

import { Hono } from 'hono';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import {
  DEFAULT_TTL_DAYS,
  MAX_DAILY_DELIVERIES,
  MsgEnvelope,
  PLAZA_PAGE_SIZE,
  canonicalBytes,
  fromBase64,
  isPlazaCard,
  parseAddress,
  validateEnvelope,
  type MatchCardEnvelope,
} from '@hongxian/schema';
import { ServerStore, cardFingerprintOf, type StoredCard } from './store.js';
import { AUTH_HEADER, verifyAuthHeader } from './auth.js';

export interface ServerConfig {
  /** 本实例域名（v2.0：拒绝带外域后缀的投递，防静默误投） */
  instance: string;
}

/** 广场卡 TTL 上限（服务端少一分持有少一分责任；默认 30 天的 3 倍封顶） */
const MAX_CARD_TTL_DAYS = DEFAULT_TTL_DAYS * 3;

export function createApp(store: ServerStore, config: ServerConfig): Hono {
  const app = new Hono();

  // ---------- 健康检查（无状态、无计数、无追踪） ----------
  app.get('/healthz', (c) => c.json({ ok: true, service: 'hongxian-plaza', instance: config.instance }));

  // ---------- 身份 ----------

  /**
   * 注册 = 持钥证明：auth 头对 body.sig_public 验签通过才建档。
   * 防"用别人 opaque_id 抢注"——opaque_id 是公开信息，私钥不是。
   */
  app.post('/v2/identity/register', async (c) => {
    let body: { opaque_id?: string; sig_public?: string; kx_public?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '请求体必须是 JSON' }, 400);
    }
    const { opaque_id, sig_public, kx_public } = body;
    if (!opaque_id || !sig_public || !kx_public) {
      return c.json({ error: '缺少 opaque_id / sig_public / kx_public' }, 400);
    }
    // 形状校验：三者都是 32 字节公钥材料的 base64——垃圾数据进不来，也就不会污染存档
    if (!isB64OfLen(opaque_id, 32) || !isB64OfLen(sig_public, 32) || !isB64OfLen(kx_public, 32)) {
      return c.json({ error: 'opaque_id / sig_public / kx_public 必须是 32 字节材料的 base64' }, 400);
    }
    // 协议 §7：opaque_id = SHA-256(sig_public) 指纹——注册时绑定，防地址与钥匙错配
    if (opaque_id !== keyIdOf(sig_public)) {
      return c.json({ error: 'opaque_id 必须等于 sig_public 的 SHA-256 指纹（协议 §7）' }, 400);
    }
    const action = 'POST /v2/identity/register';
    const auth = verifyAuthHeader(c.req.header(AUTH_HEADER), action, sig_public);
    if (!auth.ok) return c.json({ error: `注册需持钥证明：${auth.error}` }, 401);
    if (auth.ctx.opaque_id !== opaque_id) {
      return c.json({ error: '认证头 opaque_id 与请求体不一致' }, 400);
    }
    if (store.getIdentity(opaque_id)) {
      return c.json({ error: '身份已存在（v2.0 不支持身份密钥轮换）' }, 409);
    }
    store.putIdentity({ opaque_id, sig_public, kx_public, created_at: new Date().toISOString() });
    return c.json({ opaque_id, registered: true }, 201);
  });

  /** 存在性查询（公开；返回体不含任何其他信息） */
  app.get('/v2/identity/:opaqueId', (c) => {
    const opaqueId = c.req.param('opaqueId');
    const found = store.getIdentity(opaqueId);
    if (!found) return c.json({ error: '身份不存在' }, 404);
    return c.json({ opaque_id: opaqueId, exists: true });
  });

  /** 注销：级联删除全部密文（签名认证；实名记录若有，由运营层依法处理——v2.0 无实名层） */
  app.delete('/v2/identity', (c) => {
    const action = 'DELETE /v2/identity';
    const header = c.req.header(AUTH_HEADER);
    const provisional = header?.split(':')[0];
    const identity = provisional ? store.getIdentity(provisional) : null;
    if (!identity) return c.json({ error: '身份不存在' }, 404);
    const auth = verifyAuthHeader(header, action, identity.sig_public);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    const removed = store.deleteIdentity(auth.ctx.opaque_id);
    return c.json({ removed });
  });

  // ---------- 广场（哑管道） ----------

  /** 贴卡：验签 + §10.5 零知识硬规则（plaza_card 不得携 key_l1）+ TTL 封顶 */
  app.post('/v2/cards', async (c) => {
    let envelope: unknown;
    try {
      envelope = await c.req.json();
    } catch {
      return c.json({ error: '请求体必须是 JSON' }, 400);
    }
    const v = validateEnvelope(envelope);
    if (!v.ok || !v.data) {
      return c.json({ error: `信封不合法：${v.errors.join('；')}` }, 400);
    }
    const card = v.data;
    if (!isPlazaCard(card)) {
      return c.json({ error: '广场只接受 plaza_card 变体（match_card 走文件直交，不经服务端）' }, 400);
    }
    // 持钥证明：签名必须过卡自带公钥（上传即归属证明）
    const sigOk = verifyEnvelopeSignature(card);
    if (!sigOk) return c.json({ error: '卡片验签失败——拒绝上传' }, 400);
    // 归属自证：owner_key_id 必须就是签名公钥的指纹（协议 §7）——
    // 否则任何人可拿别人的（公开的）opaque_id 当 owner_key_id 贴卡，顶掉对方广场位
    if (card.meta.owner_key_id !== keyIdOf(card.meta.sig_public)) {
      return c.json({ error: 'owner_key_id 与签名公钥不匹配（协议 §7：opaque_id = SHA-256(sig_public)）' }, 400);
    }
    const owner = card.meta.owner_key_id;
    if (!store.getIdentity(owner)) {
      return c.json({ error: '身份未注册（先 POST /v2/identity/register）' }, 409);
    }
    const ttlMs = Date.parse(card.meta.expires_at) - Date.now();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      return c.json({ error: '卡片已过期（expires_at 必须晚于当前时间）' }, 400);
    }
    if (ttlMs > MAX_CARD_TTL_DAYS * 86400_000) {
      return c.json({ error: `TTL 超过服务端上限（${MAX_CARD_TTL_DAYS} 天）` }, 400);
    }
    store.putCard(owner, { envelope: card, uploaded_at: new Date().toISOString() });
    return c.json({ fingerprint: cardFingerprintOf(card), uploaded: true }, 201);
  });

  /** 拉取广场卡池：哑管道全量 + cursor 分页。零过滤、零排序（仅为分页确定性） */
  app.get('/v2/cards', (c) => {
    const cursor = c.req.query('cursor') ?? null;
    const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') ?? '', 10) || PLAZA_PAGE_SIZE, 1), 200);
    const page = store.listCards(cursor, limit);
    return c.json({
      items: page.items.map((c2: StoredCard) => c2.envelope),
      next_cursor: page.next_cursor,
    });
  });

  /** 撤卡：按指纹定位 + 签名认证（持钥人才能撤自己的卡） */
  app.delete('/v2/cards/:fingerprint', (c) => {
    const fingerprint = c.req.param('fingerprint');
    const card = store.findCardByFingerprint(fingerprint);
    if (!card) return c.json({ error: '卡不存在（或已过期被清扫）' }, 404);
    const action = `DELETE /v2/cards/${fingerprint}`;
    const auth = verifyAuthHeader(c.req.header(AUTH_HEADER), action, card.envelope.meta.sig_public);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    if (auth.ctx.opaque_id !== card.envelope.meta.owner_key_id) {
      return c.json({ error: '非卡主（opaque_id 不匹配）' }, 403);
    }
    store.deleteCard(card.envelope.meta.owner_key_id);
    return c.json({ withdrawn: true });
  });

  // ---------- 信箱 ----------

  /** 投递：定向地址 + 收件人已注册 + 信封验签 + 限速。确认只到"已入信箱" */
  app.post('/v2/mailbox/:address', async (c) => {
    const address = c.req.param('address');
    const parsed = parseAddress(address);
    if (!parsed) return c.json({ error: '地址非法（应为 opaque_id 或 opaque_id@instance）' }, 400);
    if (parsed.instance && parsed.instance !== config.instance) {
      return c.json({ error: `跨实例投递未开放（v2.1）；本实例域名为 ${config.instance}` }, 400);
    }
    if (!store.getIdentity(parsed.opaque_id)) {
      return c.json({ error: '收件人未在本实例注册' }, 404);
    }
    let envelope: unknown;
    try {
      envelope = await c.req.json();
    } catch {
      return c.json({ error: '请求体必须是 JSON' }, 400);
    }
    const v = MsgEnvelope.safeParse(envelope);
    if (!v.success) {
      return c.json({ error: `信封结构不合法：${v.error.issues.map((i) => i.path.join('.')).join(', ')}` }, 400);
    }
    const env = v.data;
    const sigOk = verifyMsgSignature(env);
    if (!sigOk) return c.json({ error: '信封验签失败——拒绝投递' }, 400);
    // 归属自证：发件人 ID 必须就是签名公钥指纹——否则可冒用他人 ID 记账（消耗对方
    // 每日配额）或把信伪装成他人所发
    if (env.meta.owner_key_id !== keyIdOf(env.meta.sig_public)) {
      return c.json({ error: 'owner_key_id 与签名公钥不匹配（协议 §7）' }, 400);
    }
    // 收件箱条目不可被顶掉：同 card_id 的信已在信箱里则拒收（客户端用 uuid，正常不撞）
    if (store.hasEnvelope(parsed.opaque_id, env.meta.card_id)) {
      return c.json({ error: '信封 ID 冲突（重签换 card_id 后再投）' }, 409);
    }
    // 限速：按发件人 opaque ID 计（结构限制优于内容审查）
    const day = new Date().toISOString().slice(0, 10);
    const count = store.bumpDeliveryCount(env.meta.owner_key_id, day);
    if (count > MAX_DAILY_DELIVERIES) {
      return c.json({ error: `超出每日定向投递上限（${MAX_DAILY_DELIVERIES} 封）` }, 429);
    }
    const id = store.putEnvelope(parsed.opaque_id, {
      envelope: env,
      delivered_at: new Date().toISOString(),
    });
    return c.json({ id, entered_mailbox: true }, 201);
  });

  /** 拉取自己的信箱：签名认证 + 地址匹配；无已读回执、无 presence */
  app.get('/v2/mailbox/:address', (c) => {
    const address = c.req.param('address');
    const parsed = parseAddress(address);
    if (!parsed) return c.json({ error: '地址非法' }, 400);
    const identity = store.getIdentity(parsed.opaque_id);
    if (!identity) return c.json({ error: '信箱不存在' }, 404);
    const action = `GET /v2/mailbox/${address}`;
    const auth = verifyAuthHeader(c.req.header(AUTH_HEADER), action, identity.sig_public);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    if (auth.ctx.opaque_id !== parsed.opaque_id) return c.json({ error: '非本人信箱' }, 403);
    const cursor = c.req.query('cursor') ?? null;
    const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') ?? '', 10) || PLAZA_PAGE_SIZE, 1), 200);
    const page = store.listEnvelopes(parsed.opaque_id, cursor, limit);
    return c.json({
      items: page.items.map((e) => e.envelope),
      next_cursor: page.next_cursor,
    });
  });

  /** 删除单封信（收件方；签名认证） */
  app.delete('/v2/mailbox/:address/:envId', (c) => {
    const address = c.req.param('address');
    const envId = c.req.param('envId');
    const parsed = parseAddress(address);
    if (!parsed) return c.json({ error: '地址非法' }, 400);
    const identity = store.getIdentity(parsed.opaque_id);
    if (!identity) return c.json({ error: '信箱不存在' }, 404);
    const action = `DELETE /v2/mailbox/${address}/${envId}`;
    const auth = verifyAuthHeader(c.req.header(AUTH_HEADER), action, identity.sig_public);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    if (auth.ctx.opaque_id !== parsed.opaque_id) return c.json({ error: '非本人信箱' }, 403);
    const ok = store.deleteEnvelope(parsed.opaque_id, envId);
    if (!ok) return c.json({ error: '信不存在' }, 404);
    return c.json({ deleted: true });
  });

  return app;
}

// ---------- 验签助手（仅公钥；与零知识军规相容） ----------

/** opaque_id = SHA-256(sig_public) 的 32 字节指纹（协议 §7；纯哈希无秘密材料） */
function keyIdOf(sigPublicB64: string): string {
  return Buffer.from(sha256(fromBase64(sigPublicB64))).toString('base64');
}

/** base64 是否解出恰好 len 字节（形状校验；不做语义判断） */
function isB64OfLen(b64: string, len: number): boolean {
  try {
    return fromBase64(b64).length === len;
  } catch {
    return false;
  }
}

function verifyEnvelopeSignature(card: MatchCardEnvelope): boolean {
  try {
    // 服务端只收 plaza_card（§10.5：无 key_l1）——签名对象恒为 meta + 两层/三层密文，
    // 不含 key_l1 分支（match_card 在 isPlazaCard 门闩处已被拒，此处不可达）
    const message = canonicalBytes({
      meta: card.meta,
      payload_L1: card.payload_L1,
      payload_L2: card.payload_L2,
      ...(card.payload_L3 ? { payload_L3: card.payload_L3 } : {}),
    });
    return ed25519.verify(fromBase64(card.signature), message, fromBase64(card.meta.sig_public));
  } catch {
    return false;
  }
}

function verifyMsgSignature(env: MsgEnvelope): boolean {
  try {
    const message = canonicalBytes({ meta: env.meta, payload: env.payload });
    return ed25519.verify(fromBase64(env.signature), message, fromBase64(env.meta.sig_public));
  } catch {
    return false;
  }
}
