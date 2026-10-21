/**
 * 红线密钥体系 · 原语：Ed25519 身份签名 / X25519 密钥交换 / AES-256-GCM
 *
 * 纯 JS（@noble），无原生依赖——跨平台安装零摩擦（技术详设 §2 选型第一原则）。
 */

import { gcm } from '@noble/ciphers/aes';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from 'node:crypto';

// ---------- Ed25519 身份签名（卡片与一切信封签名，防伪造 D13） ----------

export type IdentityKeyPair = {
  /** 32 字节私钥种子（加密存储，永不出设备） */
  privateKey: Uint8Array;
  publicKey: Uint8Array;
};

export function generateIdentityKeyPair(): IdentityKeyPair {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function identityPublicKeyFromSeed(seed: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(seed);
}

/** 签名（对 canonical bytes 签名，调用方负责序列化规范） */
export function signDetached(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, privateKey);
}

export function verifyDetached(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** owner_key_id = SHA-256(公钥) 的 32 字节指纹（Schema §2，非身份信息） */
export function keyIdFromPublicKey(publicKey: Uint8Array): Uint8Array {
  return sha256(publicKey);
}

// ---------- X25519 密钥交换 + sealed box（grant 类信封：只交付密钥不解密文） ----------

export type KexKeyPair = {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
};

export function generateKexKeyPair(): KexKeyPair {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function getKexPublicKey(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

/** 协议固定 HKDF info（域分离） */
const HKDF_INFO = new TextEncoder().encode('hongxian/protocol-v0/sealed-box/v1');

/** ECDH(ephPriv, recipientPub) → HKDF-SHA256 → AES-256-GCM 密钥 */
function deriveSharedKey(ephemeralPrivate: Uint8Array, recipientPublic: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(ephemeralPrivate, recipientPublic);
  return hkdf(sha256, shared, undefined, HKDF_INFO, 32);
}

/** Sealed box：临时密钥对 + ECDH + AES-GCM。输出 = ephPub(32) || nonce(12) || ct||tag */
export function sealBox(plaintext: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  const eph = generateKexKeyPair();
  const key = deriveSharedKey(eph.privateKey, recipientPublicKey);
  const nonce = randomBytes(12);
  const sealed = gcm(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(32 + 12 + sealed.length);
  out.set(eph.publicKey, 0);
  out.set(nonce, 32);
  out.set(sealed, 44);
  return out;
}

/** 解开 sealed box；失败（伪造/篡改/非本方）返回 null */
export function openBox(sealed: Uint8Array, recipientPrivateKey: Uint8Array): Uint8Array | null {
  if (sealed.length < 44 + 16) return null;
  const ephPub = sealed.slice(0, 32);
  const nonce = sealed.slice(32, 44);
  const ct = sealed.slice(44);
  try {
    const key = deriveSharedKey(recipientPrivateKey, ephPub);
    return gcm(key, nonce).decrypt(ct);
  } catch {
    return null;
  }
}

// ---------- AES-256-GCM（层密钥直接封装） ----------

/** 加密。ct = ciphertext || tag(16B)；nonce 12 字节随机 */
export function aesGcmEncrypt(key: Uint8Array, plaintext: Uint8Array): { nonce: Uint8Array; ct: Uint8Array } {
  if (key.length !== 32) throw new Error('AES-256 密钥必须是 32 字节');
  const nonce = randomBytes(12);
  const aes = gcm(key, nonce);
  return { nonce, ct: aes.encrypt(plaintext) };
}

/** 解密；认证失败返回 null（不降级、不部分解密——Schema §7.4） */
export function aesGcmDecrypt(key: Uint8Array, nonce: Uint8Array, ct: Uint8Array): Uint8Array | null {
  if (key.length !== 32) throw new Error('AES-256 密钥必须是 32 字节');
  try {
    const aes = gcm(key, nonce);
    return aes.decrypt(ct);
  } catch {
    return null;
  }
}

/** 随机 n 字节 */
export function randomKey(n: number): Uint8Array {
  return randomBytes(n);
}

// ---------- 域分离子密钥（D13 见面层逐字段 opt-in） ----------

/** 子密钥域分离前缀（改前缀 = 协议不兼容变更，不得随意改动） */
const SUBKEY_INFO_PREFIX = 'hongxian/protocol/v1/subkey/';

/**
 * 由层密钥派生用途子密钥：HKDF-SHA256(master, info = prefix + label)。
 *
 * 见面层用它把单一的 L3 层密钥摊成「每字段一把」——
 * 交付 contact_wechat 的子密钥不等于交付 contact_phone 的子密钥，
 * D13「给微信号但不给手机号」由此在密码学层面成立，而不只是 UI 上的开关。
 *
 * 单向性：子密钥推不出主密钥，也无法推到别的字段（不同 info）。
 */
export function deriveSubkey(masterKey: Uint8Array, label: string): Uint8Array {
  if (masterKey.length !== 32) throw new Error('主密钥必须是 32 字节');
  const info = new TextEncoder().encode(SUBKEY_INFO_PREFIX + label);
  return hkdf(sha256, masterKey, undefined, info, 32);
}
