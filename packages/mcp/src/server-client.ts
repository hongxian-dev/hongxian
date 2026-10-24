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

export type ApiResult<T> =
  | { ok: true; data: T }
  /** `code` 是服务端的机器可读错误码（不是所有错误都有）——客户端据它分支，不做字符串匹配 */
  | { ok: false; error: string; status?: number; code?: string };

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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
      const payload = json as { error?: string; code?: string };
      const msg = payload.error ?? `HTTP ${res.status}`;
      return { ok: false, error: msg, status: res.status, code: payload.code };
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

// ---------- 发布许可（D1 方案 B：只对"贴到广场"要求载体验证） ----------

export interface ServerHealthDto {
  ok: boolean;
  service?: string;
  instance?: string;
  publish?: {
    required: boolean;
    available: boolean;
    verify_base: string | null;
  };
}

/**
 * 问实例"要不要发布确认、通道通不通、验证页在哪"。
 *
 * 为什么要问而不是猜：自托管实例可以完全不要求验证（私有小圈子没必要发信），
 * 官方实例则要求。客户端如果硬编码"一定要验证"，会把自托管用户挡在门外。
 */
export function fetchServerHealth(instance: string): Promise<ApiResult<ServerHealthDto>> {
  return apiRequest<ServerHealthDto>('GET', `${instance}/healthz`);
}

export interface PublishCredentialDto {
  verified: boolean;
  verified_at?: string;
}

/**
 * 披露声明（防护三 / C2③）。
 *
 * 从服务端取全文而不是本地硬编码：措辞是最常被要求修改的东西，
 * 一旦写死在客户端，改一句话就要发一版 Skill。
 */
export interface PublishDisclosureDto {
  version: string;
  full: string;
  brief: string;
  ack_label: string;
  require_ack: boolean;
}

export function fetchPublishDisclosure(instance: string): Promise<ApiResult<PublishDisclosureDto>> {
  return apiRequest<PublishDisclosureDto>('GET', `${instance}/v2/publish/disclosure`);
}

/** 认领发布许可（持钥证明；这一步才把"验证过的载体"与"这把密钥"绑在一起） */
export async function claimPublishCredential(
  instance: string,
  nonce: string,
  permit: string,
  session: Session,
  disclosureVersion?: string,
): Promise<ApiResult<{ verified: boolean; verified_at: string }>> {
  const key = session.keyProvider();
  const auth = buildAuthHeaderValue(session.keyIdB64, 'PUT /v2/publish/credential', key.sign);
  return apiRequest<{ verified: boolean; verified_at: string }>('PUT', `${instance}/v2/publish/credential`, {
    // disclosure_version 一起交上去：让"这个人贴卡时看到的是哪一版丑话"留在服务端可追溯，
    // 而不是只留在本机（本机的记录重装就没了）
    body: { nonce, permit, disclosure_version: disclosureVersion },
    auth,
  });
}

/** 查自己有没有发布许可（只回答有没有） */
export async function fetchPublishCredential(
  instance: string,
  session: Session,
): Promise<ApiResult<PublishCredentialDto>> {
  const key = session.keyProvider();
  const auth = buildAuthHeaderValue(session.keyIdB64, 'GET /v2/publish/credential', key.sign);
  return apiRequest<PublishCredentialDto>('GET', `${instance}/v2/publish/credential`, { auth });
}

/** 解绑（失去贴卡能力；历史卡不追溯——别人存证过的卡撤不回来） */
export async function unbindPublishCredential(
  instance: string,
  session: Session,
): Promise<ApiResult<{ unbound: boolean; note: string }>> {
  const key = session.keyProvider();
  const auth = buildAuthHeaderValue(session.keyIdB64, 'DELETE /v2/publish/credential', key.sign);
  return apiRequest<{ unbound: boolean; note: string }>('DELETE', `${instance}/v2/publish/credential`, { auth });
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
