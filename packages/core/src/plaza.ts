/**
 * 广场客户端逻辑（平台服务工程设计 V1/V6/V9——纯函数，零 IO）
 *
 * v2.0 广场 = 哑管道：服务端零过滤零排序，一切分拣在客户端本地完成。
 * 本模块是客户端侧纯逻辑的三件套：
 *
 * 1. toPlazaCard——把已签发的 match_card 派生为 plaza_card 变体：
 *    剥离 key_l1（零知识军规，服务端不得持有可解密 L1 的材料）、
 *    换 card_id、card_type 改标、重新签名；三层密文原样保留
 *    （同套层密钥加密，grant_l1 交付钥匙后可直接解密——V6 解法）。
 * 2. plazaOutline——从已验证的广场卡提取"轮廓"：只能看到有人在
 *    （opaque_id / 公钥 / TTL / 指纹），看不到任何内容。
 * 3. filterPlazaPool——本地过滤：验签 + TTL + 排除自己 + 排除已拉黑 +
 *    排除已看过 + **声明式圈层（D8，v0.5）**：先看对方允许谁看见（圈 B），
 *    再看是否落在我的检索声明里（圈 A，含双向方向性）。
 *    服务端依旧零过滤零排序——圈层是"用户自己声明的粗条件"，不是服务端分拣。
 */

import {
  DEFAULT_TTL_DAYS,
  MatchCardEnvelope,
  type CardMeta,
  type DeclaredFilters,
  canonicalBytes,
  isExpired,
  signatureObject,
  toBase64,
  uuidV7,
} from '@hongxian/schema';
import { verifyMatchCard, cardFingerprint } from './card/envelope.js';
import type { KeyProvider } from './types.js';

/** 广场卡轮廓（浏览态可见信息——"有人在" + 主人自己声明要公开的圈层条件） */
export interface PlazaOutline {
  card_id: string;
  /** opaque_id = owner_key_id（公钥指纹，协议 §7）——信箱寻址用 */
  opaque_id: string;
  sig_public: string;
  kx_public: string;
  /** 卡指纹（SHA-256(canonical) 前 16 hex）——grant_l1 定位用 */
  fingerprint: string;
  expires_at: string;
  ttl_remaining_ms: number;
  has_l3: boolean;
  depth: CardMeta['depth'];
  /**
   * 主人声明的圈层条件（v0.5，明文且已签名）。
   * 这不是画像内容——是主人自己选择要公开的检索条件；仍看不到昵称、职业、照片。
   */
  declared_filters?: DeclaredFilters;
}

/** 过滤选项（全部本地状态，无任何服务端参与） */
export interface PlazaFilterOptions {
  /** 本方 opaque_id（排除自己） */
  my_opaque_id?: string;
  /** 已拉黑的 opaque_id 集合（姻缘线拉黑——D15④） */
  blocked_opaque_ids?: readonly string[];
  /** 已浏览过的 card_id 集合（避免重复呈报） */
  seen_card_ids?: readonly string[];
  /**
   * 拉取条件圈 A（D8）：我声明想看的范围。
   * 缺省 = 不筛（全量看）。任一字段缺失即不据此筛——但**我声明了要求而对方没声明时，
   * 按"无法确认"排除**（否则筛选形同虚设）。
   */
  my_filters?: DeclaredFilters;
  /** 是否尊重对方可见性声明圈 B（默认 true；关掉仅用于调试） */
  respect_visibility?: boolean;
  now?: number;
}

export interface PlazaFilterResult {
  outlines: PlazaOutline[];
  /** 未通过过滤的原始卡（调用方决定是否存证） */
  passed: MatchCardEnvelope[];
  rejected: { card_id: string; reason: string }[];
  /** 分项计数（给月老解释"为什么少"——不许含糊其辞） */
  stats: { visibility: number; circle: number; other: number };
}

/**
 * 派生广场卡变体（V6）：
 * match_card（含 key_l1，文件直交）→ plaza_card（无 key_l1，经服务端）。
 * 三层密文原样携带——L1 钥匙经 grant_l1 密封交付，"解锁一阶"成为显式授权动作。
 */
export function toPlazaCard(
  card: MatchCardEnvelope,
  key: KeyProvider,
  ttlDays: number = DEFAULT_TTL_DAYS,
  declared?: DeclaredFilters,
): MatchCardEnvelope {
  const now = Date.now();
  const meta: CardMeta = {
    ...card.meta,
    card_id: uuidV7(),
    card_type: 'plaza_card',
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlDays * 24 * 3600 * 1000).toISOString(),
    // v0.5：圈层声明进 meta（明文、被签名）。未声明则整字段缺省——
    // 不写空对象（schema 拒绝空对象，且空声明只会误导对方以为你声明了范围）。
    ...(declared && Object.keys(declared).length > 0 ? { declared_filters: declared } : {}),
  };
  const plaza = {
    meta,
    payload_L1: card.payload_L1,
    payload_L2: card.payload_L2,
    ...(card.payload_L3 ? { payload_L3: card.payload_L3 } : {}),
  };
  const signature = toBase64(key.sign(canonicalBytes(signatureObject(plaza))));
  return { ...plaza, signature };
}

/** 轮廓提取（调用方需先验签——本函数只看结构，不重验） */
export function plazaOutline(card: MatchCardEnvelope, fingerprint: string, now: number = Date.now()): PlazaOutline {
  return {
    card_id: card.meta.card_id,
    opaque_id: card.meta.owner_key_id,
    sig_public: card.meta.sig_public,
    kx_public: card.meta.kx_public,
    fingerprint,
    expires_at: card.meta.expires_at,
    ttl_remaining_ms: Date.parse(card.meta.expires_at) - now,
    has_l3: card.payload_L3 !== undefined,
    depth: card.meta.depth,
    ...(card.meta.declared_filters ? { declared_filters: card.meta.declared_filters } : {}),
  };
}

/**
 * 可见性声明圈 B（D8）：对方写了"只对同城/同年龄段可见"，我是否满足？
 * 无法确认（任一侧没声明）时按**不满足**处理——声明了限制却对所有人可见，
 * 等于这条限制不存在。
 */
function visibilityAllows(
  theirs: DeclaredFilters | undefined,
  mine: DeclaredFilters | undefined,
): { ok: true } | { ok: false; reason: string } {
  const scope = theirs?.visible_to ?? 'all';
  if (scope === 'all') return { ok: true };
  if (scope === 'same_city') {
    if (!theirs?.city) return { ok: true }; // 声明了限制却没给城市 → 无从执行，按不限处理
    if (!mine?.city) return { ok: false, reason: '对方声明仅同城可见（你未声明城市，无法互认）' };
    return mine.city === theirs.city
      ? { ok: true }
      : { ok: false, reason: '对方声明仅同城可见（城市不匹配）' };
  }
  // same_age_band
  if (!theirs?.age_band) return { ok: true };
  if (!mine?.age_band) return { ok: false, reason: '对方声明仅同年龄段可见（你未声明年龄段，无法互认）' };
  return mine.age_band === theirs.age_band
    ? { ok: true }
    : { ok: false, reason: '对方声明仅同年龄段可见（年龄段不匹配）' };
}

/**
 * 拉取条件圈 A（D8）：我声明想看的范围，对方是否落在这个圈里。
 * 方向性双向校验：我要的性别 = 对方性别，且对方要的性别 = 我的性别。
 * （单向过滤会产出"我看到了他、他看不到我"的错配，正是 D8 要消灭的东西。）
 */
function circleAllows(
  theirs: DeclaredFilters | undefined,
  mine: DeclaredFilters | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!mine || Object.keys(mine).length === 0) return { ok: true };
  if (mine.city) {
    if (!theirs?.city) return { ok: false, reason: '未声明城市（你的拉取条件要求同城，无法确认）' };
    if (theirs.city !== mine.city) return { ok: false, reason: '不在你的城市范围' };
  }
  if (mine.age_band) {
    if (!theirs?.age_band) return { ok: false, reason: '未声明年龄段（你的拉取条件要求年龄段，无法确认）' };
    if (theirs.age_band !== mine.age_band) return { ok: false, reason: '不在你的年龄段范围' };
  }
  // 方向性：正反都要对得上（D5 铁律②的广场版——对称，不许单向窥探）
  if (mine.seeking) {
    if (!theirs?.gender) return { ok: false, reason: '未声明性别（无法确认匹配方向）' };
    if (theirs.gender !== mine.seeking) return { ok: false, reason: '性别方向不符（你的择偶方向）' };
  }
  if (mine.gender) {
    if (!theirs?.seeking) return { ok: false, reason: '未声明择偶方向（无法确认对方是否在找你这类）' };
    if (theirs.seeking !== mine.gender) return { ok: false, reason: '性别方向不符（对方的择偶方向）' };
  }
  return { ok: true };
}

/**
 * 哑管道池的客户端过滤：验签（§7.4 不过即废）→ TTL → 去自己去黑去重。
 * 返回轮廓 + 通过过滤的原始卡（调用方落盘存证）。
 */
export function filterPlazaPool(
  rawCards: readonly unknown[],
  options: PlazaFilterOptions = {},
): PlazaFilterResult {
  const now = options.now ?? Date.now();
  const blocked = new Set(options.blocked_opaque_ids ?? []);
  const seen = new Set(options.seen_card_ids ?? []);
  const respectVisibility = options.respect_visibility ?? true;
  const outlines: PlazaOutline[] = [];
  const passed: MatchCardEnvelope[] = [];
  const rejected: { card_id: string; reason: string }[] = [];
  const stats = { visibility: 0, circle: 0, other: 0 };

  for (const raw of rawCards) {
    let cardId = '(无法解析)';
    try {
      const parsed = raw as { meta?: { card_id?: string } };
      if (parsed?.meta?.card_id) cardId = parsed.meta.card_id;
    } catch {
      /* 结构畸形走验签分支统一处理 */
    }
    const v = verifyMatchCard(raw);
    if (!v.valid || !v.card) {
      rejected.push({ card_id: cardId, reason: v.errors[0] ?? '验签失败' });
      stats.other++;
      continue;
    }
    const card = v.card;
    if (card.meta.card_type !== 'plaza_card') {
      rejected.push({ card_id: card.meta.card_id, reason: '非广场卡变体' });
      stats.other++;
      continue;
    }
    if (isExpired(card.meta, now)) {
      rejected.push({ card_id: card.meta.card_id, reason: '已过期（TTL）' });
      stats.other++;
      continue;
    }
    if (options.my_opaque_id && card.meta.owner_key_id === options.my_opaque_id) {
      rejected.push({ card_id: card.meta.card_id, reason: '本方卡' });
      stats.other++;
      continue;
    }
    if (blocked.has(card.meta.owner_key_id)) {
      rejected.push({ card_id: card.meta.card_id, reason: '已拉黑的发件人' });
      stats.other++;
      continue;
    }
    if (seen.has(card.meta.card_id)) {
      rejected.push({ card_id: card.meta.card_id, reason: '已浏览过' });
      stats.other++;
      continue;
    }
    // 圈层过滤（D8）：先看对方允许谁看见（圈 B），再看是否落在我的条件里（圈 A）。
    // 两圈都在本地算——服务端从头到尾不参与（哑管道，V1）。
    const theirs = card.meta.declared_filters;
    if (respectVisibility) {
      const vis = visibilityAllows(theirs, options.my_filters);
      if (!vis.ok) {
        rejected.push({ card_id: card.meta.card_id, reason: vis.reason });
        stats.visibility++;
        continue;
      }
    }
    const circle = circleAllows(theirs, options.my_filters);
    if (!circle.ok) {
      rejected.push({ card_id: card.meta.card_id, reason: circle.reason });
      stats.circle++;
      continue;
    }
    // 指纹与 server.cardFingerprintOf / core.cardFingerprint 同口径（纯哈希，无解密）
    const fp = cardFingerprint(card);
    outlines.push(plazaOutline(card, fp, now));
    passed.push(card);
  }
  return { outlines, passed, rejected, stats };
}
