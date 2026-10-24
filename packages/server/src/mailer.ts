/**
 * 红线平台服务 · 发信（唯一出网点）
 *
 * ⚠️ 这一行注释是**架构声明**，改动前先读：
 * 在 C17 之前，本服务的军规是「不出网、零依赖」，零知识审计测试甚至断言源码里
 * 不得出现任何 http(s) URL。发布许可（D1 方案 B）改变了这一点——验证一个邮箱能收信，
 * 物理上必须往外发一封信。所以军规从「不出网」改成**「只有一个出网点」**：
 *
 *   1. 全仓（server/src）只有本文件允许出现 URL，且只能是 Resend 的 API 地址；
 *   2. 全仓只有本文件允许调用 fetch；
 *   3. 本文件**不接收任何内容数据**——它只认识"收信地址 + 6 位数字"，
 *      连 opaque_id 都不传（因此即使发信服务商被攻破，也无法把邮箱与人对应起来，
 *      除非同时拿到平台数据目录）；
 *   4. 明文邮箱只活在这一个函数调用的栈上，不写日志、不写盘、不进异常信息。
 *
 * `test/audit.test.ts` 把上面 1–2 条做成了红灯。
 *
 * 未配置 `RESEND_API_KEY` 时 `createResendMailer` 返回 null，由入口决定
 * 发布许可是否启用（自托管私有实例可以不启用；公开实例不启用等于没有防护）。
 */

import { PUBLISH_CODE_TTL_SEC } from '@hongxian/schema';

export interface MailerSendResult {
  ok: boolean;
  /** 失败原因（只含状态码级别的信息，绝不含收信地址） */
  error?: string;
}

export interface Mailer {
  /** 通道名（进 stderr 启动日志，不进响应体） */
  readonly kind: string;
  /** 发一封发布确认码；`to` 只在本函数栈上存在 */
  sendPublishCode(to: string, code: string): Promise<MailerSendResult>;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 8000;

export interface ResendOptions {
  apiKey: string;
  /** 发件人，形如 `红线 <noreply@mail.hongxian.dev>` */
  from: string;
  timeoutMs?: number;
}

/**
 * 正文刻意不写任何链接、不写"点击此处"。
 *
 * 两个原因：① 带链接的验证码邮件最容易被判营销/钓鱼，投递率直接掉；
 * ② 我们不想训练用户"收到红线的信就点里面的链接"——这个习惯一旦养成，
 *    仿冒者一封钓鱼信就能骗走他们。正文只有一句话 + 一串数字，没有可点的东西。
 */
function bodyText(code: string): string {
  const minutes = Math.round(PUBLISH_CODE_TTL_SEC / 60);
  return [
    `发布确认码：${code}`,
    '',
    `这串码 ${minutes} 分钟内有效，只能用于一次贴卡确认。`,
    '',
    '红线广场是一个公开可见的列表。确认这个邮箱能收信，只为了两件事：',
    '  一、防止一个人刷满广场；',
    '  二、出问题时留一个处置入口。',
    '',
    '我们不验证你是谁，也不打算假装验证了。',
    '邮箱不能登录、不能找回账号，也不会出现在任何一张卡里。',
    '',
    '不是你本人操作？直接忽略这封信即可——没有这串码，谁也没法用你的邮箱做任何事。',
    '',
    '—— 红线 · 一个不提供撮合服务的开源工具',
  ].join('\n');
}

export function createResendMailer(opts: ResendOptions): Mailer {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    kind: 'resend',
    async sendPublishCode(to: string, code: string): Promise<MailerSendResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: opts.from,
            to: [to],
            subject: '红线 · 发布确认码',
            text: bodyText(code),
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          // 只回报状态码：响应体可能回显收信地址，进日志等于把邮箱写进磁盘
          return { ok: false, error: `发信服务返回 HTTP ${res.status}` };
        }
        return { ok: true };
      } catch (e) {
        const aborted = (e as Error).name === 'AbortError';
        return { ok: false, error: aborted ? `发信超时（${timeoutMs / 1000}s）` : '发信服务不可达' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
