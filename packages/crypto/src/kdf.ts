/**
 * 红线密钥体系 · 第二层：Argon2id 主密钥派生（技术详设 §4 / 执行设计 E5）
 *
 * 恢复短语 → Argon2id → MK。每个密钥文件独立盐（备份/恢复单文件可行）。
 * MK 仅存内存，进程退出即清零（zeroize）。
 */

import { argon2id } from 'hash-wasm';

/** Argon2id 参数（t=3, m=64MB, p=4）——OWASP 2023 推荐档，哈希前向兼容 */
export interface Argon2Params {
  /** 时间成本（迭代次数） */
  iterations: number;
  /** 内存成本（KiB） */
  memorySize: number;
  /** 并行度 */
  parallelism: number;
  /** 输出长度（字节） */
  hashLength: number;
}

export const ARGON2_PARAMS: Argon2Params = {
  iterations: 3,
  memorySize: 65536, // KiB = 64 MB
  parallelism: 4,
  hashLength: 32,
};

/** 从密码（BIP39 seed）与盐派生 32 字节密钥 */
export async function deriveKey(
  password: Uint8Array,
  salt: Uint8Array,
  params: Argon2Params = ARGON2_PARAMS,
): Promise<Uint8Array> {
  const key = await argon2id({
    password,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memorySize,
    hashLength: params.hashLength,
    outputType: 'binary',
  });
  return new Uint8Array(key);
}

/** 显式清零（MK 生命周期管理：lock / 进程退出） */
export function zeroize(...bufs: (Uint8Array | undefined)[]): void {
  for (const buf of bufs) {
    if (buf) buf.fill(0);
  }
}
