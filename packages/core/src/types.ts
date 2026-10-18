/**
 * 红线领域核心 · 共享类型
 *
 * core 是纯函数层（技术详设原则 4）：IO 与密钥通过接口注入——
 * 换协议载体（CLI/Web/v2 客户端）时 core 零改动。
 */

/** 层标识（Schema：三层各自独立加密） */
export type Layer = 'L1' | 'L2' | 'L3';

/** payload 明文（ Zod 推断类型由 @hongxian/schema 提供，这里只做结构别名 ） */
export interface CardPayloads {
  l1: unknown;
  l2: unknown;
  l3?: unknown;
}

/**
 * 存储接口（mcp 层用 FsStore 实现；core 只依赖此接口）
 * 路径一律相对 ~/.hongxian/ 的正斜杠路径，实现层负责平台适配与 NFC 归一化。
 */
export interface Store {
  read<T = unknown>(path: string): T | null;
  write(path: string, data: unknown): void;
  remove(path: string): void;
  list(dir: string): string[];
  exists(path: string): boolean;
}

/**
 * 密钥提供者（mcp 层用解锁后的 KeyMaterial 实现）
 * core 的所有密码学操作经过此接口——私钥永不进入 core 之外的内存路径。
 */
export interface KeyProvider {
  /** Ed25519 签名（对 canonical bytes） */
  sign(bytes: Uint8Array): Uint8Array;
  /** owner_key_id：签名公钥的 32 字节指纹 */
  keyId(): Uint8Array;
  /** 层密钥（L1/L2/L3 各自独立） */
  layerKey(layer: Layer): Uint8Array;
  /** 用收件人 X25519 公钥封装明文（grant 类信封） */
  sealFor(recipientKxPublic: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** 本方 X25519 私钥解封 */
  openSealed(sealed: Uint8Array): Uint8Array | null;
  /** 协商公钥（随 match_card 元数据交换，换卡即换公钥） */
  kexPublic(): Uint8Array;
}

/** 领域错误（携带稳定错误码，MCP 层映射为工具错误） */
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** 统一结果类型：工具层不抛异常，返回可呈现的结构 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function err<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}
