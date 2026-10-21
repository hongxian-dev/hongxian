/**
 * 红线协议 v0.4 · 匹配卡信封（Schema 规范 §2/§3 的 Zod 实现）
 *
 * 一张匹配卡 = 一个 JSON 文件：
 *   meta（明文）+ payload_L1/L2/L3（AES-256-GCM 密文）+ Ed25519 signature
 * 三层物理隔离于三个独立加密 payload——不存在"一张明文卡靠权限控制"的设计。
 *
 * v0.4 关键修订（平台服务 V6，零知识军规）：key_l1 的携带规则按 card_type 分流——
 *   match_card（文件直交，熟人链）：key_l1 随卡交付，导入方持卡即解 L1；
 *   plaza_card（广场卡，经服务端存储转发）：**严禁携带 key_l1**——
 *     钥匙随 blob 上传即使服务端可解密 L1，违反宪法§4"平台能接触到的最多只是
 *     公钥 + 加密 blob，无法解密内容"。广场卡的 L1 经 grant_l1 信封密封交付
 *     （见 messages.ts），"解锁一阶"成为显式授权动作。
 */

import { z } from 'zod';
import {
  AGE_BANDS,
  ASSET_STATES,
  CARD_TYPES,
  CHILDBEARING_INTENTS,
  COHABIT_INTENTS,
  DEALBREAKER_DIMENSIONS,
  ECON_SIGNALS,
  EDUCATION_BANDS,
  EXERCISE_LEVELS,
  GENDERS,
  GOALS,
  HABIT_LEVELS,
  HEIGHT_BANDS,
  INCOME_BANDS,
  INTERESTS,
  JOB_CATEGORIES,
  MARITAL_STATUSES,
  MODEL_TIERS,
  MONEY_VIEWS,
  PARENTS_RELATIONS,
  SLEEP_TYPES,
  SOCIAL_LEVELS,
  VALUES_TAGS,
} from './vocab.js';
import { isBase64OfLength, isUuidV7 } from './canonical.js';

export const SCHEMA_VERSION = 1;

/** 算法声明常量（组装 meta 时使用；校验由字段级 AlgoDeclaration 完成） */
export const ALGO_DECLARATION = {
  sig: 'ed25519',
  aead: 'aes-256-gcm',
  kex: 'x25519',
} as const;

/** meta 字段（Schema §2 meta.algo）：算法声明固定，字段级锁定（比 z.literal(对象) 更精确） */
export const AlgoDeclaration = z.object({
  sig: z.literal('ed25519'),
  aead: z.literal('aes-256-gcm'),
  kex: z.literal('x25519'),
});
export type AlgoDeclaration = z.infer<typeof AlgoDeclaration>;

/**
 * 一个 AES-256-GCM 密文块。ct = ciphertext || tag(16B) 拼接后 base64。
 * nonce 为空字符串 = sealed box 模式（定向消息：ephPub||nonce||ct 整体存于 ct，见 core sealMessageBody）。
 */
export const CipherBlock = z.object({
  nonce: z.string(), // 12 字节随机 nonce 的 base64；空 = sealed box
  ct: z.string().min(1), // ciphertext||tag（或整个 sealed box）的 base64
});
export type CipherBlock = z.infer<typeof CipherBlock>;

/** meta · 画像深度标记（D7：供对方月老标注报告置信度） */
export const CardDepth = z.object({
  interview_rounds: z.number().int().min(0).max(100),
  completeness: z.number().min(0).max(1),
  model_tier: z.enum(MODEL_TIERS),
});
export type CardDepth = z.infer<typeof CardDepth>;

/** meta · 明文元数据（任何人可读） */
export const CardMeta = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  card_id: z.string().refine(isUuidV7, { message: 'card_id 必须是 UUIDv7' }),
  owner_key_id: z
    .string()
    .refine((s) => isBase64OfLength(s, 32), { message: 'owner_key_id 必须是 32 字节指纹的 base64' }),
  /**
   * Ed25519 签名公钥（32B base64）——验签必需。
   * 工程补注：Schema v0.3 §2 字段表未列，但 §6/技术详设 §4 要求"公钥随 match_card
   * 元数据交换"（换卡即换公钥）。公钥是公开密码学参数、非身份信息，
   * 信任模型 = TOFU（introducer_sig 已 @deprecated，2026-10-20 D8 修订裁撤介绍人链）。
   */
  sig_public: z
    .string()
    .refine((s) => isBase64OfLength(s, 32), { message: 'sig_public 必须是 32 字节公钥的 base64' }),
  /** X25519 协商公钥（32B base64）——grant 类信封的收件人密钥 */
  kx_public: z
    .string()
    .refine((s) => isBase64OfLength(s, 32), { message: 'kx_public 必须是 32 字节公钥的 base64' }),
  version: z.number().int().min(1),
  created_at: z.string().datetime({ message: 'ISO 8601 时间戳' }),
  expires_at: z.string().datetime({ message: 'ISO 8601 时间戳' }),
  card_type: z.enum(CARD_TYPES),
  depth: CardDepth,
  introducer_sig: z.string().optional(), // @deprecated 2026-10-20 D8 修订：介绍人链裁撤（分发半径唯一模型=声明式圈层），编号保留不复用，v0.5 移除
  algo: AlgoDeclaration,
});
export type CardMeta = z.infer<typeof CardMeta>;

// ---------- Payload L1 · 公开层（名片层） ----------

export const EconSignal = z.array(z.enum(ECON_SIGNALS)).max(ECON_SIGNALS.length);
export type EconSignal = z.infer<typeof EconSignal>;

export const PayloadL1 = z.object({
  nickname: z.string().min(1).max(20),
  gender: z.enum(GENDERS),
  seeking: z.enum(GENDERS),
  age_attested: z.literal(true), // 成年承诺：必填 true 才可签发（v0.3，未成年人保护法律要求）
  age_band: z.enum(AGE_BANDS),
  city: z.object({
    code: z.string().regex(/^\d{6}$/, '市级行政区代码为 6 位国标码（GB/T 2260）'),
    name: z.string().min(2).max(10),
  }),
  height_band: z.enum(HEIGHT_BANDS),
  marital_status: z.enum(MARITAL_STATUSES),
  job_category: z.enum(JOB_CATEGORIES),
  education_band: z.enum(EDUCATION_BANDS),
  interests: z.array(z.enum(INTERESTS)).max(5),
  bio: z.string().max(100),
  goal: z.enum(GOALS),
  econ_signal: EconSignal,
});
export type PayloadL1 = z.infer<typeof PayloadL1>;

// ---------- Payload L2 · 匹配层（深聊层） ----------

export const ValueTag = z.object({
  tag: z.enum(VALUES_TAGS),
  weight: z.number().min(0).max(1),
});

export const Dealbreaker = z.object({
  dimension: z.enum(DEALBREAKER_DIMENSIONS),
  note: z.string().max(50),
});

export const ValuesQA = z.object({
  question: z.string().max(200),
  answer: z.string().max(200),
});

export const PayloadL2 = z.object({
  values_tags: z.array(ValueTag).max(8),
  lifestyle: z.object({
    sleep: z.enum(SLEEP_TYPES),
    smoking: z.enum(HABIT_LEVELS),
    drinking: z.enum(HABIT_LEVELS),
    exercise: z.enum(EXERCISE_LEVELS),
    social: z.enum(SOCIAL_LEVELS),
  }),
  family_view: z.object({
    parents_relation: z.enum(PARENTS_RELATIONS),
    childbearing: z.enum(CHILDBEARING_INTENTS),
    cohabit_with_parents: z.enum(COHABIT_INTENTS),
  }),
  money_view: z.enum(MONEY_VIEWS),
  assets_brief: z.object({
    house: z.enum(ASSET_STATES),
    car: z.enum(ASSET_STATES),
  }),
  income_band: z.enum(INCOME_BANDS).optional(), // 可整字段缺省（Schema §8 拍板②）
  dealbreakers: z.array(Dealbreaker).max(5),
  values_qa: z.array(ValuesQA).min(3).max(5), // 报告引用原话的证据源（D6）
  partner_pref: z.string().max(150),
});
export type PayloadL2 = z.infer<typeof PayloadL2>;

// ---------- Payload L3 · 私密层（见面层，整体可缺省，逐字段 opt-in） ----------

/** 照片不进卡：仅存本地密文文件的哈希 + 解密密钥，原图经同一信道另行传输（Schema §3.3） */
export const PhotoRef = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 十六进制'),
  key: z.string().min(1), // 照片密文的解密密钥（base64），随本层加密交付
});

export const PayloadL3 = z.object({
  contact_wechat: z.string().max(64).optional(),
  contact_phone: z.string().max(32).optional(),
  real_name: z.string().max(20).optional(),
  employer_category: z.enum(JOB_CATEGORIES).optional(), // 工作单位大类，不收精确单位名
  hangout_areas: z.array(z.string().max(20)).max(5).optional(), // 常去区域，到商圈为止
  photo_refs: z.array(PhotoRef).max(3).optional(),
});
export type PayloadL3 = z.infer<typeof PayloadL3>;

/** L3 字段名白名单（D13：见面层字段逐一 opt-in，支持"给微信号但不给手机号"） */
export const L3_FIELD_NAMES = [
  'contact_wechat',
  'contact_phone',
  'real_name',
  'employer_category',
  'hangout_areas',
  'photo_refs',
] as const;

export type L3FieldName = (typeof L3_FIELD_NAMES)[number];

/**
 * L3 层的加密内层结构（v1.1，逐字段独立密文）：
 * payload_L3 解封后的明文就是这个容器——`fields[name]` 各自用
 * `HKDF(L3 层密钥, "l3/<name>")` 派生的子密钥加密。
 *
 * 为什么多加这一层：单块 L3 只能"整层交付"，交钥匙即交全部字段，
 * 与 D13「每字段独立开关」直接冲突。加上内层容器后，grant_l3 只需
 * 交付被授权字段的子密钥——其余字段的密文他拿到了也打不开。
 *
 * 向后兼容：v1.0 卡片的 payload_L3 解封后是裸 PayloadL3（无 v/fields），
 * 读取方按"整体明文"处理即可（零迁移）。
 */
export const L3_FIELD_LABEL_PREFIX = 'l3/';

export const L3SealedContainer = z.object({
  v: z.literal(1),
  fields: z.record(z.string(), CipherBlock),
});
export type L3SealedContainer = z.infer<typeof L3SealedContainer>;

/** 判断 L3 明文是逐字段容器还是 v1.0 裸明文 */
export function isL3SealedContainer(value: unknown): value is L3SealedContainer {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { v?: unknown }).v === 1 &&
    typeof (value as { fields?: unknown }).fields === 'object' &&
    (value as { fields?: unknown }).fields !== null
  );
}

// ---------- 信封整体 ----------

export const MatchCardEnvelope = z
  .object({
    meta: CardMeta,
    /**
     * key_L1 明文携带（Schema §8 拍板①：L1 也加密——广场爬虫拿不到结构化明文，
     * 格式三层统一，代价为零）。一阶名片即公开层：任何人拿到卡可解出 L1。
     * v0.4 起仅 match_card（文件直交）允许携带；plaza_card 严禁（见下方 superRefine）。
     */
    key_l1: z.string().optional(),
    payload_L1: CipherBlock,
    payload_L2: CipherBlock,
    payload_L3: CipherBlock.optional(), // 整体可缺省（未到见面层）
    signature: z.string().min(1), // Ed25519 对 meta + key_l1 + 三个密文整体签名
  })
  .superRefine((env, ctx) => {
    // v0.4 零知识军规（平台服务工程设计 V6）：广场卡剥离 key_l1。
    // 签名覆盖 meta（含 card_type），故"match_card 剥 key_l1 改标 plaza_card"会验签失败——
    // 降级攻击在密码学层面即被阻止，此处是生产者侧的格式闸门。
    if (env.meta.card_type === 'plaza_card' && env.key_l1 !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['key_l1'],
        message:
          '广场卡（plaza_card）不得携带 key_l1——服务端不得持有可解密 L1 的材料（零知识军规，Schema v0.4）',
      });
    }
  });
export type MatchCardEnvelope = z.infer<typeof MatchCardEnvelope>;

/** 是否广场卡变体（经服务端存储转发、无 key_l1 的匹配卡） */
export function isPlazaCard(card: { meta: { card_type: string } }): boolean {
  return card.meta.card_type === 'plaza_card';
}

/** 签名对象：canonical(meta || key_l1 || 三个密文) */
export function signatureObject(card: {
  meta: unknown;
  key_l1?: string;
  payload_L1: CipherBlock;
  payload_L2: CipherBlock;
  payload_L3?: CipherBlock;
}): unknown {
  return {
    meta: card.meta,
    ...(card.key_l1 ? { key_l1: card.key_l1 } : {}),
    payload_L1: card.payload_L1,
    payload_L2: card.payload_L2,
    ...(card.payload_L3 ? { payload_L3: card.payload_L3 } : {}),
  };
}

// ---------- 校验与容错（Schema §7） ----------

export interface ValidationResult<T> {
  ok: boolean;
  data?: T;
  errors: string[];
  /** 未知字段告警（§7.2：一律忽略并告警，向前兼容） */
  warnings: string[];
}

/**
 * 带容错的信封校验：未知字段忽略并告警（向前兼容，§7.2）。
 * 顶层未知键与各子对象内的未知键分别收集；剥离未知字段后严格校验。
 */
export function validateEnvelope(input: unknown): ValidationResult<MatchCardEnvelope> {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['信封必须是 JSON 对象'], warnings };
  }
  const env = input as Record<string, unknown>;

  // 顶层未知键告警
  const TOP_KEYS = new Set(['meta', 'payload_L1', 'payload_L2', 'payload_L3', 'key_l1', 'signature']);
  for (const key of Object.keys(env)) {
    if (!TOP_KEYS.has(key)) warnings.push(`未知字段已忽略：${key}（协议向前兼容）`);
  }

  // 子对象未知键告警 + 剥离
  const subShapes: Record<string, Record<string, unknown>> = {
    meta: CardMeta.shape,
    payload_L1: CipherBlock.shape,
    payload_L2: CipherBlock.shape,
    payload_L3: CipherBlock.shape,
  };
  const cleaned: Record<string, unknown> = {};
  for (const [part, shape] of Object.entries(subShapes)) {
    const value = env[part];
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      cleaned[part] = value;
      continue;
    }
    const cleanPart: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k in shape) cleanPart[k] = v;
      else warnings.push(`未知字段已忽略：${part}.${k}（协议向前兼容）`);
    }
    cleaned[part] = cleanPart;
  }
  if (env.signature !== undefined) cleaned.signature = env.signature;
  if (env.key_l1 !== undefined) cleaned.key_l1 = env.key_l1;

  const result = MatchCardEnvelope.safeParse(cleaned);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    return { ok: false, errors, warnings };
  }
  return { ok: true, data: result.data, errors, warnings };
}

/** TTL 检查（到期需重签；未过期返回剩余毫秒，过期返回负值） */
export function ttlRemainingMs(meta: { expires_at: string }, now: number = Date.now()): number {
  return Date.parse(meta.expires_at) - now;
}

export function isExpired(meta: { expires_at: string }, now: number = Date.now()): boolean {
  return ttlRemainingMs(meta, now) < 0;
}
