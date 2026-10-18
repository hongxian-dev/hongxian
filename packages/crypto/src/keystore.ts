/**
 * 红线密钥体系 · 第三层：加密密钥文件与 KeyMaterial 管理
 *
 * 布局（技术详设 §4/§5）：
 *   ~/.hongxian/keys/id.enc   身份密钥对（Ed25519）
 *   ~/.hongxian/keys/kx.enc   协商密钥对（X25519）
 *   ~/.hongxian/keys/lk.enc   层密钥 key_L1/L2/L3
 * 每文件独立盐 + Argon2id → AES-256-GCM。私钥永不落明文；
 * 解锁会话内 MK 仅存内存，lock/退出即 zeroize。
 */

import { ARGON2_PARAMS, type Argon2Params, deriveKey, zeroize } from './kdf.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  generateIdentityKeyPair,
  generateKexKeyPair,
  getKexPublicKey,
  identityPublicKeyFromSeed,
  keyIdFromPublicKey,
  randomKey,
} from './primitives.js';

/** 加密密钥文件格式（v1） */
export const EncryptedKeyFile = {
  version: 1,
  kdf: 'argon2id',
  aead: 'aes-256-gcm',
} as const;

export interface SealedKeyFile {
  v: 1;
  kdf: 'argon2id';
  params: { t: number; m: number; p: number };
  salt: string; // base64，16 字节
  nonce: string; // base64，12 字节
  ct: string; // base64，ciphertext||tag
}

/** 内存中的完整密钥材料（进程级，退出即消失） */
export interface KeyMaterial {
  identityPrivate: Uint8Array; // Ed25519 私钥种子
  identityPublic: Uint8Array;
  kxPrivate: Uint8Array; // X25519 私钥
  kxPublic: Uint8Array;
  layerKeys: { L1: Uint8Array; L2: Uint8Array; L3: Uint8Array }; // 各 32 字节
}

export function generateKeyMaterial(): KeyMaterial {
  const id = generateIdentityKeyPair();
  const kx = generateKexKeyPair();
  return {
    identityPrivate: id.privateKey,
    identityPublic: id.publicKey,
    kxPrivate: kx.privateKey,
    kxPublic: kx.publicKey,
    layerKeys: { L1: randomKey(32), L2: randomKey(32), L3: randomKey(32) },
  };
}

/**
 * 协议固定盐（Argon2id 派生 MK 用）——公开常量。
 * seed 本身是 256-bit BIP39 输出（高熵），固定盐无安全损失
 * （盐的使命是防彩虹表与并行化，对单用户单口令场景不适用）。
 */
export const PROTOCOL_SALT = new TextEncoder().encode('hongxian/protocol-v0/mk-salt/v1');

/** HKDF 域分离 info（各子密钥独立派生路径） */
const INFO = {
  identity: new TextEncoder().encode('hongxian/protocol-v0/identity-seed/v1'),
  kx: new TextEncoder().encode('hongxian/protocol-v0/keyexchange-seed/v1'),
  L1: new TextEncoder().encode('hongxian/protocol-v0/layer-key/L1/v1'),
  L2: new TextEncoder().encode('hongxian/protocol-v0/layer-key/L2/v1'),
  L3: new TextEncoder().encode('hongxian/protocol-v0/layer-key/L3/v1'),
};

/**
 * 从恢复短语 seed 确定性派生 KeyMaterial（"恢复短语即身份"的工程实现）。
 *
 * 同短语 → 同 MK → 同 identity/kx/layer 密钥 → 同 owner_key_id：
 * 换设备输入旧短语即重建同一身份，旧卡片签名可验、旧 grant 信封可解、
 * 姻缘线关系不断（D15③ 的成立前提）。MK 仅存内存。
 */
export async function deriveKeyMaterial(seed: Uint8Array, params?: Argon2Params): Promise<KeyMaterial> {
  const mk = await deriveKey(seed, PROTOCOL_SALT, params ?? ARGON2_PARAMS);
  try {
    const sub = (info: Uint8Array) => hkdf(sha256, mk, undefined, info, 32);
    const identityPrivate = sub(INFO.identity);
    const kxPrivate = sub(INFO.kx);
    return {
      identityPrivate,
      identityPublic: identityPublicKeyFromSeed(identityPrivate),
      kxPrivate,
      kxPublic: getKexPublicKey(kxPrivate),
      layerKeys: { L1: sub(INFO.L1), L2: sub(INFO.L2), L3: sub(INFO.L3) },
    };
  } finally {
    zeroize(mk);
  }
}

/** owner_key_id（32 字节指纹） */
export function keyMaterialId(km: KeyMaterial): Uint8Array {
  return keyIdFromPublicKey(km.identityPublic);
}

/** 锁定：清零全部敏感字节 */
export function lockKeyMaterial(km: KeyMaterial): void {
  zeroize(km.identityPrivate, km.kxPrivate, km.layerKeys.L1, km.layerKeys.L2, km.layerKeys.L3);
}

// ---------- 文件序列化 ----------

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/** 层密钥明文结构（lk.enc 的内容） */
function serializeLayerKeys(km: KeyMaterial): Uint8Array {
  const json = JSON.stringify({
    L1: toB64(km.layerKeys.L1),
    L2: toB64(km.layerKeys.L2),
    L3: toB64(km.layerKeys.L3),
  });
  return new TextEncoder().encode(json);
}

function parseLayerKeys(bytes: Uint8Array): { L1: Uint8Array; L2: Uint8Array; L3: Uint8Array } {
  const obj = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;
  return { L1: fromB64(obj.L1!), L2: fromB64(obj.L2!), L3: fromB64(obj.L3!) };
}

/**
 * 用恢复短语 seed 加密一份明文 → SealedKeyFile。
 * 盐独立随机（每文件不同盐：备份/恢复单文件可行，且盐无需保密）。
 * 参数随文件记录（哈希前向兼容：未来调参不影响旧文件解密）。
 */
export async function sealKeyFile(
  plaintext: Uint8Array,
  password: Uint8Array,
  params: Argon2Params = ARGON2_PARAMS,
): Promise<SealedKeyFile> {
  const salt = randomKey(16);
  const fileKey = await deriveKey(password, salt, params);
  try {
    const { nonce, ct } = aesGcmEncrypt(fileKey, plaintext);
    return {
      v: EncryptedKeyFile.version,
      kdf: EncryptedKeyFile.kdf,
      params: { t: params.iterations, m: params.memorySize, p: params.parallelism },
      salt: toB64(salt),
      nonce: toB64(nonce),
      ct: toB64(ct),
    };
  } finally {
    zeroize(fileKey);
  }
}

/** 解密 SealedKeyFile；密码错误/文件被篡改返回 null。参数取文件自带记录 */
export async function openKeyFile(
  file: SealedKeyFile,
  password: Uint8Array,
): Promise<Uint8Array | null> {
  if (file.v !== EncryptedKeyFile.version) return null;
  const salt = fromB64(file.salt);
  const fileKey = await deriveKey(password, salt, {
    iterations: file.params.t,
    memorySize: file.params.m,
    parallelism: file.params.p,
    hashLength: 32,
  });
  try {
    return aesGcmDecrypt(fileKey, fromB64(file.nonce), fromB64(file.ct));
  } finally {
    zeroize(fileKey);
  }
}

// ---------- 三份密钥文件的高层存取 ----------

/** 从恢复短语 seed 创建三份加密文件 */
export async function createKeyFiles(
  password: Uint8Array,
  km: KeyMaterial,
  params?: Argon2Params,
): Promise<{ id: SealedKeyFile; kx: SealedKeyFile; lk: SealedKeyFile }> {
  const [id, kx, lk] = await Promise.all([
    sealKeyFile(km.identityPrivate, password, params),
    sealKeyFile(km.kxPrivate, password, params),
    sealKeyFile(serializeLayerKeys(km), password, params),
  ]);
  return { id, kx, lk };
}

/** 从三份加密文件 + 恢复短语 seed 恢复 KeyMaterial（换设备场景，D15③） */
export async function restoreKeyFiles(
  files: { id: SealedKeyFile; kx: SealedKeyFile; lk: SealedKeyFile },
  password: Uint8Array,
): Promise<KeyMaterial | null> {
  const [idBytes, kxBytes, lkBytes] = await Promise.all([
    openKeyFile(files.id, password),
    openKeyFile(files.kx, password),
    openKeyFile(files.lk, password),
  ]);
  if (!idBytes || !kxBytes || !lkBytes) return null;
  try {
    const layers = parseLayerKeys(lkBytes);
    const identityPrivate = idBytes;
    return {
      identityPrivate,
      identityPublic: identityPublicKeyFromSeed(identityPrivate),
      kxPrivate: kxBytes,
      kxPublic: getKexPublicKey(kxBytes),
      layerKeys: layers,
    };
  } catch {
    return null;
  }
}
