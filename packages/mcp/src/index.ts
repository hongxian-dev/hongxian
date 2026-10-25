#!/usr/bin/env node
/**
 * 月老 MCP Server 入口（npx @hongxian/mcp）
 *
 * STDIO 传输：stdout 只走 MCP 协议帧——所有日志一律 stderr（协议铁律）。
 * 零服务端：本进程不监听任何端口、不出网（唯一的 opt-in 计数见 counter.ts）。
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { createServer, TOOL_COUNT, PROMPT_COUNT } from './server.js';

const log = (...args: unknown[]) => console.error('[yuelao]', ...args);

const require = createRequire(import.meta.url);
const PKG = require('../package.json') as { version: string };

const USAGE = `月老 Yuelao MCP Server v${PKG.version}

用法：
  hongxian-mcp                 以 STDIO MCP server 运行（由宿主 Agent 调用）
  hongxian-mcp --print-config  打印可直接粘贴的 mcpServers 配置片段
  hongxian-mcp --version       打印版本
  hongxian-mcp --help          打印本帮助

零服务端：本进程不监听端口、不出网（唯一可选出网行为是 opt-in 匿名计数，默认关闭）。
数据目录：~/.hongxian/（可用环境变量 HONGXIAN_HOME 覆盖）。`;

/** 终端里直接运行时的说明。挂住什么都不说，是这条路上最大的坑。 */
const TTY_GUIDE = `月老 Yuelao MCP Server v${PKG.version}

你是在终端里直接运行它——在这里不会发生任何事。

它不是安装脚本，是一个 STDIO MCP 服务：由宿主（Agent 客户端）启动，
双方用 JSON-RPC 通信。单独运行，它只会安静地等输入，看起来像卡住了。

正确用法有三种：

1) 你正在跟一个 AI 说话（最省事）
   把官网 https://hongxian.dev 安装区「复制安装指令」的整段粘给它，
   让它把下面的配置加进它的 MCP 设置，然后重连。

2) 你自己有宿主（Claude Desktop / Cursor / Cline / Cherry Studio / WorkBuddy …）
   在宿主的 MCP 设置里新增一项，填入：
     "hongxian": { "command": "npx", "args": ["-y", "@hongxian/mcp"] }
   保存后要「完全退出」宿主进程再重开（关窗口不算）。
   需要这段 JSON，直接运行：npx -y @hongxian/mcp --print-config

3) 你还没有任何 MCP 宿主
   先装一个。没有宿主，这个进程没有被谁调用的机会。

零服务端：不监听端口、不出网（唯一可选出网是 opt-in 匿名计数，默认关闭）。
数据目录：~/.hongxian/（可用 HONGXIAN_HOME 覆盖）。
`;

const CONFIG_SNIPPET = `{
  "mcpServers": {
    "hongxian": {
      "command": "npx",
      "args": ["-y", "@hongxian/mcp"]
    }
  }
}`;

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
  if (argv.includes('--print-config')) {
    process.stdout.write(`${CONFIG_SNIPPET}\n`);
    return;
  }
  if (argv.length > 0) {
    // 未知参数：明确拒绝而不是静默忽略——避免宿主误传参后行为难排查
    process.stderr.write(`未知参数：${argv.join(' ')}\n${USAGE}\n`);
    process.exit(2);
  }
  // 终端里直接运行（有人在敲命令，而不是宿主拉起的管道）：说明清楚就退出。
  // 不这么做的话，用户看到的是一个没有任何输出、永远不结束的进程。
  if (process.stdin.isTTY) {
    process.stdout.write(`${TTY_GUIDE}\n`);
    return;
  }
  return serve();
}

async function serve() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`月老已上线（STDIO，零服务端依赖）。${TOOL_COUNT} 件工具 + ${PROMPT_COUNT} 条指引就绪。`);
}

main().catch((e) => {
  log('启动失败：', e);
  process.exit(1);
});

// 进程退出即锁定（MK 仅存内存——技术详设 §4）
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => process.exit(0));
}
