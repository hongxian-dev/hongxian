#!/usr/bin/env node
/**
 * 月老 MCP Server 入口（npx @hongxian/mcp）
 *
 * STDIO 传输：stdout 只走 MCP 协议帧——所有日志一律 stderr（协议铁律）。
 * 零服务端：本进程不监听任何端口、不出网（唯一的 opt-in 计数见 counter.ts）。
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const log = (...args: unknown[]) => console.error('[yuelao]', ...args);

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('月老已上线（STDIO，零服务端）。12 件工具 + 4 条指引就绪。');
}

main().catch((e) => {
  log('启动失败：', e);
  process.exit(1);
});

// 进程退出即锁定（MK 仅存内存——技术详设 §4）
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => process.exit(0));
}
