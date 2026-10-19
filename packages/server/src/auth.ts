/**
 * 红线平台服务 · 无状态签名认证（auth）
 *
 * 拉取信箱 / 删除信封 / 注销身份等操作需要"持钥证明"——否则任何人知道 opaque ID
 * （= 公钥指纹，公开信息）即可拉走或删掉别人的信箱。
 *
 * 方案（无状态，无 nonce 存储、无 token）：
 *   请求头 X-Hongxian-Auth: <opaque_id>:<unix_ts>:<sig_b64>
 *   签名对象 = canonical({ opaque_id, ts, action })
 *   action   = "METHOD /请求路径"（防跨端点重放）
 * 服务端用注册时登记的 sig_public 验签（Ed25519，公钥——无任何秘密材料），
 * 并拒绝 |now - ts| > AUTH_WINDOW_S 的时间戳（窗口内重放由 action 绑定缓解；
 * 信箱内容本身是密文，重放泄露上限 = 攻击者已能看到的密文）。
 *
 * 铁律不变：验签只用公钥。本模块不含任何解密能力。
 */

import { ed25519 } from '@noble/curves/ed25519';
import { canonicalBytes, fromBase64 } from '@hongxian/schema';

export const AUTH_HEADER = 'x-hongxian-auth';
export const AUTH_WINDOW_S = 300;

export interface AuthContext {
  opaque_id: string;
}

export type AuthResult = { ok: true; ctx: AuthContext } | { ok: false; error: string };

/** 构造认证头（客户端侧助手；测试与 E2E 复用） */
export function buildAuthHeader(
  opaqueId: string,
  action: string,
  sign: (message: Uint8Array) => Uint8Array,
  now: number = Date.now(),
): string {
  const ts = Math.floor(now / 1000);
  const sig = sign(canonicalBytes({ opaque_id: opaqueId, ts, action }));
  return `${opaqueId}:${ts}:${Buffer.from(sig).toString('base64')}`;
}

/** 校验认证头；registeredSigPublic = 注册时登记的签名公钥（base64） */
export function verifyAuthHeader(
  header: string | undefined,
  action: string,
  registeredSigPublic: string,
  now: number = Date.now(),
): AuthResult {
  if (!header) return { ok: false, error: '缺少认证头 X-Hongxian-Auth' };
  const parts = header.split(':');
  if (parts.length !== 3) return { ok: false, error: '认证头格式错误（应为 opaque_id:ts:signature）' };
  const [opaqueId, tsStr, sigB64] = parts as [string, string, string];
  const ts = Number.parseInt(tsStr, 10);
  if (!Number.isFinite(ts)) return { ok: false, error: '认证头时间戳非法' };
  const drift = Math.abs(Math.floor(now / 1000) - ts);
  if (drift > AUTH_WINDOW_S) return { ok: false, error: `认证已过期（时间窗 ±${AUTH_WINDOW_S}s）` };
  try {
    const message = canonicalBytes({ opaque_id: opaqueId, ts, action });
    const ok = ed25519.verify(fromBase64(sigB64), message, fromBase64(registeredSigPublic));
    if (!ok) return { ok: false, error: '签名验证失败' };
    return { ok: true, ctx: { opaque_id: opaqueId } };
  } catch {
    return { ok: false, error: '签名验证失败（材料畸形）' };
  }
}
