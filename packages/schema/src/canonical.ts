/**
 * 红线协议 v0 · 序列化与标识工具
 *
 * canonical JSON（简化 JCS）：递归按键排序、无空白、数字按 ECMAScript 规范序列化。
 * 签名与哈希全部基于规范化字节——消除 JSON 序列化差异导致的验签失败。
 * UUIDv7：时间有序的 opaque ID（card_id 全局唯一，不含任何身份信息）。
 */

import { randomBytes } from 'node:crypto';

/** 递归按键排序的规范化 JSON（协议 §2：签名对象 = meta || 三个密文） */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/** 规范化 JSON 的 UTF-8 字节（签名/哈希输入） */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  // undefined / function 在 JSON 中不出现；number 走 ECMAScript 规范（与 JCS 一致）
  return value;
}

/** 生成 UUIDv7（48-bit 毫秒时间戳 + 版本 7 + 变体 10xx + 74-bit 随机） */
export function uuidV7(): string {
  const ts = Date.now();
  const bytes = randomBytes(16); // 16 字节 = 128 bit
  // 48-bit 时间戳（大端，覆盖前 6 字节）
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  // version 7（第 7 字节高 4 位）
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // variant 10xx（第 9 字节高 2 位）
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** UUID 形态校验（含 v7 检查） */
export function isUuidV7(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** base64 严格校验（含长度，用于 owner_key_id 等指纹字段） */
export function isBase64OfLength(s: string, byteLength: number): boolean {
  try {
    const buf = Buffer.from(s, 'base64');
    return buf.length === byteLength && Buffer.from(buf).toString('base64') === s;
  } catch {
    return false;
  }
}
