/**
 * 红线协议 v0.4 · 寻址（Address，平台服务工程设计 V8）
 *
 * opaque ID = Ed25519 公钥指纹（32B base64）——不含任何身份信息。
 * instance 域名为联邦预留（v2.1 实例间转发启用；v2.0 单实例内忽略）。
 * 格式类 Email：opaque_id@instance_domain；无后缀 = 本实例。
 */

import { z } from 'zod';
import { isBase64OfLength } from './canonical.js';

export const Address = z.object({
  opaque_id: z
    .string()
    .refine((s) => isBase64OfLength(s, 32), { message: 'opaque_id 必须是 32 字节指纹的 base64' }),
  /** 实例域名（v2.0 忽略；v2.1 联邦转发时用于路由） */
  instance: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/, 'instance 必须是合法域名形态')
    .optional(),
});
export type Address = z.infer<typeof Address>;

/** 格式化为 `opaque_id@instance`（无 instance 时返回裸 opaque_id） */
export function formatAddress(addr: Address): string {
  return addr.instance ? `${addr.opaque_id}@${addr.instance}` : addr.opaque_id;
}

/**
 * 解析地址字符串。base64 字母表不含 '@'，故首个 '@' 即分隔符。
 * 非法输入返回 null（调用方负责拒绝——协议层不猜）。
 */
export function parseAddress(input: string): Address | null {
  if (!input || input.length > 320) return null;
  const at = input.indexOf('@');
  const opaquePart = at === -1 ? input : input.slice(0, at);
  const instancePart = at === -1 ? undefined : input.slice(at + 1);
  const candidate: Address = {
    opaque_id: opaquePart,
    ...(instancePart ? { instance: instancePart } : {}),
  };
  const result = Address.safeParse(candidate);
  return result.success ? result.data : null;
}
