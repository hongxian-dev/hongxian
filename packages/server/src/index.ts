#!/usr/bin/env node
/**
 * 红线平台服务 · 入口（hongxian-server）
 *
 * 零服务端军规的"服务端"部分：本进程只存取转发密文，不出网、不追踪、无日志外发。
 * 数据目录：HONGXIAN_SERVER_DATA（默认 ./data）；端口：PORT（默认 8787）；
 * 实例域名：HONGXIAN_INSTANCE（默认 localhost，联邦寻址用）。
 */

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { ServerStore } from './store.js';

const log = (...args: unknown[]) => console.error('[hongxian-server]', ...args);

const DATA_DIR = process.env.HONGXIAN_SERVER_DATA ?? './data';
const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 8787;
const INSTANCE = process.env.HONGXIAN_INSTANCE ?? 'localhost';

const store = new ServerStore(DATA_DIR);
const app = createApp(store, { instance: INSTANCE });

// TTL 清扫：启动一次 + 每小时（过期广场卡与超期信箱信封——服务端少一分持有少一分责任）
const sweep = () => {
  const r = store.sweepExpired();
  if (r.cards || r.envelopes) log(`TTL 清扫：过期卡 ${r.cards}，超期信 ${r.envelopes}`);
};
sweep();
const timer = setInterval(sweep, 3600_000);
timer.unref();

serve({ fetch: app.fetch, port: PORT }, (info) => {
  log(`平台服务已上线：127.0.0.1:${info.port}（实例域名 ${INSTANCE}，数据目录 ${DATA_DIR}）`);
  log('哑管道广场 + 加密信箱；不出网、不追踪、零知识。');
});
