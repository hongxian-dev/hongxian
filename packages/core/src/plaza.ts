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
 *    排除已看过。declared_filters（宪法 §3 分拣）推迟 Schema v0.5。
 */

import {
  DEFAULT_TTL_DAYS,
  MatchCardEnvelope,
  type CardMeta,
  canonicalBytes,
  isExpired,
  signatureObject,
  toBase64,
  uuidV7,
} from '@hongxian/schema';
import { verifyMatchCard, cardFingerprint } from './card/envelope.js';
import type { KeyProvider } from './types.js';

/** 广场卡轮廓（浏览态唯一可见信息——"有人在"，无内容） */
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
}

/** 过滤选项（全部本地状态，无任何服务端参与） */
export interface PlazaFilterOptions {
  /** 本方 opaque_id（排除自己） */
  my_opaque_id?: string;
  /** 已拉黑的 opaque_id 集合（姻缘线拉黑——D15④） */
  blocked_opaque_ids?: readonly string[];
  /** 已浏览过的 card_id 集合（避免重复呈报） */
  seen_card_ids?: readonly string[];
  now?: number;
}

export interface PlazaFilterResult {
  outlines: PlazaOutline[];
  /** 未通过过滤的原始卡（调用方决定是否存证） */
  passed: MatchCardEnvelope[];
  rejected: { card_id: string; reason: string }[];
}

/**
 * 派生广场卡变体（V6）：
 * match_card（含 key_l1，文件直交）→ plaza_card（无 key_l1，经服务端）。
 * 三层密文原样携带——L1 钥匙经 grant_l1 密封交付，"解锁一阶"成为显式授权动作。
 */
export function toPlazaCard(card: MatchCardEnvelope, key: KeyProvider, ttlDays: number = DEFAULT_TTL_DAYS): MatchCardEnvelope {
  const now = Date.now();
  const meta: CardMeta = {
    ...card.meta,
    card_id: uuidV7(),
    card_type: 'plaza_card',
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlDays * 24 * 3600 * 1000).toISOString(),
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
  };
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
  const outlines: PlazaOutline[] = [];
  const passed: MatchCardEnvelope[] = [];
  const rejected: { card_id: string; reason: string }[] = [];

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
      continue;
    }
    const card = v.card;
    if (card.meta.card_type !== 'plaza_card') {
      rejected.push({ card_id: card.meta.card_id, reason: '非广场卡变体' });
      continue;
    }
    if (isExpired(card.meta, now)) {
      rejected.push({ card_id: card.meta.card_id, reason: '已过期（TTL）' });
      continue;
    }
    if (options.my_opaque_id && card.meta.owner_key_id === options.my_opaque_id) {
      rejected.push({ card_id: card.meta.card_id, reason: '本方卡' });
      continue;
    }
    if (blocked.has(card.meta.owner_key_id)) {
      rejected.push({ card_id: card.meta.card_id, reason: '已拉黑的发件人' });
      continue;
    }
    if (seen.has(card.meta.card_id)) {
      rejected.push({ card_id: card.meta.card_id, reason: '已浏览过' });
      continue;
    }
    // 指纹与 server.cardFingerprintOf / core.cardFingerprint 同口径（纯哈希，无解密）
    const fp = cardFingerprint(card);
    outlines.push(plazaOutline(card, fp, now));
    passed.push(card);
  }
  return { outlines, passed, rejected };
}
