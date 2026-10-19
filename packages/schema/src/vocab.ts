/**
 * 红线协议 v0 · 受控词表 v0.1（Schema 规范 §5）
 *
 * 设计原则：初版刻意克制（D10"少而精"），随版本迭代扩充。
 * 所有枚举字段允许 `unspecified`（未回答也是合法值，且与"婉答"区分）。
 * 词表是 schema 的组成部分——协议升级时词表版本与 schema_version 绑定演进。
 */

export const VOCAB_VERSION = '0.1' as const;

/** 兴趣标签（12 个起步） */
export const INTERESTS = [
  'outdoor', // 户外
  'sports', // 运动
  'reading', // 阅读
  'film_tv', // 影视
  'music', // 音乐
  'food', // 美食
  'travel', // 旅行
  'gaming', // 游戏
  'handcraft', // 手工
  'pets', // 宠物
  'photography', // 摄影
  'self_growth', // 学习成长
] as const;

/** 价值观标签（8 个起步，带权重 0–1） */
export const VALUES_TAGS = [
  'family_first', // 家庭优先
  'career_driven', // 事业进取
  'life_balance', // 生活平衡
  'free_explore', // 自由探索
  'stability', // 稳定安稳
  'open_to_new', // 开放尝新
  'traditional', // 传统务实
  'spiritual_growth', // 精神成长
] as const;

/** dealbreaker 维度（结构化为维度+描述） */
export const DEALBREAKER_DIMENSIONS = [
  'smoking', // 吸烟
  'drinking', // 饮酒
  'childbearing', // 生育意愿
  'long_distance', // 异地
  'pets', // 宠物
  'debt', // 债务
  'religion', // 宗教
  'other', // 其他
] as const;

/** 职业大类 */
export const JOB_CATEGORIES = [
  'tech', // 技术
  'product_design', // 产品设计
  'professional_service', // 专业服务（法财医教）
  'public_sector', // 公务事业
  'business_owner', // 经商自营
  'skilled_trade', // 技能劳作
  'freelance', // 自由职业
  'other', // 其他
] as const;

/** 年龄段（不收精确出生日期） */
export const AGE_BANDS = [
  '18_25',
  '26_30',
  '31_35',
  '36_40',
  '41_45',
  '46_50',
  'over_50',
  'unspecified',
] as const;

/** 身高段 */
export const HEIGHT_BANDS = [
  'under_160',
  '160_165',
  '166_170',
  '171_175',
  '176_180',
  '181_185',
  'over_185',
  'unspecified',
] as const;

/** 学历段 */
export const EDUCATION_BANDS = [
  'high_school', // 高中及以下
  'vocational', // 中专/职高
  'college', // 大专
  'bachelor', // 本科
  'master', // 硕士
  'phd', // 博士
  'unspecified',
] as const;

/** 婚况 */
export const MARITAL_STATUSES = [
  'never_married', // 未婚
  'divorced_no_child', // 离异无子女
  'divorced_with_child', // 离异有子女
  'widowed', // 丧偶
] as const;

/** 目标声明 */
export const GOALS = ['serious_dating', 'marriage_oriented'] as const;

/** 性别（v0.3 补） */
export const GENDERS = ['female', 'male'] as const;

/** 经济状态自述（v0.2 新增；生活状态而非收入数字） */
export const ECON_SIGNALS = [
  'undisclosed', // 未披露（默认）
  'independent', // 经济独立
  'home_owner', // 有房
  'home_owner_no_mortgage', // 有房无贷
  'car_owner', // 有车
] as const;

/** 收入宽区间段（L2，可整字段缺省） */
export const INCOME_BANDS = [
  'under_10w',
  '10_20w',
  '20_30w',
  '30_50w',
  '50_100w',
  'over_100w',
] as const;

/** 作息类型 */
export const SLEEP_TYPES = ['early_bird', 'normal', 'night_owl', 'unspecified'] as const;

/** 吸烟/饮酒频率 */
export const HABIT_LEVELS = ['never', 'occasionally', 'regularly', 'unspecified'] as const;

/** 运动频率 */
export const EXERCISE_LEVELS = ['none', 'occasionally', 'regularly', 'unspecified'] as const;

/** 社交频率 */
export const SOCIAL_LEVELS = ['low', 'medium', 'high', 'unspecified'] as const;

/** 与父母关系 */
export const PARENTS_RELATIONS = [
  'harmonious', // 融洽
  'ordinary', // 一般
  'strained', // 紧张
  'unspecified',
] as const;

/** 生育意愿（段） */
export const CHILDBEARING_INTENTS = [
  'want', // 想要
  'want_more', // 想要多个
  'dont_want', // 不想要
  'undecided', // 还没想好
  'unspecified',
] as const;

/** 与父母同住意愿 */
export const COHABIT_INTENTS = ['willing', 'reluctant', 'no', 'undecided', 'unspecified'] as const;

/** 消费倾向五档（精打细算 ↔ 体验优先） */
export const MONEY_VIEWS = [
  'very_frugal',
  'frugal',
  'balanced',
  'experiential',
  'very_experiential',
  'unspecified',
] as const;

/** 房车硬条件概况（各自独立） */
export const ASSET_STATES = ['owned', 'not_yet', 'indifferent'] as const;

/** 模型声明级别（声明级别不声明型号，D7） */
export const MODEL_TIERS = ['local', 'cloud'] as const;

/** 卡片类型 */
export const CARD_TYPES = ['match_card', 'plaza_card'] as const;

/** 出题方通道标记（D12 双通道） */
export const TOPIC_CHANNELS = ['owner', 'yuelao'] as const;

/** 回卷三态应答（D10） */
export const ANSWER_STATUSES = ['answered', 'ask_master', 'deferred'] as const;

/** 毕业邀请三态应答（D13） */
export const INVITE_RESPONSES = ['accepted', 'deferred', 'declined'] as const;

/** 五档报告结论（D6） */
export const REPORT_TIERS = [
  'not_yet', // 缘分未至
  'can_chat', // 可以聊聊
  'worth_knowing', // 值得认识
  'worth_meeting', // 值得见面
  'dont_miss', // 别错过
] as const;

/** 画像深度不足阈值（Schema §7.3） */
export const COMPLETENESS_LOW_THRESHOLD = 0.6;

/** 默认 TTL：30 天（Schema §2，D8 广场贴卡防僵尸信息） */
export const DEFAULT_TTL_DAYS = 30;

// ---------- 平台服务常量（v0.4，工程设计 V1/V2/V7） ----------

/** 信箱保留期默认 30 天（服务端少一分持有少一分责任；过期自动删） */
export const MAILBOX_RETENTION_DAYS = 30;
/** 单 opaque ID 每日定向投递上限（反滥用结构限制优于内容审查——v2 初稿 §6） */
export const MAX_DAILY_DELIVERIES = 20;
/** 广场卡池分页大小（哑管道：全量拉取 + cursor 分页，过滤 100% 在客户端） */
export const PLAZA_PAGE_SIZE = 100;
