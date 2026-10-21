/**
 * 见面层（L3）逐字段加解密（D13）
 *
 * 问题：单块 L3 只能整层交付——把 key_L3 给对方，等于把微信号、手机号、
 * 真实姓名一起给了。"逐字段 opt-in"就成了 UI 上的装饰，密码学上不成立。
 *
 * 解法：L3 明文改成容器 `{ v: 1, fields: { <字段名>: CipherBlock } }`，
 * 每个字段用 `HKDF(L3 层密钥, "l3/<字段名>")` 派生的子密钥独立加密。
 * grant_l3 只交付被授权字段的子密钥——其余字段的密文对方拿到了也打不开。
 *
 * 兼容：v1.0 卡片的 payload_L3 解封后是裸 PayloadL3（无 v/fields），
 * 读取方按"整体明文"处理（本文件 openL3Field 两条分支都兜住）。
 */

import {
  L3_FIELD_LABEL_PREFIX,
  L3_FIELD_NAMES,
  fromBase64,
  toBase64,
  type CipherBlock,
  type PayloadL3,
} from '@hongxian/schema';
import { aesGcmDecrypt, aesGcmEncrypt, deriveSubkey } from '@hongxian/crypto';

/** 某字段的子密钥（签发方用它加密，授权方用它封装交付） */
export function l3FieldKey(l3LayerKey: Uint8Array, field: string): Uint8Array {
  return deriveSubkey(l3LayerKey, `${L3_FIELD_LABEL_PREFIX}${field}`);
}

/**
 * 容器密钥：payload_L3 外层的 AES-GCM 用它加密。
 *
 * 为什么要单独一把：外层若直接用 L3 层密钥，交出去就等于交了全部字段。
 * 容器密钥只能解出「各字段的密文」，解不出任何明文——所以它可以随 grant_l3
 * 一起交出去：拿到容器钥匙 + 被授权字段的子密钥，恰好只看得见被授权的字段。
 */
export function l3ContainerKey(l3LayerKey: Uint8Array): Uint8Array {
  return deriveSubkey(l3LayerKey, 'l3/container');
}

/** L3 容器（payload_L3 解封后的明文形态） */
export interface L3Container {
  v: 1;
  fields: Record<string, CipherBlock>;
}

/** 见面层字段名白名单（再导出，避免调用方多包 import） */
export { L3_FIELD_NAMES };

/** 把见面层明文逐字段加密为容器；字段名必须在白名单内 */
export function sealL3Fields(plain: PayloadL3, l3LayerKey: Uint8Array): L3Container {
  const fields: Record<string, CipherBlock> = {};
  for (const [field, value] of Object.entries(plain)) {
    if (value === undefined) continue;
    if (!(L3_FIELD_NAMES as readonly string[]).includes(field)) {
      throw new Error(`见面层字段"${field}"不在白名单（D13）`);
    }
    const key = l3FieldKey(l3LayerKey, field);
    const { nonce, ct } = aesGcmEncrypt(key, new TextEncoder().encode(JSON.stringify(value)));
    fields[field] = { nonce: toBase64(nonce), ct: toBase64(ct) };
  }
  if (Object.keys(fields).length === 0) throw new Error('见面层没有任何字段可加密');
  return { v: 1, fields };
}

/**
 * 解一个字段：容器形态用「字段子密钥」，v1.0 裸明文形态直接用层密钥解整块。
 * 解不开一律返回失败（不降级、不部分解密——Schema §7.4）。
 */
export function openL3Field(
  opened: unknown,
  field: string,
  fieldOrLayerKey: Uint8Array,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (isContainer(opened)) {
    const block = opened.fields[field];
    if (!block) return { ok: false, error: `对方未解锁该字段（${field}）` };
    const bytes = aesGcmDecrypt(fieldOrLayerKey, fromBase64(block.nonce), fromBase64(block.ct));
    if (!bytes) return { ok: false, error: `${field} 解密失败（子密钥不匹配或密文被篡改）` };
    try {
      return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
    } catch {
      return { ok: false, error: `${field} 明文不是合法 JSON` };
    }
  }
  // v1.0 裸明文：opened 已是 PayloadL3
  const plain = opened as Record<string, unknown> | null;
  if (!plain || typeof plain !== 'object') return { ok: false, error: '见面层明文结构异常' };
  if (plain[field] === undefined) return { ok: false, error: `该卡片没有 ${field} 字段` };
  return { ok: true, value: plain[field] };
}

/** 容器里实际存在的字段名（供授权界面列出"你有什么可给"） */
export function l3FieldNamesIn(opened: unknown): string[] {
  if (isContainer(opened)) return Object.keys(opened.fields);
  if (opened && typeof opened === 'object') return Object.keys(opened as object);
  return [];
}

function isContainer(value: unknown): value is L3Container {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { v?: unknown }).v === 1 &&
    typeof (value as { fields?: unknown }).fields === 'object' &&
    (value as { fields?: unknown }).fields !== null
  );
}
