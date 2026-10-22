/**
 * 平台服务客户端（月老 Skill 侧——工程设计 V8/V9 + 协议 §7）
 *
 * 铁律（V9）：无 presence、无已读回执、无推送。发件方确认只到"已入信箱"。
 * 本模块只做三件事：构造持钥证明（无状态签名认证头）、发 HTTP、管本地注册状态。
 * 一切内容都是密文——客户端经本模块送出的只有信封 blob，服务端亦然。
 *
 * 认证头（协议 §7，与服务端 auth.ts 同构、独立实现）：
 *   X-Hongxian-Auth: <opaque_id>:<unix_ts>:<sig_b64>
 *   签名对象 = canonical({ opaque_id, ts, action })；action = "METHOD /路径"
 *   URL 路径中的地址必须百分号编码（base64 含 + /），action 串用未编码地址
 *   （服务端 param 自动解码后比对——两端口径以此注释与 E2E 锁定）。
 */

import { canonicalBytes } from '@hongxian/schema';
import { store } from './context.js';
import type { Session } from './session.js';

export const SERVER_DIR = 'server';
export const REGISTRATION_PATH = `${SERVER_DIR}/registration.json`;
export const SEEN_CARDS_PATH = `${SERVER_DIR}/plaza-seen.json`;
export const PULLED_PATH = `${SERVER_DIR}/pulled.json`;
/** 已浏览/已拉取记录的保留上限（防无限增长；超出丢弃最旧） */
const HISTORY_CAP = 500;
const HTTP_TIMEOUT_MS = 10_000;

export interface ServerRegistration {
  instance: string;
  opaque_id: string;
  registered_at: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

export class PlazaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// ---------- 实例地址与注册状态 ----------

/** 归一化实例地址：必须 http(s)，去掉尾斜杠；非法返回 null */
export function normalizeInstanceUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function loadRegistration(s: ReturnType<typeof store>): ServerRegistration | null {
  return s.read<ServerRegistration>(REGISTRATION_PATH);
}

export function saveRegistration(s: ReturnType<typeof store>, reg: ServerRegistration): void {
  s.write(REGISTRATION_PATH, reg);
}

// ---------- 持钥证明（协议 §7） ----------

/** 构造认证头值（客户端侧；与服务端 auth.ts 同构） */
export function buildAuthHeaderValue(
  opaqueId: string,
  action: string,
  sign: (message: Uint8Array) => Uint8Array,
  now: number = Date.now(),
): string {
  const ts = Math.floor(now / 1000);
  const sig = sign(canonicalBytes({ opaque_id: opaqueId, ts, action }));
  return `${opaqueId}:${ts}:${Buffer.from(sig).toString('base64')}`;
}

// ---------- HTTP 薄层 ----------

async function apiRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  opts: { body?: unknown; auth?: string } = {},
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.auth ? { 'x-hongxian-auth': opts.auth } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      return { ok: false, error: `服务端返回了非 JSON（HTTP ${res.status}）`, status: res.status };
    }
    if (!res.ok) {
      const msg = (json as { error?: string }).error ?? `HTTP ${res.status}`;
      return { ok: false, error: msg, status: res.status };
    }
    return { ok: true, data: json as T };
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? `服务端无响应（${HTTP_TIMEOUT_MS / 1000}s 超时）` : `网络不可达：${(e as Error).message}`;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 身份注册（自声明 opaque ID；持钥证明） ----------

/**
 * 确保已在本实例注册（幂等）。409 = 已注册（v2.0 无轮换）——本地无记录时
 * 把服务端状态重新对齐（换设备重装场景）。
 */
export async function ensureRegistered(instance: string, session: Session): Promise<ApiResult<ServerRegistration>> {
  const s = store();
  const existing = loadRegistration(s);
  const key = session.keyProvider();
  const opaqueId = session.keyIdB64;
  const sigPublic = Buffer.from(key.identityPublic()).toString('base64');
  const kxPublic = Buffer.from(key.kexPublic()).toString('base64');

  if (existing && existing.instance === instance && existing.opaque_id === opaqueId) {
    return { ok: true, data: existing };
  }
  const action = 'POST /v2/identity/register';
  const auth = buildAuthHeaderValue(opaqueId, action, key.sign);
  const res = await apiRequest<{ opaque_id: string }>(`POST`, `${instance}/v2/identity/register`, {
    body: { opaque_id: opaqueId, sig_public: sigPublic, kx_public: kxPublic },
    auth,
  });
  if (!res.ok && res.status !== 409) return res;
  const reg: ServerRegistration = { instance, opaque_id: opaqueId, registered_at: new Date().toISOString() };
  saveRegistration(s, reg);
  return { ok: true, data: reg };
}

// ---------- 广场（哑管道） ----------

export interface PlazaPage {
  items: unknown[];
  next_cursor: string | null;
}

/** 拉取广场卡池（公开，无需认证；零过滤零排序——分拣在客户端） */
export function browsePlaza(instance: string, cursor?: string | null): Promise<ApiResult<PlazaPage>> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiRequest<PlazaPage>('GET', `${instance}/v2/cards${q}`);
}

/** 贴广场卡（持钥证明；服务端拒收携 key_l1 的卡——§10.5） */
export async function publishPlazaCard(
  instance: string,
  card: unknown,
  session: Session,
): Promise<ApiResult<{ fingerprint: string }>> {
  const key = session.keyProvider();
  const auth = buildAuthHeaderValue(session.keyIdB64, 'POST /v2/cards', key.sign);
  return apiRequest<{ fingerprint: string }>('POST', `${instance}/v2/cards`, { body: card, auth });
}

/** 撤卡（按指纹；持钥人才能撤自己的卡） */
export async function withdrawPlazaCard(instance: string, fingerprint: string, session: Session): Promise<ApiResult<{ withdrawn: boolean }>> {
  const key = session.keyProvider();
  const auth = buildAuthHeaderValue(session.keyIdB64, `DELETE /v2/cards/${fingerprint}`, key.sign);
  return apiRequest('DELETE', `${instance}/v2/cards/${encodeURIComponent(fingerprint)}`, { auth });
}

// ---------- 举报（行为信号；不含任何信件内容） ----------

export interface ReportSummaryDto {
  reports: number;
  distinct: number;
  flagged: boolean;
}

/** 举报一个 opaque ID（持钥证明；服务端只记行为信号，读不到信件内容） */
export async function reportAbuse(
  instance: string,
  targetOpaqueId: string,
  reasonCode: string,
  session: Session,
): Promise<ApiResult<{ recorded: boolean; summary: ReportSummaryDto }>> {
  const key = session.keyProvider();
  const auth = buildAuthHeaderValue(session.keyIdB64, 'POST /v2/reports', key.sign);
  return apiRequest<{ recorded: boolean; summary: ReportSummaryDto }>('POST', `${instance}/v2/reports`, {
    body: { target_opaque_id: targetOpaqueId, reason_code: reasonCode },
    auth,
  });
}

/** 查看"我"被举报的汇总（只有本人可查——否则举报计数会变成公开羞辱工具） */
export async function fetchReportSummary(
  instance: string,
  opaqueId: string,
  session: Session,
): Promise<ApiResult<{ summary: ReportSummaryDto }>> {
  const key = session.keyProvider();
  const auth = buildAuthHeaderValue(session.keyIdB64, `GET /v2/reports/${opaqueId}`, key.sign);
  return apiRequest<{ summary: ReportSummaryDto }>('GET', `${instance}/v2/reports/${encodeURIComponent(opaqueId)}`, {
    auth,
  });
}

/** 实例匿名聚合（M4 透明度；公开只读、无个体数据） */
export interface InstanceStatsDto {
  identities: number;
  cards: number;
  envelopes: number;
  reported_targets: number;
  flagged_targets: number;
  generated_at: string;
  instance?: string;
}

export function fetchInstanceStats(instance: string): Promise<ApiResult<InstanceStatsDto>> {
  return apiRequest<InstanceStatsDto>('GET', `${instance}/v2/stats`);
}

// ---------- 信箱 ----------

/** 投递（定向地址；服务端不校验发件方认证头，但随头携带持钥证明——v2.1 联邦预留） */
export async function deliverEnvelope(
  instance: string,
  address: string,
  envelope: unknown,
  session: Session,
): Promise<ApiResult<{ id: string; entered_mailbox: boolean }>> {
  const key = session.keyProvider();
  const auth = buildAuthHeaderValue(session.keyIdB64, `POST /v2/mailbox/${address}`, key.sign);
  return apiRequest('POST', `${instance}/v2/mailbox/${encodeURIComponent(address)}`, { body: envelope, auth });
}

/** 拉取自己的信箱（签名认证；无已读回执、无 presence） */
export async function pullMailbox(
  instance: string,
  address: string,
  session: Session,
  cursor?: string | null,
): Promise<ApiResult<PlazaPage>> {
  const key = session.keyProvider();
  const auth = buildAuthHeaderValue(session.keyIdB64, `GET /v2/mailbox/${address}`, key.sign);
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiRequest('GET', `${instance}/v2/mailbox/${encodeURIComponent(address)}${q}`, { auth });
}

/** 删除单封信（收件方；POP3 式拉取即删——服务端少一分持有少一分责任） */
export async function deleteMailboxItem(
  instance: string,
  address: string,
  envId: string,
  session: Session,
): Promise<ApiResult<{ deleted: boolean }>> {
  const key = session.keyProvider();
  const auth = buildAuthHeaderValue(session.keyIdB64, `DELETE /v2/mailbox/${address}/${envId}`, key.sign);
  return apiRequest('DELETE', `${instance}/v2/mailbox/${encodeURIComponent(address)}/${encodeURIComponent(envId)}`, { auth });
}

/** 注销服务端身份（级联删密文；wipe 的远程侧收尾——尽力而为，失败不阻塞本地删除） */
export async function deleteServerIdentity(instance: string, session: Session): Promise<ApiResult<{ removed: number }>> {
  const key = session.keyProvider();
  const auth = buildAuthHeaderValue(session.keyIdB64, 'DELETE /v2/identity', key.sign);
  return apiRequest('DELETE', `${instance}/v2/identity`, { auth });
}

// ---------- 本地历史状态（已浏览 / 已拉取） ----------

export function loadHistory(s: ReturnType<typeof store>, path: string): string[] {
  return s.read<string[]>(path) ?? [];
}

/** 记录并裁剪（保留最近 HISTORY_CAP 条） */
export function appendHistory(s: ReturnType<typeof store>, path: string, ids: string[]): void {
  if (ids.length === 0) return;
  const next = [...loadHistory(s, path), ...ids];
  s.write(path, next.slice(-HISTORY_CAP));
}
