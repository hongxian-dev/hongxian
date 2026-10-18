#!/usr/bin/env node
/**
 * 月老 MCP Server 入口（npx @hongxian/mcp）
 *
 * STDIO 传输：stdout 只走 MCP 协议帧——所有日志一律 stderr（协议铁律）。
 * 零服务端：本进程不监听任何端口、不出网（唯一的 opt-in 计数见 counter.ts）。
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { createServer } from './server.js';

const log = (...args: unknown[]) => console.error('[yuelao]', ...args);

const require = createRequire(import.meta.url);
const PKG = require('../package.json') as { version: string };

const USAGE = `月老 Yuelao MCP Server v${PKG.version}

用法：
  hongxian-mcp            以 STDIO MCP server 运行（由宿主 Agent 调用）
  hongxian-mcp --version  打印版本
  hongxian-mcp --help     打印本帮助

零服务端：本进程不监听端口、不出网（唯一可选出网行为是 opt-in 匿名计数，默认关闭）。
数据目录：~/.hongxian/（可用环境变量 HONGXIAN_HOME 覆盖）。`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${PKG.version}\n`);
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (argv.length > 0) {
    // 未知参数：明确拒绝而不是静默忽略——避免宿主误传参后行为难排查
    process.stderr.write(`未知参数：${argv.join(' ')}\n${USAGE}\n`);
    process.exit(2);
  }
  return serve();
}

async function serve() {
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
