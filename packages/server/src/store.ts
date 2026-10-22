/**
 * 红线平台服务 · 纯 JSON 文件存储（工程设计 V2）
 *
 * 与 v1 FsStore 同构：原子写（tmp + rename）、防目录逃逸、零原生依赖。
 * 数据布局：
 *   <root>/
 *   ├── identities/<opaqueHex>.json       自声明身份（opaque_id + sig_public + kx_public）
 *   ├── cards/<opaqueHex>.json            广场卡（一人一卡，重签覆盖；无 key_l1——§10.5 硬规则）
 *   ├── mailboxes/<opaqueHex>/<uuid>.json 信箱信封（30 天保留）
 *   ├── limits/<opaqueHex>-<YYYYMMDD>.json 每日投递计数（限速 20/日）
 *   └── secret                            实例秘密（启动时生成）
 *
 * 铁律：本包不得 import 任何解密能力（@hongxian/crypto 整体、sealBox/openBox、
 * key_l1 消费）——零知识审计测试（test/audit.test.ts）对此做源码级断言。
 * 允许的密码学操作仅限 Ed25519 验签与 SHA-256 纯哈希（均无秘密材料）。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  MAILBOX_RETENTION_DAYS,
  REPORT_FLAG_THRESHOLD,
  canonicalize,
  type MatchCardEnvelope,
  type MsgEnvelope,
} from '@hongxian/schema';
import { sha256 } from '@noble/hashes/sha256';

export interface StoredIdentity {
  opaque_id: string;
  sig_public: string;
  kx_public: string;
  created_at: string;
}

export interface StoredCard {
  envelope: MatchCardEnvelope;
  uploaded_at: string;
}

export interface StoredEnvelope {
  envelope: MsgEnvelope;
  delivered_at: string;
}

/**
 * 举报记录（v2 初稿 §6：只管行为信号，永不审内容）。
 *
 * 举报人身份**不落原值**：存的是 HMAC 式加盐假名 `sha256(实例 secret || opaque_id)`。
 * 这样仍能去重（同一人举报两次算一次），但服务端数据目录被拖走时，
 * 无法从报告文件反推出"谁举报了谁"——零知识的最后一段只靠这一层守住。
 */
export interface StoredReports {
  target_opaque_id: string;
  reports: { reporter_tag: string; reason: string; at: string }[];
}

export interface ReportSummary {
  /** 收到的举报条数（同一人多次只算一次） */
  reports: number;
  /** 独立举报人数 */
  distinct: number;
  /** 是否越过标记阈值（REPORT_FLAG_THRESHOLD 个独立举报人） */
  flagged: boolean;
}

export interface InstanceStats {
  identities: number;
  cards: number;
  envelopes: number;
  /** 被举报的目标数（不含条数——条数容易反推活跃度） */
  reported_targets: number;
  flagged_targets: number;
  generated_at: string;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** base64 → hex（目录/文件名安全化；base64 含 + / = 不适合做文件名） */
export function hexOf(b64: string): string {
  return Buffer.from(b64, 'base64').toString('hex');
}

export class ServerStore {
  readonly root: string;
  /** 实例秘密（举报人假名盐）——只在本机，不进任何对外响应 */
  private readonly secret: string;

  constructor(root: string) {
    // 归一化为绝对路径：否则默认的 './data' 会让 resolve() 的越界判定恒为真
    // （join('./data', 'x') = 'data/x'，不以 './data' 开头 → 全部写入被误判为越界）
    this.root = resolvePath(root);
    for (const dir of ['identities', 'cards', 'mailboxes', 'limits', 'reports']) {
      mkdirSync(join(this.root, dir), { recursive: true });
    }
    const secretPath = join(this.root, 'secret');
    if (!existsSync(secretPath)) {
      writeFileSync(secretPath, randomBytes(32).toString('hex'));
    }
    this.secret = readFileSync(secretPath, 'utf-8').trim();
  }

  // ---------- 基础文件操作（原子写 + 防逃逸） ----------

  private resolve(rel: string): string {
    const full = resolvePath(this.root, rel);
    const inside = relative(this.root, full);
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new Error(`非法路径（越出数据目录）：${rel}`);
    }
    return full;
  }

  private writeJson(rel: string, data: unknown): void {
    const full = this.resolve(rel);
    mkdirSync(join(full, '..'), { recursive: true });
    const tmp = `${full}.tmp-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, full);
  }

  private readJson<T>(rel: string): T | null {
    const full = this.resolve(rel);
    if (!existsSync(full)) return null;
    try {
      return JSON.parse(readFileSync(full, 'utf-8')) as T;
    } catch {
      return null; // 半截文件视为不存在（原子写保证正常情况不会发生）
    }
  }

  private listFiles(rel: string): string[] {
    const dir = this.resolve(rel);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json'));
  }

  // ---------- 身份 ----------

  putIdentity(id: StoredIdentity): void {
    this.writeJson(`identities/${hexOf(id.opaque_id)}.json`, id);
  }

  getIdentity(opaqueId: string): StoredIdentity | null {
    return this.readJson<StoredIdentity>(`identities/${hexOf(opaqueId)}.json`);
  }

  /** 注销：级联删除身份 + 广场卡 + 信箱 + 限速计数，返回删除条目数 */
  deleteIdentity(opaqueId: string): number {
    const hex = hexOf(opaqueId);
    let removed = 0;
    if (existsSync(this.resolve(`identities/${hex}.json`))) removed += 1;
    rmSync(this.resolve(`identities/${hex}.json`), { force: true });
    if (existsSync(this.resolve(`cards/${hex}.json`))) removed += 1;
    rmSync(this.resolve(`cards/${hex}.json`), { force: true });
    const boxDir = this.resolve(`mailboxes/${hex}`);
    if (existsSync(boxDir)) {
      removed += readdirSync(boxDir).length;
      rmSync(boxDir, { recursive: true, force: true });
    }
    // 注销即清空"关于我的举报记录"——人走了，还挂着别人对他的举报没有意义
    if (existsSync(this.resolve(`reports/${hex}.json`))) {
      removed += 1;
      rmSync(this.resolve(`reports/${hex}.json`), { force: true });
    }
    for (const f of this.listFiles('limits')) {
      if (f.startsWith(`${hex}-`)) {
        rmSync(this.resolve(`limits/${f}`), { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  // ---------- 广场卡（一人一卡） ----------

  putCard(opaqueId: string, card: StoredCard): void {
    this.writeJson(`cards/${hexOf(opaqueId)}.json`, card);
  }

  getCardByOwner(opaqueId: string): StoredCard | null {
    return this.readJson<StoredCard>(`cards/${hexOf(opaqueId)}.json`);
  }

  /** 按内容指纹找卡（小规模全扫；规模上升后建索引——V2 存储升级路径） */
  findCardByFingerprint(fingerprint: string): StoredCard | null {
    for (const f of this.listFiles('cards')) {
      const card = this.readJson<StoredCard>(`cards/${f}`);
      if (card && cardFingerprintOf(card.envelope) === fingerprint) return card;
    }
    return null;
  }

  /** 哑管道全量池：按 uploaded_at 键集分页，零过滤零排序（仅为分页确定性） */
  listCards(cursor: string | null, limit: number): Page<StoredCard> {
    const all = this.listFiles('cards')
      .map((f) => this.readJson<StoredCard>(`cards/${f}`))
      .filter((c): c is StoredCard => c !== null)
      .sort((a, b) => (a.uploaded_at === b.uploaded_at ? 0 : a.uploaded_at < b.uploaded_at ? -1 : 1));
    const start = cursor ? all.findIndex((c) => cursorKey(c) === cursor) + 1 : 0;
    const items = all.slice(start, start + limit);
    const last = items[items.length - 1];
    const next = start + limit < all.length && last ? cursorKey(last) : null;
    return { items, next_cursor: next };
  }

  deleteCard(opaqueId: string): boolean {
    const path = this.resolve(`cards/${hexOf(opaqueId)}.json`);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  // ---------- 信箱 ----------

  /** 存入信封，返回信箱内 ID（= 信封自身 card_id） */
  putEnvelope(opaqueId: string, env: StoredEnvelope): string {
    const id = env.envelope.meta.card_id;
    this.writeJson(`mailboxes/${hexOf(opaqueId)}/${id}.json`, env);
    return id;
  }

  listEnvelopes(opaqueId: string, cursor: string | null, limit: number): Page<StoredEnvelope> {
    const all = this.listFiles(`mailboxes/${hexOf(opaqueId)}`)
      .map((f) => this.readJson<StoredEnvelope>(`mailboxes/${hexOf(opaqueId)}/${f}`))
      .filter((e): e is StoredEnvelope => e !== null)
      .sort((a, b) => (a.delivered_at === b.delivered_at ? 0 : a.delivered_at < b.delivered_at ? -1 : 1));
    const start = cursor ? all.findIndex((e) => e.envelope.meta.card_id === cursor) + 1 : 0;
    const items = all.slice(start, start + limit);
    const last = items[items.length - 1];
    const next = start + limit < all.length && last ? last.envelope.meta.card_id : null;
    return { items, next_cursor: next };
  }

  deleteEnvelope(opaqueId: string, envelopeId: string): boolean {
    let path: string;
    try {
      path = this.resolve(`mailboxes/${hexOf(opaqueId)}/${envelopeId}.json`);
    } catch {
      return false; // 畸形 ID（含路径分隔/逃逸）按"不存在"处理，不抛 500
    }
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  /** 信箱内是否已有该 ID 的信（防同 card_id 覆盖投递——收件箱条目不可被第三方顶掉） */
  hasEnvelope(opaqueId: string, envelopeId: string): boolean {
    try {
      return existsSync(this.resolve(`mailboxes/${hexOf(opaqueId)}/${envelopeId}.json`));
    } catch {
      return false;
    }
  }

  // ---------- 限速（每日投递计数） ----------

  /** 计数 +1，返回当日累计（调用方负责与 MAX_DAILY_DELIVERIES 比较） */
  bumpDeliveryCount(opaqueId: string, day: string): number {
    const rel = `limits/${hexOf(opaqueId)}-${day}.json`;
    const cur = this.readJson<{ count: number }>(rel)?.count ?? 0;
    const next = cur + 1;
    this.writeJson(rel, { count: next });
    return next;
  }

  // ---------- 举报（行为信号，不涉内容） ----------

  /** 举报人假名（加盐；可去重、不可反查） */
  private reporterTag(opaqueId: string): string {
    const bytes = new TextEncoder().encode(`${this.secret}|report|${opaqueId}`);
    return Buffer.from(sha256(bytes)).toString('hex').slice(0, 32);
  }

  /**
   * 记一次举报。同一加盐假名重复举报只算一次——否则一个人刷 3 次就能把人标记掉。
   * 返回最新汇总（调用方决定怎么呈现，服务端不做裁决）。
   */
  addReport(targetOpaqueId: string, reporterOpaqueId: string, reason: string, now: number = Date.now()): ReportSummary {
    const rel = `reports/${hexOf(targetOpaqueId)}.json`;
    const cur = this.readJson<StoredReports>(rel) ?? { target_opaque_id: targetOpaqueId, reports: [] };
    const tag = this.reporterTag(reporterOpaqueId);
    if (!cur.reports.some((r) => r.reporter_tag === tag)) {
      cur.reports.push({ reporter_tag: tag, reason, at: new Date(now).toISOString() });
      this.writeJson(rel, cur);
    }
    return this.getReportSummary(targetOpaqueId);
  }

  getReportSummary(targetOpaqueId: string): ReportSummary {
    const cur = this.readJson<StoredReports>(`reports/${hexOf(targetOpaqueId)}.json`);
    if (!cur) return { reports: 0, distinct: 0, flagged: false };
    const distinct = new Set(cur.reports.map((r) => r.reporter_tag)).size;
    return { reports: cur.reports.length, distinct, flagged: distinct >= REPORT_FLAG_THRESHOLD };
  }

  /** 匿名实例聚合（M4 透明度：只有总和，没有任何个体数据） */
  stats(now: number = Date.now()): InstanceStats {
    let envelopes = 0;
    for (const box of safeReaddirs(this.resolve('mailboxes'))) {
      envelopes += this.listFiles(`mailboxes/${box}`).length;
    }
    let reported = 0;
    let flagged = 0;
    for (const f of this.listFiles('reports')) {
      const cur = this.readJson<StoredReports>(`reports/${f}`);
      if (!cur) continue;
      reported += 1;
      if (new Set(cur.reports.map((r) => r.reporter_tag)).size >= REPORT_FLAG_THRESHOLD) flagged += 1;
    }
    return {
      identities: this.listFiles('identities').length,
      cards: this.listFiles('cards').length,
      envelopes,
      reported_targets: reported,
      flagged_targets: flagged,
      generated_at: new Date(now).toISOString(),
    };
  }

  // ---------- TTL 清扫 ----------

  /** 删除过期广场卡与超期信箱信封；返回清理计数 */
  sweepExpired(now: number = Date.now()): { cards: number; envelopes: number } {
    let cards = 0;
    let envelopes = 0;
    for (const f of this.listFiles('cards')) {
      const card = this.readJson<StoredCard>(`cards/${f}`);
      if (card && Date.parse(card.envelope.meta.expires_at) < now) {
        rmSync(this.resolve(`cards/${f}`), { force: true });
        cards += 1;
      }
    }
    const retentionMs = MAILBOX_RETENTION_DAYS * 86400_000;
    for (const box of safeReaddirs(this.resolve('mailboxes'))) {
      for (const f of this.listFiles(`mailboxes/${box}`)) {
        const env = this.readJson<StoredEnvelope>(`mailboxes/${box}/${f}`);
        if (env && now - Date.parse(env.delivered_at) > retentionMs) {
          rmSync(this.resolve(`mailboxes/${box}/${f}`), { force: true });
          envelopes += 1;
        }
      }
    }
    return { cards, envelopes };
  }
}

function safeReaddirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function cursorKey(card: StoredCard): string {
  return `${card.uploaded_at}|${hexOf(card.envelope.meta.owner_key_id)}`;
}

/**
 * 卡指纹 = SHA-256(canonical(信封)) 前 16 hex——与 core.cardFingerprint 同口径
 * （纯哈希，无任何解密；服务端可安全重算以支持按指纹撤卡）。
 */
export function cardFingerprintOf(card: MatchCardEnvelope): string {
  const bytes = new TextEncoder().encode(canonicalize(card));
  return Buffer.from(sha256(bytes)).toString('hex').slice(0, 16);
}
