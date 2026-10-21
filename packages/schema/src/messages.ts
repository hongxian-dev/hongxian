/**
 * 红线协议 v0.4 · 九类信封消息（Schema 规范 §4）
 *
 * 同一信封格式 + msg_type 区分，全部走 D3/D11/D13 的握手信道。
 * v1 实施：match_card / card_renewal / upgrade_request / grant_l1 /
 *          grant_l2 / topic_pack / answer_card / graduation_invite / grant_l3
 * v2 实施：plaza_card（广场贴卡）/ decline_silent（明确终止信号）
 * 铁律：对称互换（D5）、双盲静默（D4）、追问封顶（D11）、逐字段 opt-in（D13）。
 * v0.4 新增 grant_l1：广场流的一阶解锁（key_l1 密封交付——平台服务 V6 零知识解法）。
 */

import { z } from 'zod';
import { ANSWER_STATUSES, CARD_TYPES, INVITE_RESPONSES, TOPIC_CHANNELS } from './vocab.js';
import { CardDepth, CardMeta, CipherBlock } from './card.js';
import { isBase64OfLength, isUuidV7 } from './canonical.js';

/** 消息信封 meta（与卡片 meta 同构，msg_type 区分） */
export const MsgMeta = CardMeta.extend({
  msg_type: z.enum([
    'match_card',
    'card_renewal',
    'upgrade_request',
    'grant_l1',
    'grant_l2',
    'topic_pack',
    'answer_card',
    'graduation_invite',
    'grant_l3',
    'decline_silent',
    'plaza_card',
  ]),
  /** 对端 card_id（单向消息必填；match_card 等双向消息缺省） */
  target_card_id: z
    .string()
    .refine(isUuidV7, { message: 'target_card_id 必须是 UUIDv7' })
    .optional(),
});
export type MsgMeta = z.infer<typeof MsgMeta>;

/** 信封文件 = 密文 payload + 签名（消息体在 core 层加密后填入） */
export const MsgEnvelope = z.object({
  meta: MsgMeta,
  payload: CipherBlock, // 消息体的密文
  signature: z.string().min(1),
});
export type MsgEnvelope = z.infer<typeof MsgEnvelope>;

// ---------- 消息体（加密前的明文，core 层加密后入 envelope.payload） ----------

/**
 * upgrade_request · 升级请求封：申请解锁（v1=L2，广场流=L1），附本人 match_card（D5/D8）。
 * v0.4：补 requester_kx_public——广场流中卡主需要它把 key_l1 密封回送（grant_l1）。
 */
export const UpgradeRequestBody = z.object({
  from_card_id: z.string().refine(isUuidV7),
  /** 附带的本人名片信封（JSON 序列化后由发送方加密存储引用） */
  attach_card_ref: z.string().min(1).max(200),
  /** 请求方 X25519 协商公钥（32B base64）——卡主据此 sealed box 回送层密钥 */
  requester_kx_public: z
    .string()
    .refine((s) => isBase64OfLength(s, 32), { message: 'requester_kx_public 必须是 32 字节公钥的 base64' }),
});
export type UpgradeRequestBody = z.infer<typeof UpgradeRequestBody>;

/**
 * grant_l1 · 一阶解锁授权（v0.4 新增，平台服务 V6）：
 * 广场卡不带 key_l1；卡主应答升级请求时，把 key_l1 用请求方公钥密封回送。
 * 请求方已持有广场卡密文（payload_L1），只缺钥匙——故无需重传 L1 密文。
 */
export const GrantL1Body = z.object({
  from_card_id: z.string().refine(isUuidV7),
  /** 被解锁的广场卡指纹（cardFingerprint：SHA-256(canonical(card)) 前 16 hex） */
  card_fingerprint: z.string().regex(/^[0-9a-f]{16}$/, 'card_fingerprint 为 16 位十六进制'),
  /** 用请求方 X25519 公钥封装的 key_L1（base64，sealed box） */
  sealed_key_l1: z.string().min(1),
});
export type GrantL1Body = z.infer<typeof GrantL1Body>;

/** grant_l2 · 解锁授权：携带用对方公钥加密的 key_L2（D5） */
export const GrantL2Body = z.object({
  from_card_id: z.string().refine(isUuidV7),
  /** 用对端 X25519 公钥封装的 key_L2（base64） */
  wrapped_key_l2: z.string().min(1),
});
export type GrantL2Body = z.infer<typeof GrantL2Body>;

/** topic_pack · 考题包：1 主题 + ≤2 追问封顶，标注出题方与理由（D10/D11） */
export const TopicPackBody = z.object({
  from_card_id: z.string().refine(isUuidV7),
  round: z.number().int().min(1),
  topic: z.string().min(1).max(100),
  followups: z.array(z.string().max(100)).max(2), // 追问封顶防审讯化（D11）
  reason: z.string().max(200), // 出题理由（D12）
  channel: z.enum(TOPIC_CHANNELS), // 双通道标记：主人想问的 / 月老建议的
});
export type TopicPackBody = z.infer<typeof TopicPackBody>;

/** answer_card · 回卷：结构化答案 / 带回问主人标记 / 婉答标记（D10） */
export const AnswerCardBody = z.object({
  from_card_id: z.string().refine(isUuidV7),
  round: z.number().int().min(1),
  topic_ref: z.string().min(1).max(100),
  status: z.enum(ANSWER_STATUSES),
  answer: z.string().max(500).optional(),
  /** ask_master：该题已带回问主人，画像补全后再答（D10 三态②） */
  note: z.string().max(100).optional(),
});
export type AnswerCardBody = z.infer<typeof AnswerCardBody>;

/** graduation_invite · 毕业邀请封：亲笔短信（可选）+ 申请解锁 L3（D13） */
export const GraduationInviteBody = z.object({
  from_card_id: z.string().refine(isUuidV7),
  /** 主人亲笔短信（可选；月老可代拟草稿但必须由主人确认发出——D13 关键节点） */
  letter: z.string().max(300).optional(),
  /** 申请解锁的 L3 字段清单（见面层字段逐一 opt-in） */
  request_l3_fields: z.array(z.string()).min(1).max(6),
});
export type GraduationInviteBody = z.infer<typeof GraduationInviteBody>;

/** grant_l3 · 见面层解锁：逐字段 opt-in 的密钥交付（D13） */
export const GrantL3Body = z.object({
  from_card_id: z.string().refine(isUuidV7),
  /**
   * 容器密钥（v1.1）：解 payload_L3 外层用，只能解出各字段密文、解不出明文。
   * 缺省时按 v1.0 语义处理（外层 = L3 层密钥，即整层交付）。
   */
  container_key: z.string().min(1).optional(),
  /** 字段名 → 用对端公钥封装的该字段子密钥 */
  fields: z.array(
    z.object({
      field: z.string().min(1).max(40),
      wrapped_key: z.string().min(1),
    }),
  ).min(1).max(6),
});
export type GrantL3Body = z.infer<typeof GrantL3Body>;

/** decline_silent · 婉拒回执：固定内容、不可携带任何信息（防侧信道）——v1 不做，v2 做 */
export const DeclineSilentBody = z.object({
  fixed: z.literal('declined'),
});
export type DeclineSilentBody = z.infer<typeof DeclineSilentBody>;

/** L3 字段名白名单（D13：见面层字段逐一 opt-in，支持"给微信号但不给手机号"）。
 *  定义在 card.ts（L3 加密容器需要），此处再导出保持既有引用路径不变。 */
export { L3_FIELD_NAMES, type L3FieldName } from './card.js';

// ---------- 匹配报告契约（D6：五档 + 三区；compare 工具的输出结构） ----------

/** 三区叙事（D6） */
export const ReportNarrative = z.object({
  /** 共鸣点：引双方原话（每个结论必须有原话依据——防幻觉 + 信任设计） */
  resonance: z.array(
    z.object({
      point: z.string().max(200),
      mine_quote: z.string().max(200),
      theirs_quote: z.string().max(200),
    }),
  ),
  /** 可聊差异 = 破冰话题建议 */
  talkable_differences: z.array(
    z.object({
      dimension: z.string().max(40),
      suggestion: z.string().max(200),
    }),
  ),
  /** 硬伤预警（命中即档位封顶并说明） */
  dealbreaker_hits: z.array(
    z.object({
      dimension: z.string().max(40),
      mine: z.string().max(50),
      theirs: z.string().max(50),
    }),
  ),
});
export type ReportNarrative = z.infer<typeof ReportNarrative>;

/** compare 工具返回给宿主 LLM 的结构化输入（叙事由宿主 LLM 按 report_narrative prompt 生成） */
export const CompareResult = z.object({
  tier: z.enum([
    'not_yet',
    'can_chat',
    'worth_knowing',
    'worth_meeting',
    'dont_miss',
  ]),
  tier_capped_by_dealbreaker: z.boolean(), // 硬伤命中→档位封顶（D6 兜底①）
  confidence_low: z.boolean(), // 信息不足→降档+置信提示（D6 兜底②；depth.completeness<0.6）
  screened_out: z.boolean(), // 粗筛未通过（零 token 算法，不进入报告）
  screen_reasons: z.array(z.string().max(100)),
  narrative_input: ReportNarrative,
  completeness_mine: z.number().min(0).max(1),
  completeness_theirs: z.number().min(0).max(1),
});
export type CompareResult = z.infer<typeof CompareResult>;

/** 毕业邀请三态应答（D13） */
export const InviteResponseBody = z.object({
  response: z.enum(INVITE_RESPONSES),
});
export type InviteResponseBody = z.infer<typeof InviteResponseBody>;

/** 名片文件扩展名约定 */
export const CARD_FILE_EXT = '.hongxian-card';
/** 信封文件扩展名约定 */
export const ENV_FILE_EXT = '.hongxian-env';
