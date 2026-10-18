/**
 * @hongxian/crypto —— 红线密钥体系
 *
 * 恢复短语（BIP39 中文 24 词）→ Argon2id → 三种子密钥；
 * Ed25519 签名 / X25519 sealed box / AES-256-GCM；私钥永不落明文。
 */

export * from './mnemonic.js';
export * from './kdf.js';
export * from './primitives.js';
export * from './keystore.js';
