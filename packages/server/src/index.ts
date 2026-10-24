#!/usr/bin/env node
/**
 * 红线平台服务 · 入口（hongxian-server）
 *
 * 零服务端军规的"服务端"部分：本进程只存取转发密文，不追踪、无日志外发。
 * 数据目录：HONGXIAN_SERVER_DATA（默认 ./data）；端口：PORT（默认 8787）；
 * 实例域名：HONGXIAN_INSTANCE（默认 localhost，联邦寻址用）。
 *
 * 发布许可（C17）相关配置：
 *   RESEND_API_KEY                          发信通道密钥；不配 = 没有通道
 *   MAIL_FROM                               发件人，默认 `红线 <noreply@mail.hongxian.dev>`
 *   HONGXIAN_REQUIRE_PUBLISH_VERIFICATION   auto（默认）| 1 | 0
 *                                          auto = 配了发信通道就要求，没配就不要求
 *   HONGXIAN_PUBLISH_VERIFY_BASE            官网验证页基地址，告诉月老去哪开网页；
 *                                          缺省由客户端按实例域名推导
 */

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createResendMailer } from './mailer.js';
import { ServerStore } from './store.js';

const log = (...args: unknown[]) => console.error('[hongxian-server]', ...args);

const DATA_DIR = process.env.HONGXIAN_SERVER_DATA ?? './data';
const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 8787;
const INSTANCE = process.env.HONGXIAN_INSTANCE ?? 'localhost';
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? '';
const MAIL_FROM = process.env.MAIL_FROM ?? '红线 <noreply@mail.hongxian.dev>';
const VERIFY_BASE = process.env.HONGXIAN_PUBLISH_VERIFY_BASE;
const REQUIRE_FLAG = (process.env.HONGXIAN_REQUIRE_PUBLISH_VERIFICATION ?? 'auto').toLowerCase();

const mailer = RESEND_API_KEY ? createResendMailer({ apiKey: RESEND_API_KEY, from: MAIL_FROM }) : null;

/**
 * auto 的含义：**有能力验证就验证**。
 * 没配发信通道时强行要求，等于把所有贴卡请求都变成 503——那不是在保护用户，
 * 是在制造"这产品坏了"的第一印象。反过来，公开实例上静默不要求，
 * 会让"广场没有任何防护"这件事发生在没人注意的时候。所以两种情况都要大声说出来。
 */
const required = REQUIRE_FLAG === '0' ? false : REQUIRE_FLAG === '1' ? true : mailer !== null;

const store = new ServerStore(DATA_DIR);
const app = createApp(store, {
  instance: INSTANCE,
  publish: { required, mailer, verifyBase: VERIFY_BASE },
});

// TTL 清扫：启动一次 + 每小时（过期广场卡、超期信箱信封、作废的发布挑战）
const sweep = () => {
  const r = store.sweepExpired();
  if (r.cards || r.envelopes || r.challenges) {
    log(`TTL 清扫：过期卡 ${r.cards}，超期信 ${r.envelopes}，作废挑战 ${r.challenges}`);
  }
};
sweep();
const timer = setInterval(sweep, 3600_000);
timer.unref();

serve({ fetch: app.fetch, port: PORT }, (info) => {
  log(`平台服务已上线：127.0.0.1:${info.port}（实例域名 ${INSTANCE}，数据目录 ${DATA_DIR}）`);
  log('哑管道广场 + 加密信箱；零知识。');
  if (required && !mailer) {
    log('⚠️  要求发布确认但没有 RESEND_API_KEY——贴卡会全部返回 503。这是配置错误，请补通道或设 HONGXIAN_REQUIRE_PUBLISH_VERIFICATION=0。');
  } else if (required) {
    log(`发布许可：已启用（发信通道 ${mailer?.kind}，发件人 ${MAIL_FROM}）。这是本服务唯一的出网点。`);
  } else {
    log('⚠️  发布许可：未启用（贴卡不做载体验证）。自托管私有实例可以这样；公开实例请配 RESEND_API_KEY。');
  }
});
