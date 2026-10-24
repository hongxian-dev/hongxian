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
 *   ├── reports/<opaqueHex>.json          举报（加盐假名，无人名）
 *   ├── blocks/<opaqueHex>.json           阻断（举报即断，双向两条；同样是加盐标记）
 *   ├── publish/<carrierHmac>.json        发布许可（身份凭据环；载体指纹 + 假名公钥）
 *   ├── publish-owner/<opaqueHex>.json    反向索引：假名公钥 → 载体指纹（一对一）
 *   └── secret                            实例秘密（启动时生成）
 *
 * 铁律：本包不得 import 任何解密能力（@hongxian/crypto 整体、sealBox/openBox、
 * key_l1 消费）——零知识审计测试（test/audit.test.ts）对此做源码级断言。
 * 允许的密码学操作仅限 Ed25519 验签、SHA-256 纯哈希与 HMAC（均以"加盐假名"为目的，
 * 不产生任何可用于反解内容的材料）。
 *
 * 身份凭据环（《实名制处理口径决策备忘》§8）：publish* 三个目录**永不与其他目录 join**。
 * 它们与其他表之间唯一的关联是 opaque_id 本身，而这个关联存在的理由只有一个——
 * 「这张卡的主人确实验证过一个能收信的载体」。
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
  PUBLISH_CHALLENGE_TTL_SEC,
  REPORT_FLAG_THRESHOLD,
  canonicalize,
  type MatchCardEnvelope,
  type MsgEnvelope,
} from '@hongxian/schema';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';

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

/**
 * 阻断记录（「举报即断」，D7 / C2②）。
 *
 * 每份文件归属**一个** owner（文件名即 owner 的 hex，故文件里不再重复存 owner 本身），
 * 里面只放 `HMAC(secret, "block|owner|对方")` 式的加盐标记——和举报记录同一手法：
 * 能判"这对是不是断了"，但拖走数据目录也还原不出"谁断了谁"。
 */
export interface StoredBlocks {
  blocks: { tag: string; reason: string; at: string }[];
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

/**
 * 发布许可（身份凭据环）。
 *
 * `carrier_hmac` 是 `HMAC-SHA256(实例 secret, "carrier|<标准化载体>")` 的 hex：
 * 同一邮箱永远得到同一个值（可判重、可防一女巫多号），但没有 secret 就反解不出邮箱。
 * 注意这**不是**为了保护"邮箱是敏感信息"这么简单——它是把
 * 「平台知道某假名对应某邮箱」压缩成「平台知道某假名对应某串无法反解的字节」，
 * 与举报人假名（reporterTag）同一手法。
 */
export interface StoredPublishCredential {
  carrier_hmac: string;
  owner_key_id: string;
  verified_at: string;
  /**
   * 贴卡时展示过的披露声明版本（防护三 / C2③）。
   *
   * 只存版本号，不存声明全文——全文是常量，存一份副本只会出现"库里那份是不是旧的"。
   * 它的用途只有一个：事后能证明"这个人在贴卡时看到的是哪一版丑话"。
   */
  disclosure_version?: string;
}

/** 待验证挑战：一次贴卡尝试对应一个 nonce，验证通过后铸出一次性许可码 */
export interface StoredPublishChallenge {
  nonce: string;
  /** 首次 /otp 时写入；未发码时不存在 */
  carrier_hmac?: string;
  /** 验证码的 HMAC（不存明文验证码，避免数据目录被拖走后直接盗用） */
  code_hmac?: string;
  code_expires_at?: string;
  /** 已发码次数（同一 nonce 有上限，给"没收到"留重试余量） */
  otp_sent: number;
  /** 上次发码时间（冷却计算用；不存 IP、不存 UA） */
  last_otp_at?: string;
  /** 验证码连续输错次数（达到上限即作废，不区分"码错"与"码过期"的提示） */
  attempts: number;
  created_at: string;
  /** 验证码已通过的时间；存在即"可认领" */
  verified_at?: string;
  /** 许可码的 HMAC 与认领窗口 */
  permit_hmac?: string;
  permit_expires_at?: string;
}

/** 注销时级联删除的载体指纹（供调用方核对，不对外） */
export interface PublishSummary {
  verified: boolean;
  verified_at?: string;
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
    for (const dir of [
      'identities',
      'cards',
      'mailboxes',
      'limits',
      'reports',
      'blocks',
      'publish',
      'publish-owner',
      'publish-challenges',
    ]) {
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
    // 同理：我自己名下的阻断记录一并清掉（断谁不断谁，没有归档的价值）
    if (existsSync(this.resolve(`blocks/${hex}.json`))) {
      removed += 1;
      rmSync(this.resolve(`blocks/${hex}.json`), { force: true });
    }
    // 发布许可一并删除（决策备忘 §5.4）：载体指纹留着只会让"这个邮箱已绑过号"变成
    // 一个用户无法解除的残留；删掉之后同一邮箱可以重新绑定新身份。
    removed += this.deleteCredential(opaqueId) ? 1 : 0;
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

  // ---------- 举报即断（D7 / C2②） ----------

  /**
   * 阻断标记 = HMAC(secret, "block|<被阻断方>|<对方>")。
   *
   * 为什么不直接存对方的 opaque_id：那等于在数据目录里留下一张
   * 「谁断了谁」的明表——拖走数据目录就能还原关系图。加盐后，
   * 拖走目录的人只能看到"某个身份有 N 条阻断记录"，看不到断的是谁，
   * 也无法跨身份关联。这与举报记录用加盐假名是同一条纪律。
   */
  private blockTag(ownerOpaqueId: string, otherOpaqueId: string): string {
    const key = new TextEncoder().encode(this.secret);
    const msg = new TextEncoder().encode(`block|${ownerOpaqueId}|${otherOpaqueId}`);
    return Buffer.from(hmac(sha256, key, msg)).toString('hex').slice(0, 32);
  }

  /** 写一条阻断（单向；双向闭合由调用方写两条） */
  putBlock(ownerOpaqueId: string, otherOpaqueId: string, reason: string, now: number = Date.now()): void {
    const rel = `blocks/${hexOf(ownerOpaqueId)}.json`;
    const cur = this.readJson<StoredBlocks>(rel) ?? { blocks: [] };
    const tag = this.blockTag(ownerOpaqueId, otherOpaqueId);
    // 幂等：同一对重复举报不再追加（否则重复举报会把自己的记录刷成一串）
    if (!cur.blocks.some((b) => b.tag === tag)) {
      cur.blocks.push({ tag, reason, at: new Date(now).toISOString() });
      this.writeJson(rel, cur);
    }
  }

  /** 投递前置检查：owner 是否已阻断 sender（双向闭合已由两条记录覆盖） */
  isBlocked(ownerOpaqueId: string, senderOpaqueId: string): boolean {
    if (ownerOpaqueId === senderOpaqueId) return false;
    const cur = this.readJson<StoredBlocks>(`blocks/${hexOf(ownerOpaqueId)}.json`);
    if (!cur) return false;
    const tag = this.blockTag(ownerOpaqueId, senderOpaqueId);
    return cur.blocks.some((b) => b.tag === tag);
  }

  /** 该身份名下的阻断条数（只给运营侧看总量，不对外） */
  blockCount(ownerOpaqueId: string): number {
    return this.readJson<StoredBlocks>(`blocks/${hexOf(ownerOpaqueId)}.json`)?.blocks.length ?? 0;
  }

  // ---------- 发布许可（身份凭据环；永不与其他环 join） ----------

  /**
   * 载体指纹 = HMAC-SHA256(实例 secret, "carrier|<标准化载体>")。
   *
   * 为什么用 HMAC 而不用裸 SHA-256：邮箱空间太小（几十亿量级），裸哈希可以
   * 用彩虹表直接反查。加盐后，**只有持有实例 secret 的人才算得出来**——
   * 而 secret 不进任何响应、不进任何日志，只在数据目录里（`secret` 文件）。
   * 也就是说：拖走数据目录的人拿不到 secret（除非连 secret 一起拖走），
   * 这种情况下他能反查邮箱，但同样能伪造举报假名——两个风险同一个量级，
   * 已写进隐私声明，不粉饰。
   */
  carrierHmac(carrier: string): string {
    const key = new TextEncoder().encode(this.secret);
    const msg = new TextEncoder().encode(`carrier|${carrier}`);
    return Buffer.from(hmac(sha256, key, msg)).toString('hex');
  }

  /**
   * 验证码摘要 / 许可码摘要。域前缀区分两类，避免"把许可码填进验证码框"这类
   * 跨用途碰撞（否则两个 5–6 位短串在同一摘要空间里混用）。
   */
  publishCodeTag(nonce: string, code: string): string {
    return this.tag('code', nonce, code);
  }

  publishPermitTag(nonce: string, permit: string): string {
    return this.tag('permit', nonce, permit);
  }

  private tag(kind: 'code' | 'permit', nonce: string, value: string): string {
    const key = new TextEncoder().encode(this.secret);
    const msg = new TextEncoder().encode(`${kind}|${nonce}|${value}`);
    return Buffer.from(hmac(sha256, key, msg)).toString('hex').slice(0, 32);
  }

  private challengeRel(nonce: string): string {
    return `publish-challenges/${Buffer.from(nonce, 'utf-8').toString('hex')}.json`;
  }

  getChallenge(nonce: string): StoredPublishChallenge | null {
    return this.readJson<StoredPublishChallenge>(this.challengeRel(nonce));
  }

  putChallenge(challenge: StoredPublishChallenge): void {
    this.writeJson(this.challengeRel(challenge.nonce), challenge);
  }

  deleteChallenge(nonce: string): void {
    rmSync(this.resolve(this.challengeRel(nonce)), { force: true });
  }

  /** 载体每日发码计数 +1（只计不判——阈值由调用方决定，服务端不隐藏策略） */
  bumpOtpCount(carrierHmac: string, day: string): number {
    const rel = `limits/otp-${carrierHmac}-${day}.json`;
    const cur = this.readJson<{ count: number }>(rel)?.count ?? 0;
    const next = cur + 1;
    this.writeJson(rel, { count: next });
    return next;
  }

  /** 按假名公钥取发布许可（贴卡门闩用；持钥人只能查到自己这一条） */
  getPublishCredential(ownerKeyId: string): StoredPublishCredential | null {
    const index = this.readJson<{ carrier_hmac: string }>(`publish-owner/${hexOf(ownerKeyId)}.json`);
    if (!index) return null;
    const cred = this.readJson<StoredPublishCredential>(`publish/${index.carrier_hmac}.json`);
    // 索引与凭据必须互指（半截状态按"未验证"处理——宁可误拒不可误放）
    if (!cred || cred.carrier_hmac !== index.carrier_hmac) return null;
    if (cred.owner_key_id !== ownerKeyId) return null;
    return cred;
  }

  hasPublishCredential(ownerKeyId: string): boolean {
    return this.getPublishCredential(ownerKeyId) !== null;
  }

  /** 按载体指纹查（判"这个邮箱是否已绑了别人"；一对一约束的另一半） */
  findPublishCredentialByCarrier(carrierHmac: string): StoredPublishCredential | null {
    return this.readJson<StoredPublishCredential>(`publish/${carrierHmac}.json`);
  }

  putPublishCredential(
    ownerKeyId: string,
    carrierHmac: string,
    disclosureVersion?: string,
    now: number = Date.now(),
  ): StoredPublishCredential {
    const cred: StoredPublishCredential = {
      carrier_hmac: carrierHmac,
      owner_key_id: ownerKeyId,
      verified_at: new Date(now).toISOString(),
      ...(disclosureVersion ? { disclosure_version: disclosureVersion } : {}),
    };
    this.writeJson(`publish/${carrierHmac}.json`, cred);
    this.writeJson(`publish-owner/${hexOf(ownerKeyId)}.json`, { carrier_hmac: carrierHmac });
    return cred;
  }

  /**
   * 解绑：物理删除，不留 revoked_at 墓碑。
   *
   * 决策备忘 §5.1 原本设计了 `revoked_at` 字段，实现时改为直接删除：
   * 留墓碑的唯一用途是"审计谁曾经绑过什么"，而本项目没有那个场景，
   * 却会永久保留一条"某邮箱曾绑定某假名"的关联——违反最小化。
   * 代价是解绑后无法向用户证明"曾经绑过"，由客户端本地账本承担。
   */
  deleteCredential(ownerKeyId: string): boolean {
    const index = this.readJson<{ carrier_hmac: string }>(`publish-owner/${hexOf(ownerKeyId)}.json`);
    let removed = false;
    if (index) {
      const cred = this.readJson<StoredPublishCredential>(`publish/${index.carrier_hmac}.json`);
      // 只删"确实属于本人"的那条——防索引被写坏时误删他人许可
      if (cred && cred.owner_key_id === ownerKeyId) {
        rmSync(this.resolve(`publish/${index.carrier_hmac}.json`), { force: true });
        removed = true;
      }
    }
    const indexPath = this.resolve(`publish-owner/${hexOf(ownerKeyId)}.json`);
    if (existsSync(indexPath)) {
      rmSync(indexPath, { force: true });
      removed = true;
    }
    return removed;
  }

  // ---------- 匿名实例聚合（M4 透明度：只有总和，没有任何个体数据） ----------
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

  /** 删除过期广场卡、超期信箱信封与作废的发布挑战；返回清理计数 */
  sweepExpired(now: number = Date.now()): { cards: number; envelopes: number; challenges: number } {
    let cards = 0;
    let envelopes = 0;
    let challenges = 0;
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
    // 挑战：过了总存活期就作废（含已铸许可码但用户一直不回来认领的情况——
    // 许可码窗口只有 10 分钟，超时即失败，界面必须允许重来，不允许"等一等就好了"）
    const challengeTtlMs = PUBLISH_CHALLENGE_TTL_SEC * 1000;
    for (const f of this.listFiles('publish-challenges')) {
      const ch = this.readJson<StoredPublishChallenge>(`publish-challenges/${f}`);
      if (ch && now - Date.parse(ch.created_at) > challengeTtlMs) {
        rmSync(this.resolve(`publish-challenges/${f}`), { force: true });
        challenges += 1;
      }
    }
    return { cards, envelopes, challenges };
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
