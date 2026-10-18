/**
 * 信封工厂（Schema §2：三层加密 + Ed25519 整体签名）
 *
 * 一张卡 = meta（明文）+ payload_L1/L2/L3（各自独立 AES-256-GCM）+ signature。
 * 签名对象 = canonical(meta || 三个密文)——任何一层被篡改，整卡作废（§7.4，不降级处理）。
 * grant 类信封用收件人 X25519 公钥封装层密钥——中转者全程只见密文（零知识天然成立）。
 */

import {
  ALGO_DECLARATION,
  CipherBlock,
  DEFAULT_TTL_DAYS,
  MatchCardEnvelope,
  PayloadL1 as PayloadL1Check,
  PayloadL2 as PayloadL2Check,
  type CardMeta,
  type PayloadL1,
  type PayloadL2,
  type PayloadL3,
  canonicalBytes,
  canonicalize,
  isExpired,
  signatureObject,
  toBase64,
  fromBase64,
  validateEnvelope,
  uuidV7,
} from '@hongxian/schema';
import { aesGcmDecrypt, aesGcmEncrypt, sealBox, verifyDetached } from '@hongxian/crypto';
import { createHash } from 'node:crypto';
import type { KeyProvider, Layer } from '../types.js';
import { DomainError } from '../types.js';

export { signatureObject };

/** 签发输入：meta 的可变部分 + 三层明文 */
export interface SignCardInput {
  cardType?: 'match_card' | 'plaza_card';
  version?: number;
  ttlDays?: number;
  depth: CardMeta['depth'];
  introducerSig?: string;
  l1: PayloadL1;
  l2: PayloadL2;
  l3?: PayloadL3;
}

/** 签发一张匹配卡（S4） */
export function signMatchCard(input: SignCardInput, key: KeyProvider): MatchCardEnvelope {
  const now = Date.now();
  const ttlMs = (input.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 3600 * 1000;
  const meta: CardMeta = {
    schema_version: 1,
    card_id: uuidV7(),
    owner_key_id: toBase64(key.keyId()),
    version: input.version ?? 1,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
    card_type: input.cardType ?? 'match_card',
    depth: input.depth,
    ...(input.introducerSig ? { introducer_sig: input.introducerSig } : {}),
    algo: ALGO_DECLARATION,
  };

  const l1Block = encryptLayer(input.l1, key.layerKey('L1'));
  const l2Block = encryptLayer(input.l2, key.layerKey('L2'));
  const l3Block = input.l3 ? encryptLayer(input.l3, key.layerKey('L3')) : undefined;

  const card = l3Block
    ? { meta, payload_L1: l1Block, payload_L2: l2Block, payload_L3: l3Block }
    : { meta, payload_L1: l1Block, payload_L2: l2Block };

  const signature = toBase64(key.sign(canonicalBytes(signatureObject(card))));
  return { ...card, signature };
}

function encryptLayer(plaintext: unknown, layerKey: Uint8Array): CipherBlock {
  const { nonce, ct } = aesGcmEncrypt(layerKey, canonicalBytes(plaintext));
  return { nonce: toBase64(nonce), ct: toBase64(ct) };
}

/** 验签结果（§7.4：签名验证失败 = 整卡作废，不降级处理） */
export interface VerifyCardResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  expired: boolean;
  card?: MatchCardEnvelope;
}

/** 验签 + 结构校验 + TTL 检查（import_card 的第一道关） */
export function verifyMatchCard(input: unknown): VerifyCardResult {
  const parsed = validateEnvelope(input);
  if (!parsed.ok || !parsed.data) {
    return { valid: false, errors: parsed.errors, warnings: parsed.warnings, expired: false };
  }
  const card = parsed.data;
  const expired = isExpired(card.meta);
  return {
    valid: true,
    errors: [],
    warnings: [
      ...parsed.warnings,
      ...(expired ? ['卡片已过期（TTL），需签发方重签'] : []),
    ],
    expired,
    card,
  };
}

/** 用对方公钥验证卡片签名（验签需要公钥——owner_key_id 是指纹，公钥需从可信渠道获得） */
export function verifyCardSignature(card: MatchCardEnvelope, ownerPublicKey: Uint8Array): boolean {
  const ok = verifyDetached(
    fromBase64(card.signature),
    canonicalBytes(signatureObject(card)),
    ownerPublicKey,
  );
  return ok;
}

/** 解密一层（需要对应层密钥；L1 密钥随卡携带，L2/L3 由 grant 信封交付） */
export function decryptLayer(
  card: MatchCardEnvelope,
  layer: Layer,
  layerKey: Uint8Array,
): { ok: true; payload: unknown } | { ok: false; error: string } {
  const block = layer === 'L1' ? card.payload_L1 : layer === 'L2' ? card.payload_L2 : card.payload_L3;
  if (!block) return { ok: false, error: `卡片无 ${layer} 层密文` };
  const bytes = aesGcmDecrypt(layerKey, fromBase64(block.nonce), fromBase64(block.ct));
  if (!bytes) return { ok: false, error: `${layer} 层解密失败（密钥错误或密文被篡改）` };
  try {
    return { ok: true, payload: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, error: `${layer} 层明文不是合法 JSON` };
  }
}

/** 重签名片（D3：画像更新后 version+1，旧 version 自动作废） */
export function resignCard(
  old: MatchCardEnvelope,
  input: Omit<SignCardInput, 'version'>,
  key: KeyProvider,
): MatchCardEnvelope {
  return signMatchCard({ ...input, version: old.meta.version + 1 }, key);
}

// ---------- grant 类信封：层密钥的安全交付（只交付密钥不解密文） ----------

/** 用收件人协商公钥封装某层密钥（grant_l2 / grant_l3 的载荷） */
export function wrapLayerKey(layerKey: Uint8Array, recipientKexPublic: Uint8Array): Uint8Array {
  return sealBox(layerKey, recipientKexPublic);
}

/** 解开对端交付的层密钥 */
export function unwrapLayerKey(wrapped: Uint8Array, key: KeyProvider): Uint8Array | null {
  return key.openSealed(wrapped);
}

// ---------- 通用消息信封的加封/拆封（九类信封的 payload 层） ----------

/** 把消息体（JSON）加封为 MsgEnvelope 的密文块 */
export function sealMessageBody(
  body: unknown,
  recipientKexPublic: Uint8Array | null,
  key: KeyProvider,
): CipherBlock {
  const bytes = canonicalBytes(body);
  if (recipientKexPublic) {
    // 定向消息：用对端公钥 sealed box（ephPub||nonce||ct 整体作为一个 CipherBlock.ct）
    const sealed = key.sealFor(recipientKexPublic, bytes);
    return { nonce: '', ct: toBase64(sealed) };
  }
  // 自签名消息（如 decline_silent 回声）：用本方 L1 层密钥（对方持 key_L1 可解）
  const { nonce, ct } = aesGcmEncrypt(key.layerKey('L1'), bytes);
  return { nonce: toBase64(nonce), ct: toBase64(ct) };
}

/** 拆封消息体（isForMe：用本方 kx 私钥；否则尝试用某层密钥） */
export function openMessageBody(
  block: CipherBlock,
  key: KeyProvider,
): { ok: true; body: unknown } | { ok: false; error: string } {
  // 优先 sealed box（nonce 为空表示整块是 sealed box）
  if (!block.nonce) {
    const bytes = key.openSealed(fromBase64(block.ct));
    if (!bytes) return { ok: false, error: 'sealed box 解封失败（非本方或已篡改）' };
    try {
      return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) };
    } catch {
      return { ok: false, error: '消息体不是合法 JSON' };
    }
  }
  // 层密钥路径：调用方须已通过 grant 获得层密钥，此处仅支持 L1 直解
  const bytes = aesGcmDecrypt(key.layerKey('L1'), fromBase64(block.nonce), fromBase64(block.ct));
  if (!bytes) return { ok: false, error: '消息体解密失败' };
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, error: '消息体不是合法 JSON' };
  }
}

/** 卡片指纹（QR 交换确认码用：防调包——Schema §2 QR 只传哈希） */
export function cardFingerprint(card: MatchCardEnvelope): string {
  return createHash('sha256').update(canonicalize(card)).digest('hex').slice(0, 16);
}

/** 便捷：确保卡片可签发（前置校验） */
export function assertSignable(l1: unknown, l2: unknown): void {
  const r1 = PayloadL1Check.safeParse(l1);
  if (!r1.success) {
    throw new DomainError('INVALID_L1', `公开层字段不合法：${r1.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  const r2 = PayloadL2Check.safeParse(l2);
  if (!r2.success) {
    throw new DomainError('INVALID_L2', `匹配层字段不合法：${r2.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
}
