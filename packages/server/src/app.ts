/**
 * 红线平台服务 · HTTP 应用（API v1 终稿，工程设计 §6）
 *
 * 军规对照（每条都过邮局测试）：
 *   ❌ 无 /match、无 /recommend、无 /search——没有任何搜索/排序/评分端点
 *   ✅ 广场 = 哑管道：GET /v2/cards 返回全量池（cursor 分页），零过滤
 *   ✅ 投递只接受点对点定向地址；广播在协议层不可表达
 *   ✅ 无在线状态端点、无已读回执字段；发件方确认只到"已入信箱"
 *   ✅ 零知识：上传即验签 + 拒收携 key_l1 的广场卡（§10.5）
 *
 * 两条例外，都是显式的、都写进了协议：
 *   ① **发布许可**（C17 / D1 方案 B）：贴卡前要求该 opaque_id 已完成一次载体验证。
 *      这是"广场是公开列表"这一事实的代价，不是身份认证——正文与提示里从不声称是。
 *   ② **举报即断**（C2 / D7）：被举报者向举报者的投递一律沉底，且**双向闭合**
 *      （A 举报 B 之后，B 投不到 A，A 也投不到 B）。
 *      这是对"哑管道不拦截"的唯一让步；它不改广场列表、不做任何裁决——
 *      真正的裁决留在人工复核之后（见协议 §6.1 与《三条防护话术定稿》§3）。
 *      对发件人完全不可见：响应与正常投递逐字段一致，所以举报者不会被反推出来。
 *
 * 认证（auth.ts）：注册即持钥证明；拉取/删除类操作需签名认证头。
 * 注册与贴卡都验签（Ed25519 公钥）——服务端自始至终不持任何解密材料。
 *
 * 出网：全服务只有一个出网点（mailer.ts，发验证码）。除此之外零出网、零追踪。
 */

import { Hono } from 'hono';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_TTL_DAYS,
  MAX_DAILY_DELIVERIES,
  MsgEnvelope,
  PLAZA_PAGE_SIZE,
  PUBLISH_CHALLENGE_TTL_SEC,
  PUBLISH_CODE_LENGTH,
  PUBLISH_CODE_TTL_SEC,
  PUBLISH_DISCLOSURE_ACK_LABEL,
  PUBLISH_DISCLOSURE_BRIEF,
  PUBLISH_DISCLOSURE_TEXT,
  PUBLISH_DISCLOSURE_VERSION,
  PUBLISH_ERROR_CODES,
  PUBLISH_MAX_ATTEMPTS,
  PUBLISH_OTP_COOLDOWN_SEC,
  PUBLISH_OTP_PER_CARRIER_PER_DAY,
  PUBLISH_OTP_PER_IP_PER_HOUR,
  PUBLISH_OTP_PER_NONCE,
  PUBLISH_PERMIT_TTL_SEC,
  REPORT_REASONS,
  canonicalBytes,
  describeCarrierReject,
  fromBase64,
  isNonceShaped,
  isPermitShaped,
  isPlazaCard,
  normalizeCarrier,
  normalizePermit,
  parseAddress,
  permitFromBytes,
  validateEnvelope,
  type MatchCardEnvelope,
} from '@hongxian/schema';
import { ServerStore, cardFingerprintOf, type StoredCard, type StoredPublishChallenge } from './store.js';
import { AUTH_HEADER, verifyAuthHeader } from './auth.js';
import type { Mailer } from './mailer.js';

/**
 * 发布许可配置。
 *
 * `required` 与 `mailer` 的组合是被刻意允许的：自托管私有实例可以两者都关
 * （此时行为与 C17 之前完全一致）；但**要求验证却没有发信通道**是配置错误，
 * 服务端会以 503 明确说出来，而不是静默放行——静默放行等于防护不存在。
 */
export interface PublishConfig {
  required: boolean;
  mailer: Mailer | null;
  /** 官网验证页基地址（给月老拼链接用；缺省则由客户端按实例域名推导） */
  verifyBase?: string;
}

export interface ServerConfig {
  /** 本实例域名（v2.0：拒绝带外域后缀的投递，防静默误投） */
  instance: string;
  /** 缺省视为「不需要发布许可」——自托管者的默认值应当是最省事且不骗人的那个 */
  publish?: PublishConfig;
}

/** 广场卡 TTL 上限（服务端少一分持有少一分责任；默认 30 天的 3 倍封顶） */
const MAX_CARD_TTL_DAYS = DEFAULT_TTL_DAYS * 3;

export function createApp(store: ServerStore, config: ServerConfig): Hono {
  const app = new Hono();
  const publish = config.publish ?? { required: false, mailer: null };
  /**
   * IP 级发码限速：**只在内存里**，键是 IP 的 SHA-256 前 16 位。
   *
   * 为什么不是落盘计数：决策备忘 §5.1 明确要求"不留 IP"。
   * 落盘等于把 IP 变成了持久数据；内存键还做了哈希，进程重启即清零——
   * 代价是重启后限速重置（可接受：重启不是攻击者能触发的动作）。
   */
  const ipHits = new Map<string, number[]>();

  function bumpIp(ip: string | null, now: number): number {
    if (!ip) return 0; // 无法归因时不计数（反代后面取不到是常态）
    const key = Buffer.from(sha256(new TextEncoder().encode(`ip|${ip}`))).toString('hex').slice(0, 16);
    const windowStart = now - 3600_000;
    const hits = (ipHits.get(key) ?? []).filter((t) => t > windowStart);
    hits.push(now);
    ipHits.set(key, hits);
    if (ipHits.size > 10_000) ipHits.clear(); // 兜底：异常流量不至于把内存撑爆
    return hits.length;
  }

  function clientIp(c: { req: { header: (k: string) => string | undefined } }): string | null {
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0]!.trim() || null;
    return c.req.header('x-real-ip') ?? null;
  }

  // ---------- 健康检查（无状态、无计数、无追踪） ----------

  /**
   * 除了存活，还告诉客户端一件它能自己决定的事：这个实例要不要发布许可。
   * 客户端据此决定"贴卡前先带主人去验证"还是"直接贴"——
   * 不去猜、不去试错后看 403。
   */
  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      service: 'hongxian-plaza',
      instance: config.instance,
      publish: {
        required: publish.required,
        // 未配置通道时明确说出来：客户端据此告诉主人"这个实例暂时贴不了卡"，
        // 而不是让人反复试
        available: publish.mailer !== null,
        verify_base: publish.verifyBase ?? null,
      },
    }),
  );

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
    // 发布许可门闩（D1 方案 B）：只拦"贴到公开列表"这一个动作，其余一律不拦。
    // 只回答"验证过没有"，不回答"用哪个邮箱验证的"——服务端也不把后者交给任何人。
    if (publish.required) {
      if (!publish.mailer) {
        return c.json(
          {
            error: '本实例要求发布确认，但没有配置发信通道——这是运营方配置错误，不是你的问题。请联系实例运营者。',
            code: PUBLISH_ERROR_CODES.unavailable,
          },
          503,
        );
      }
      if (!store.hasPublishCredential(owner)) {
        return c.json(publishRequiredBody(), 403);
      }
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
    // 「举报即断」（D7 / C2②）：被举报者往举报者这里的投递一律沉底。
    //
    // 三个设计要点：
    //   ① 响应与正常投递**逐字段一致**（同状态码、同 id、同 entered_mailbox、不加人为延时）
    //      —— 任何可观测的差异都会让被举报者反推出"是谁举报了我"，把举报者置于报复风险。
    //      复用的是协议里既有的"静默拒绝"语义，不新增协议概念。
    //   ② 配额照扣（上面的 bumpDeliveryCount 在它之前）：否则"扣不扣次数"就成了一个探针。
    //   ③ 只沉底、不进广场列表、不做裁决 —— 邮局四军规里的"不评估"没被破。
    if (store.isBlocked(parsed.opaque_id, env.meta.owner_key_id)) {
      return c.json({ id: env.meta.card_id, entered_mailbox: true }, 201);
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

  // ---------- 发布许可（C17 / D1 方案 B：只对"贴卡到公开列表"要求载体可达） ----------

  /**
   * 披露声明（防护三 / C2③）：**公开、无需认证、无需安装工具**。
   *
   * 由服务端返回全文而不是客户端硬编码（《三条防护话术定稿》§4.4）——
   * 否则改一句措辞就要发一版客户端，而措辞恰恰是最常被要求修改的东西。
   * 版本号随文案一起返回，客户端按版本判定"用户看的是不是当前这份"。
   */
  app.get('/v2/publish/disclosure', (c) =>
    c.json({
      version: PUBLISH_DISCLOSURE_VERSION,
      full: PUBLISH_DISCLOSURE_TEXT,
      brief: PUBLISH_DISCLOSURE_BRIEF,
      ack_label: PUBLISH_DISCLOSURE_ACK_LABEL,
      /** 是否要求先确认再进验证流程——永远为 true：这段是"丑话要先说" */
      require_ack: true,
    }),
  );

  /**
   * 第一步：发验证码。**不认 opaque_id**——这个请求来自浏览器，浏览器没有密钥。
   *
   * 归属不是在这里建立的，而是在第四步 PUT /v2/publish/credential 时用持钥证明建立。
   * 这样"替他人验证"就需要同时拿到 nonce（月老生成的 128 位随机值）和许可码
   * （只显示在完成验证的那个浏览器里），而不是只要知道对方的公开 opaque_id 就行。
   */
  app.post('/v2/publish/otp', async (c) => {
    if (!publish.mailer) {
      return c.json(
        {
          error: '本实例没有配置发信通道，暂时无法完成发布确认——请稍后再试或联系实例运营者。',
          code: PUBLISH_ERROR_CODES.unavailable,
        },
        503,
      );
    }
    let body: { nonce?: string; carrier?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '请求体必须是 JSON' }, 400);
    }
    const nonce = body.nonce ?? '';
    if (!isNonceShaped(nonce)) {
      return c.json({ error: '本次验证标识不合法（请从月老给你的链接重新进入）' }, 400);
    }
    const norm = normalizeCarrier(body.carrier ?? '');
    if (!norm.ok) {
      // 拒绝原因是给人看的一句话（含"一次性邮箱不接收"这种需要解释的情况）
      return c.json({ error: describeCarrierReject(norm.reason) }, 400);
    }
    const now = Date.now();
    const carrierHmac = store.carrierHmac(norm.carrier);
    const day = new Date(now).toISOString().slice(0, 10);

    let challenge = store.getChallenge(nonce);
    if (challenge && now - Date.parse(challenge.created_at) > PUBLISH_CHALLENGE_TTL_SEC * 1000) {
      store.deleteChallenge(nonce);
      challenge = null;
    }
    if (!challenge) {
      challenge = { nonce, otp_sent: 0, attempts: 0, created_at: new Date(now).toISOString() };
    }
    if (challenge.otp_sent >= PUBLISH_OTP_PER_NONCE) {
      return c.json(
        { error: '这一个链接已经发过几次验证码了。为防刷信，请回月老重新执行一次 verify 拿新链接。', code: PUBLISH_ERROR_CODES.rateLimited },
        429,
      );
    }
    if (challenge.last_otp_at && now - Date.parse(challenge.last_otp_at) < PUBLISH_OTP_COOLDOWN_SEC * 1000) {
      const wait = Math.ceil((PUBLISH_OTP_COOLDOWN_SEC * 1000 - (now - Date.parse(challenge.last_otp_at))) / 1000);
      return c.json(
        { error: `刚发过一封，请等 ${wait} 秒再试（同一邮箱每分钟只能发一次）`, code: PUBLISH_ERROR_CODES.rateLimited },
        429,
      );
    }
    if (bumpIp(clientIp(c), now) > PUBLISH_OTP_PER_IP_PER_HOUR) {
      return c.json(
        { error: '这个网络一小时内的发码次数已到上限，请稍后再试。', code: PUBLISH_ERROR_CODES.rateLimited },
        429,
      );
    }
    if (store.bumpOtpCount(carrierHmac, day) > PUBLISH_OTP_PER_CARRIER_PER_DAY) {
      return c.json(
        { error: `同一邮箱每天最多发 ${PUBLISH_OTP_PER_CARRIER_PER_DAY} 封。今天已经用完了——明天再试，或换一个常用邮箱。`, code: PUBLISH_ERROR_CODES.rateLimited },
        429,
      );
    }

    const code = String(randomInt(0, 10 ** PUBLISH_CODE_LENGTH)).padStart(PUBLISH_CODE_LENGTH, '0');
    const next: StoredPublishChallenge = {
      ...challenge,
      carrier_hmac: carrierHmac,
      code_hmac: store.publishCodeTag(nonce, code),
      code_expires_at: new Date(now + PUBLISH_CODE_TTL_SEC * 1000).toISOString(),
      otp_sent: challenge.otp_sent + 1,
      last_otp_at: new Date(now).toISOString(),
    };
    store.putChallenge(next);

    const sent = await publish.mailer.sendPublishCode(norm.carrier, code);
    if (!sent.ok) {
      // 发信失败要明确说、不许静默：把码作废（用户手上没有它），保留冷却让重试有节奏
      store.putChallenge({ ...next, code_hmac: undefined, code_expires_at: undefined });
      return c.json(
        { error: `验证码没能发出去（${sent.error}）。请一两分钟后再点一次"发送验证码"。`, code: PUBLISH_ERROR_CODES.unavailable },
        503,
      );
    }
    return c.json({ sent: true, expires_in: PUBLISH_CODE_TTL_SEC }, 201);
  });

  /**
   * 第二步：填验证码 → 换来一次性的「发布许可码」。
   *
   * 错误提示刻意不区分"码错了"和"码过期了"（防枚举）；但连续错 5 次之后
   * 会明确说"这个链接作废了，重新来"——那是事实，藏着只会让人反复试。
   */
  app.post('/v2/publish/verify', async (c) => {
    let body: { nonce?: string; code?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '请求体必须是 JSON' }, 400);
    }
    const nonce = body.nonce ?? '';
    if (!isNonceShaped(nonce)) {
      return c.json({ error: '本次验证标识不合法（请从月老给你的链接重新进入）' }, 400);
    }
    const code = (body.code ?? '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) {
      return c.json({ error: '验证码是 6 位数字，请对照邮件再填一次。', code: PUBLISH_ERROR_CODES.codeInvalid }, 400);
    }
    const now = Date.now();
    const challenge = store.getChallenge(nonce);
    const createdOk = challenge && now - Date.parse(challenge.created_at) <= PUBLISH_CHALLENGE_TTL_SEC * 1000;
    if (!challenge || !createdOk || !challenge.code_hmac || !challenge.carrier_hmac) {
      return c.json(
        { error: '这个链接已经失效了（超过 30 分钟）。请回月老重新执行一次 verify。', code: PUBLISH_ERROR_CODES.codeExpired },
        400,
      );
    }
    if (challenge.attempts >= PUBLISH_MAX_ATTEMPTS) {
      return c.json(
        { error: '这个链接的验证码错太多次，已作废。请回月老重新执行一次 verify 拿新链接。', code: PUBLISH_ERROR_CODES.tooManyAttempts },
        429,
      );
    }
    if (!challenge.code_expires_at || Date.parse(challenge.code_expires_at) <= now) {
      return c.json(
        { error: '验证码过期了（有效期 5 分钟）。请点"重新发送"。', code: PUBLISH_ERROR_CODES.codeExpired },
        400,
      );
    }
    if (!tagEqual(store.publishCodeTag(nonce, code), challenge.code_hmac)) {
      const attempts = challenge.attempts + 1;
      store.putChallenge({ ...challenge, attempts });
      const left = PUBLISH_MAX_ATTEMPTS - attempts;
      return c.json(
        {
          error: left > 0 ? `验证码不对。还可以再试 ${left} 次。` : '验证码不对，这个链接已作废。请回月老重新执行一次 verify。',
          code: PUBLISH_ERROR_CODES.codeInvalid,
        },
        400,
      );
    }

    const permit = permitFromBytes(randomBytes(24));
    store.putChallenge({
      ...challenge,
      // 验证码用过即焚：一封邮件只能换一次许可码
      code_hmac: undefined,
      code_expires_at: undefined,
      verified_at: new Date(now).toISOString(),
      permit_hmac: store.publishPermitTag(nonce, permit),
      permit_expires_at: new Date(now + PUBLISH_PERMIT_TTL_SEC * 1000).toISOString(),
    });
    return c.json({ permit, expires_in: PUBLISH_PERMIT_TTL_SEC });
  });

  /**
   * 第三步：把许可码换成发布许可。**这一步要持钥证明**——归属在此刻建立。
   *
   * 一对一约束是双向的：一个载体只能绑一个密钥（防一人多号刷广场），
   * 一个密钥也只能绑一个载体（防一人囤积邮箱）。
   */
  app.put('/v2/publish/credential', async (c) => {
    const header = c.req.header(AUTH_HEADER);
    const provisional = header?.split(':')[0];
    const identity = provisional ? store.getIdentity(provisional) : null;
    if (!identity) return c.json({ error: '身份未注册（先注册再来贴卡）' }, 401);
    const action = 'PUT /v2/publish/credential';
    const auth = verifyAuthHeader(header, action, identity.sig_public);
    if (!auth.ok) return c.json({ error: `认领发布许可需持钥证明：${auth.error}` }, 401);

    let body: { nonce?: string; permit?: string; disclosure_version?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '请求体必须是 JSON' }, 400);
    }
    const nonce = body.nonce ?? '';
    const permit = normalizePermit(body.permit ?? '');
    if (!isNonceShaped(nonce) || !isPermitShaped(permit)) {
      return c.json(
        { error: '许可码不对——它是 8 位字母数字（不含 0/O/1/I/L），在验证页最后一步显示。', code: PUBLISH_ERROR_CODES.permitInvalid },
        400,
      );
    }
    const now = Date.now();
    const challenge = store.getChallenge(nonce);
    if (!challenge || !challenge.verified_at || !challenge.permit_hmac || !challenge.carrier_hmac) {
      return c.json(
        { error: '这次验证在服务端已经不存在了（可能已用过或已过期）。请重新走一遍 verify。', code: PUBLISH_ERROR_CODES.permitInvalid },
        409,
      );
    }
    if (!challenge.permit_expires_at || Date.parse(challenge.permit_expires_at) <= now) {
      return c.json(
        { error: '许可码过期了（有效期 10 分钟）。请重新走一遍 verify。', code: PUBLISH_ERROR_CODES.permitInvalid },
        409,
      );
    }
    if (!tagEqual(store.publishPermitTag(nonce, permit), challenge.permit_hmac)) {
      return c.json({ error: '许可码不对，请对照网页上显示的内容重新抄一遍。', code: PUBLISH_ERROR_CODES.permitInvalid }, 403);
    }

    const owner = auth.ctx.opaque_id;
    const byCarrier = store.findPublishCredentialByCarrier(challenge.carrier_hmac);
    if (byCarrier && byCarrier.owner_key_id !== owner) {
      return c.json(
        {
          error: '这个邮箱已经绑定过另一个密钥了。一个邮箱只能确认一个身份（防一个人用同一个邮箱刷满广场）。换一个邮箱，或让原来那个身份先解绑。',
          code: PUBLISH_ERROR_CODES.carrierTaken,
        },
        409,
      );
    }
    const mine = store.getPublishCredential(owner);
    if (mine && mine.carrier_hmac !== challenge.carrier_hmac) {
      return c.json(
        {
          error: '这个密钥已经确认过另一个邮箱了。一个密钥也只绑一个邮箱——要先解绑（plaza_publish action=unbind）才能换。',
          code: PUBLISH_ERROR_CODES.ownerTaken,
        },
        409,
      );
    }

    const cred = store.putPublishCredential(owner, challenge.carrier_hmac, body.disclosure_version, now);
    store.deleteChallenge(nonce); // 许可码一次性：认领完成即焚
    return c.json({ verified: true, verified_at: cred.verified_at }, 201);
  });

  /** 查自己有没有发布许可（只回答"有没有"，不回答"用哪个邮箱"——服务端也不留那个明文） */
  app.get('/v2/publish/credential', (c) => {
    const header = c.req.header(AUTH_HEADER);
    const provisional = header?.split(':')[0];
    const identity = provisional ? store.getIdentity(provisional) : null;
    if (!identity) return c.json({ error: '身份未注册' }, 401);
    const action = 'GET /v2/publish/credential';
    const auth = verifyAuthHeader(header, action, identity.sig_public);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    const cred = store.getPublishCredential(auth.ctx.opaque_id);
    return c.json({
      verified: cred !== null,
      verified_at: cred?.verified_at,
      // 只回版本号（不回载体）：客户端据此判断"这个人当初看到的是哪一版丑话"，
      // 换设备重装时也能知道自己确认过哪一版
      disclosure_version: cred?.disclosure_version,
      current_disclosure_version: PUBLISH_DISCLOSURE_VERSION,
    });
  });

  /**
   * 解绑：失去贴卡能力，历史卡片保留（不追溯下架——别人已经存证的卡撤不回来，
   * 假装能撤只会让主人以为"解绑等于隐身"）。
   */
  app.delete('/v2/publish/credential', (c) => {
    const header = c.req.header(AUTH_HEADER);
    const provisional = header?.split(':')[0];
    const identity = provisional ? store.getIdentity(provisional) : null;
    if (!identity) return c.json({ error: '身份未注册' }, 401);
    const action = 'DELETE /v2/publish/credential';
    const auth = verifyAuthHeader(header, action, identity.sig_public);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    const removed = store.deleteCredential(auth.ctx.opaque_id);
    return c.json({
      unbound: removed,
      note: removed
        ? '已解绑：从现在起不能再贴新卡。已经贴在广场上的卡会被撤下，但别人此前存证过的卡撤不回来。'
        : '本来就没有绑定记录——无需解绑。',
    });
  });

  // ---------- 举报（行为信号；永不上传信件内容） ----------

  /**
   * 举报：只接受"对某个 opaque ID 的行为信号"，理由为受控枚举。
   *
   * 为什么这样设计（零知识的代价，必须诚实）：
   * - 服务端读不到信件，所以**没法审核证据**——能做的只有数独立举报人数；
   * - 举报人也签名认证（防伪造举报刷标记），但其身份以加盐假名落盘，
   *   数据目录被拖走也反查不出"谁举报了谁"；
   * - 越过阈值只代表"值得运营者看一眼"，不代表平台裁决——联邦制下用户可换实例。
   */
  app.post('/v2/reports', async (c) => {
    let body: { target_opaque_id?: string; reason_code?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '请求体必须是 JSON' }, 400);
    }
    const { target_opaque_id, reason_code } = body;
    if (!target_opaque_id || !reason_code) {
      return c.json({ error: '缺少 target_opaque_id / reason_code' }, 400);
    }
    if (!(REPORT_REASONS as readonly string[]).includes(reason_code)) {
      return c.json({ error: `reason_code 必须取自受控枚举：${REPORT_REASONS.join(' / ')}` }, 400);
    }
    const action = 'POST /v2/reports';
    const header = c.req.header(AUTH_HEADER);
    const provisional = header?.split(':')[0];
    const reporter = provisional ? store.getIdentity(provisional) : null;
    if (!reporter) return c.json({ error: '举报人身份未注册' }, 401);
    const auth = verifyAuthHeader(header, action, reporter.sig_public);
    if (!auth.ok) return c.json({ error: `举报需持钥证明：${auth.error}` }, 401);
    if (auth.ctx.opaque_id === target_opaque_id) {
      return c.json({ error: '不能举报自己' }, 400);
    }
    if (!store.getIdentity(target_opaque_id)) {
      return c.json({ error: '被举报对象不在本实例' }, 404);
    }
    const summary = store.addReport(target_opaque_id, auth.ctx.opaque_id, reason_code);
    // 举报即断（D7 / C2②）：**立即生效，不等阈值**，并且**双向闭合**。
    // 单向阻断会留下"举报了还能继续试探"的漏洞；双向之后这对线就彻底断了。
    // 注意这里不通知被举报者、也不从广场摘卡——裁决留在人工复核之后。
    store.putBlock(auth.ctx.opaque_id, target_opaque_id, reason_code);
    store.putBlock(target_opaque_id, auth.ctx.opaque_id, reason_code);
    // 回执只给汇总，不透露举报人是谁（连"是不是熟人举报"都不给）
    return c.json({ recorded: true, summary, immediate_block: true }, 201);
  });

  /**
   * 查看"我"的举报汇总：只有被举报者本人可查（持钥认证）。
   * 别人查不了任何人——否则举报计数会变成公开羞辱工具。
   */
  app.get('/v2/reports/:opaqueId', (c) => {
    const opaqueId = c.req.param('opaqueId');
    const identity = store.getIdentity(opaqueId);
    if (!identity) return c.json({ error: '身份不存在' }, 404);
    const action = `GET /v2/reports/${opaqueId}`;
    const auth = verifyAuthHeader(c.req.header(AUTH_HEADER), action, identity.sig_public);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    if (auth.ctx.opaque_id !== opaqueId) return c.json({ error: '只能查看自己的举报汇总' }, 403);
    return c.json({ summary: store.getReportSummary(opaqueId) });
  });

  // ---------- 透明度（M4：匿名聚合，公开只读） ----------

  /**
   * 实例匿名聚合：身份数 / 贴卡数 / 信封数 / 被举报目标数。
   * 不含任何一个 opaque ID、不含任何内容、不含活跃度明细——
   * 与网站透明数据区同一条纪律：只公开能公开的总和。
   */
  app.get('/v2/stats', (c) => {
    const s = store.stats();
    return c.json({ ...s, instance: config.instance });
  });

  return app;
}

// ---------- 验签助手（仅公钥；与零知识军规相容） ----------

/**
 * 定长摘要比较（常数时间）。
 *
 * 摘要由 HMAC 得出，长度固定 32 hex；先比长度再 timingSafeEqual，
 * 避免长度不等时抛异常——但长度不等本身也不泄露信息（两种摘要都是定长）。
 */
function tagEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
  } catch {
    return false;
  }
}

/**
 * 贴卡被拒时的响应体。
 *
 * 三条纪律：① 说清"下一步做什么"，不是甩一个错误码；② 不透露服务端内部状态
 * （不说是哪个邮箱、不说还有几天、不说"你可以贴几张"）；③ 不把这一步说成实名认证——
 * 它不是，说了就是骗人，而骗人这件事在第一次事故里就会被翻出来。
 */
function publishRequiredBody() {
  return {
    error: '广场是公开列表，贴卡前要先确认一个邮箱能收信——这个密钥还没做过这一步。',
    code: PUBLISH_ERROR_CODES.requiresVerification,
    why: '只为了两件事：防止一个人刷满广场；出问题时留一个处置入口。这不验证你是谁，我们也不声称验证了。',
    how: [
      '在月老里执行 plaza_publish action=verify，它会给你一个网页链接；',
      '在网页里填邮箱、收验证码，网页会显示一串 8 位「发布许可码」；',
      '回到月老执行 plaza_publish action=claim，把许可码填进去；',
      '然后重新贴卡。',
    ],
    still_works: '不想验证也完全没关系：出卡、导出、点对点投递、收卡、比对、深聊、见面——全都不需要这一步。只有"贴到公开广场"需要。',
  };
}

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
