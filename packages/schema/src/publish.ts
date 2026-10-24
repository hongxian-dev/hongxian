/**
 * 红线协议 · 发布许可（publish credential）契约 v1.3
 *
 * 上游决策：《实名制处理口径决策备忘》v1.0 §4（方案 B 发布侧轻实名）。
 * 一句话：**密钥仍是唯一身份；载体验证只是「贴卡许可证」，不是账号，也不是实名认证。**
 *
 * 本文件只放**跨端共享且无副作用**的东西：常量、载体标准化、许可码格式。
 * 不含任何哈希——载体指纹的服务端盐在 `store.ts`，永不出服务端；
 * 客户端也不该有能力自己算出载体指纹（算得出来就等于拿到了可离线比对的彩虹表素材）。
 *
 * 命名说明：决策备忘里字段名为 `phone_hmac`（按手机号设计的年代），
 * 定案走邮箱后统一改称 `carrier_hmac`（载体可替换：今天是邮箱，将来升级手机号时
 * 端点与字段都不变，只换标准化规则与发信通道）。
 */

/** 载体类型（今天是 email；升级到 sms 时扩这一处，端点不动） */
export const CARRIER_KINDS = ['email'] as const;
export type CarrierKind = (typeof CARRIER_KINDS)[number];

/** 验证码：6 位数字，5 分钟有效，一次性 */
export const PUBLISH_CODE_LENGTH = 6;
export const PUBLISH_CODE_TTL_SEC = 300;

/**
 * 发布许可码：由网页展示、用户回填给月老。
 *
 * 偏离决策备忘 §5.3「6 位」的原因：6 位纯数字是 10^6 空间，且用户要**手抄转述**，
 * 0/O、1/I/l 这类混淆会直接变成"抄错了"的支持成本。改为 8 位去混淆字母表
 * （32 进制，约 40 bit）——既更好念，也把猜测空间抬了四个数量级。
 * 许可码只在 10 分钟内有效、只能消费一次、且必须与 nonce 同时命中。
 */
export const PUBLISH_PERMIT_LENGTH = 8;
export const PUBLISH_PERMIT_TTL_SEC = 600;

/** 去混淆字母表：去掉 I / L / O / 0 / 1（手抄转述场景） */
export const PERMIT_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 同一载体重发冷却与每日上限（防把别人的邮箱当邮筒刷） */
export const PUBLISH_OTP_COOLDOWN_SEC = 60;
export const PUBLISH_OTP_PER_CARRIER_PER_DAY = 5;
/** 同一 nonce 最多能发几次（正常流程 1 次；给"没收到"留重试余量） */
export const PUBLISH_OTP_PER_NONCE = 3;
/** 内存级每 IP 每小时上限（不落盘、不进日志；只用于挡住脚本刷信） */
export const PUBLISH_OTP_PER_IP_PER_HOUR = 10;
/** 验证码连续错几次锁定 */
export const PUBLISH_MAX_ATTEMPTS = 5;

/** 待验证挑战的存活时间（从首次发码算起；过期即作废，不续期） */
export const PUBLISH_CHALLENGE_TTL_SEC = 1800;

/**
 * 一次性邮箱域名黑名单。
 *
 * 刻意只收高频名单、不做大而全：黑名单做全了必然误伤真实用户，
 * 而误伤的代价（这个人永远贴不了卡）远大于放进来几个刷子的代价（举报即断兜得住）。
 * 判据是"主流临时邮箱服务"，不是"看起来像小号的域名"。
 */
export const DISPOSABLE_EMAIL_DOMAINS = [
  'mailinator.com',
  'guerrillamail.com',
  'sharklasers.com',
  '10minutemail.com',
  'temp-mail.org',
  'tempmail.com',
  'tempmailo.com',
  'throwawaymail.com',
  'yopmail.com',
  'trashmail.com',
  'maildrop.cc',
  'getnada.com',
  'dispostable.com',
  'mailnesia.com',
  'mintemail.com',
  'spam4.me',
] as const;

/** 载体格式或域名不合规时的原因（HTTP 400 用；不含任何"这个邮箱是否已绑定"的信息） */
export type CarrierRejectReason = 'empty' | 'too_long' | 'malformed' | 'disposable';

export type CarrierResult = { ok: true; carrier: string } | { ok: false; reason: CarrierRejectReason };

/**
 * RFC 5322 的实用子集：本地段允许常见符号，域名按 label 规则，顶级域至少 2 字母。
 * 不追求完整实现——过严会挡真实地址，过松只是把垃圾数据送到发信接口再被退回。
 */
const EMAIL_RE =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * 载体标准化：转小写 + 去首尾空格。
 *
 * **不做 `+` 别名展开**（`a+x@gmail.com` 与 `a@gmail.com` 视为两个载体）——
 * 展开等于"一个 Gmail 能绑无限身份"，防女巫形同虚设。
 * 也不做 Gmail 点号归一（同理）。宁可让少数人觉得"我另一个别名怎么不能用了"，
 * 也不能让一个人用别名刷满广场。
 */
export function normalizeCarrier(raw: string): CarrierResult {
  const carrier = raw.trim().toLowerCase();
  if (!carrier) return { ok: false, reason: 'empty' };
  // RFC 5321 的路径上限 254；本地段 64
  if (carrier.length > 254) return { ok: false, reason: 'too_long' };
  const at = carrier.indexOf('@');
  if (at <= 0 || at > 64) return { ok: false, reason: 'malformed' };
  if (carrier.indexOf('@', at + 1) !== -1) return { ok: false, reason: 'malformed' };
  if (!EMAIL_RE.test(carrier)) return { ok: false, reason: 'malformed' };
  const domain = carrier.slice(at + 1);
  if ((DISPOSABLE_EMAIL_DOMAINS as readonly string[]).includes(domain)) {
    return { ok: false, reason: 'disposable' };
  }
  return { ok: true, carrier };
}

/** 供 UI 直接显示的拒绝原因（文案固定，避免各端各写一套） */
export function describeCarrierReject(reason: CarrierRejectReason): string {
  switch (reason) {
    case 'empty':
      return '请填写邮箱地址。';
    case 'too_long':
      return '地址太长（超过 254 字符），请检查是否粘贴了多余内容。';
    case 'malformed':
      return '这不像一个邮箱地址——请检查是否少了 @ 或域名。';
    case 'disposable':
      return '一次性邮箱（临时收信箱）不做发布确认——因为出事时它已经失效，起不到处置入口的作用。请换常用邮箱。';
  }
}

/**
 * 生成 8 位许可码（去混淆字母表）。
 * 接受任意字节源（服务端用密码学随机数），只做映射、不引入熵。
 */
export function permitFromBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < PUBLISH_PERMIT_LENGTH; i += 1) {
    const b = bytes[i % Math.max(bytes.length, 1)] ?? 0;
    // 与位置混合，避免字节重复时字符重复（视觉上更像随机串）
    out += PERMIT_ALPHABET[(b + i * 7) % PERMIT_ALPHABET.length];
  }
  return out;
}

/** 用户回填的许可码容错：去空格/连字符、转大写（用户会抄成 4-4 分段） */
export function normalizePermit(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

/** 许可码形状校验（不做存在性判断——那是服务端的事） */
export function isPermitShaped(raw: string): boolean {
  const p = normalizePermit(raw);
  if (p.length !== PUBLISH_PERMIT_LENGTH) return false;
  for (const ch of p) if (!PERMIT_ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * nonce 形状校验：客户端生成的 16–32 字节随机值的 base64url。
 * 服务端只校验形状——nonce 的语义只是"这次验证属于哪一次贴卡尝试"，
 * 真正的归属在 claim 那步用持钥证明绑定（所以替他人验证需要同时拿到 nonce 与许可码）。
 */
export function isNonceShaped(raw: string): boolean {
  return /^[A-Za-z0-9_-]{22,43}$/.test(raw);
}

/** 403 的机器可读错误码（客户端据它决定给什么指引，不做字符串匹配） */
export const PUBLISH_ERROR_CODES = {
  requiresVerification: 'publish_requires_verification',
  unavailable: 'publish_verification_unavailable',
  codeInvalid: 'publish_code_invalid',
  codeExpired: 'publish_code_expired',
  tooManyAttempts: 'publish_too_many_attempts',
  carrierTaken: 'publish_carrier_already_bound',
  ownerTaken: 'publish_owner_already_bound',
  rateLimited: 'publish_rate_limited',
  permitInvalid: 'publish_permit_invalid',
} as const;

export type PublishErrorCode = (typeof PUBLISH_ERROR_CODES)[keyof typeof PUBLISH_ERROR_CODES];

// ---------- 防护三 · 贴卡前披露声明（D7 / C2③） ----------

/**
 * 披露声明版本。**改文案必须升这个版本号**——服务端按版本判定"用户看的是不是当前这份"，
 * 客户端本地记录按版本比对，不一致就重新展示。
 */
export const PUBLISH_DISCLOSURE_VERSION = '1.0';

/**
 * 披露声明全文。
 *
 * 为什么这段必须写"边界"：不写就等于隐含承诺"绝对不可关联"，
 * 出事那天这句话会被原文引用为"平台虚假宣传"。写了显得弱，但这是唯一站得住的表述。
 *
 * 为什么必须给"不贴广场"这条路：给用户一条零隐私成本的替代路径，
 * 抵触感明显下降，也更符合"不撮合"的定位。
 */
export const PUBLISH_DISCLOSURE_TEXT = `贴到广场，会多出一条连接。你得先看清楚。

到现在为止，平台只知道"某个公钥做了什么"，不知道这个人是谁。
贴卡这件事，会让你名下的两条记录第一次连起来：

    你的假名公钥  ←→  你的邮箱哈希

也就是说：从这一刻起，平台能确认"这个假名背后的人，有一个能
收到信的邮箱"。四环里，这是唯一一次交叉。

具体存什么：
· 存的是哈希——单向、不可逆，拿到它也算不出邮箱。
· 验证那一瞬间，邮箱明文会在服务器内存里存在几秒，发完信立刻
  丢弃。不写日志，不入库。
· 这个邮箱不能登录、不能找回密码、不会出现在任何卡片里、
  不会展示给任何人、不能用来搜到你。
· 我们不验证你是谁。不知道你的姓名、身份证、住址、工作单位。
  这一层我们做不到——所以不声称做到了。

边界在哪（这段不写，前面的承诺就是假的）：
· 哈希防的是"平台拿着自己的数据库反查邮箱"。它不防"已经知道你
  邮箱的人，拿到数据库后确认你贴过卡"。
· 如果有人同时掌握了你的邮箱和平台的数据，理论上能确认这件事。
  我们不会主动做，但技术上不是"绝对不可能"。
· 所以我们不写"绝对不可关联"。只写我们真做到的部分。

你有两条路：
· 贴广场 —— 需要验证邮箱（就是接下来这一步）
· 只在认识的人之间换卡 —— 全程不需要邮箱，什么都不会多出来

贴出去了，随时可以删。删卡的时候，那条连接一起消失。`;

/** 二次及以后贴卡时的固定一行缩略提示（完整说明可展开） */
export const PUBLISH_DISCLOSURE_BRIEF =
  '贴广场需要验证邮箱；平台会保存一个与你假名关联的邮箱哈希。查看完整说明 →';

/** 勾选行（默认必须是空的，不做默认勾选） */
export const PUBLISH_DISCLOSURE_ACK_LABEL = '我明白平台会保存一个与我假名关联的邮箱哈希';
