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
  hongxian-mcp                        以 STDIO MCP server 运行（由宿主 Agent 调用）
  hongxian-mcp --print-config         打印标准 mcpServers JSON（等价 --print-config claude）
  hongxian-mcp --print-config <目标>  打印对应宿主的安装物料
  hongxian-mcp --print-config list    列出全部目标
  hongxian-mcp --version              打印版本
  hongxian-mcp --help                 打印本帮助

目标（按"配置载体"分，不按宿主逐个列）：
  claude     mcpServers JSON —— Claude Desktop / Cursor / Cline / Cherry Studio
  openclaw   同上 + 必须的 transport 字段
  panel      界面字段表 —— 豆包 / 千问 / WorkBuddy / ChatGPT
  code       命令行 —— Claude Code / Codex / OpenClaw
  dsh        YAML patch —— DeepSeek Harness

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
   让它按你的宿主类型把配置接上，然后重连。

2) 你自己有宿主
   先看你的宿主属于哪一类，再取对应物料：

   有「连接器 / 插件」面板（豆包 / 千问 / WorkBuddy / ChatGPT）
     → npx -y @hongxian/mcp --print-config panel
   要改 json 配置文件（Claude Desktop / Cursor / Cline / Cherry Studio / OpenClaw）
     → npx -y @hongxian/mcp --print-config claude（OpenClaw 换成 openclaw）
   是命令行（Claude Code / Codex / OpenClaw）
     → npx -y @hongxian/mcp --print-config code
   是 DeepSeek Harness
     → npx -y @hongxian/mcp --print-config dsh

   保存后要「完全退出」宿主进程再重开（关窗口不算）。

3) 你还没有任何 MCP 宿主
   先装一个。没有宿主，这个进程没有被谁调用的机会。

零服务端：不监听端口、不出网（唯一可选出网是 opt-in 匿名计数，默认关闭）。
数据目录：~/.hongxian/（可用 HONGXIAN_HOME 覆盖）。
`;

/* ── 安装物料模板 ─────────────────────────────────────────────────────────
 * 为什么不按宿主逐个写说明：宿主的差异只有「配置载体」四种
 *   ① 磁盘上的 mcpServers JSON   ② 界面里的连接器表单
 *   ③ CLI 一行 add 命令          ④ 结构化 patch（DeepSeek Harness 的 YAML）
 * 所以这里一种载体一个模板；新增宿主只是加别名，不是加一套文档。
 * （2026-10-25：豆包/云桌面连续两次因「只认 mcpServers」而卡死，故拆开。）
 */

const CONFIG_SNIPPET = `{
  "mcpServers": {
    "hongxian": {
      "command": "npx",
      "args": ["-y", "@hongxian/mcp"]
    }
  }
}`;

/** OpenClaw 与上面同构，但强制要求 transport 字段，漏了不生效。 */
const CONFIG_OPENCLAW = `{
  "mcpServers": {
    "hongxian": {
      "command": "npx",
      "args": ["-y", "@hongxian/mcp"],
      "transport": "stdio"
    }
  }
}`;

/** 界面式宿主：没有可编辑的 JSON，只能照着字段表点。 */
const PANEL_FIELDS = `界面式宿主：没有可编辑的 mcpServers 文件，照字段表在客户端里点。

  新建「自定义连接器」→ 传输类型选 STDIO → 填三项：

    服务器名称   hongxian
    命令         npx
    参数         -y @hongxian/mcp

  入口在哪：
    豆包桌面版   左侧「插件·技能·伙伴」→ 连接器 → 右上角「+ 新建」→ 新建自定义连接器
                 （是「连接器」，不是「插件」。「豆包工作」云桌面不是 MCP 宿主，装那儿没用）
    千问办公     扩展 → 连接器 → 「+ 添加」→ 粘贴 JSON
    WorkBuddy    连接器管理 → 自定义 MCP → 新增
    ChatGPT      Settings → Connected apps → Add MCP server（走 OAuth）

  保存后要「完全退出」宿主进程再重开，关窗口不算；然后开新会话才会加载。
  若提示连接器启动失败，先到连接器列表点一次「重新启动」——首次启动常是没初始化完。`;

/** CLI 式宿主：一条命令写配置，不用碰文件。 */
const CLI_COMMANDS = `命令行式宿主，选你用的那条：

  claude mcp add --transport stdio hongxian npx -y @hongxian/mcp
  codex mcp add hongxian -- npx -y @hongxian/mcp
  openclaw mcp add --transport stdio hongxian npx -y @hongxian/mcp

验证：claude mcp list / codex mcp list / openclaw mcp list 里应出现 hongxian。`;

/** DeepSeek Harness：既不是 mcpServers，也不是一行命令，是 YAML patch。 */
const DSH_PATCH = `DeepSeek Harness（dsh）走 patch 文件，不是 mcpServers 格式。
~/.dsh/profiles/<profile>/cordis.patch.yml 追加：

- insert:
  - id: hongxian
    name: "@deepseek-ai/dsh-mcp-client"
    config:
      serverName: hongxian
      transport: stdio
      command: npx
      args: ["-y", "@hongxian/mcp"]

serverName 决定工具前缀，会显示成 mcp__hongxian__interview 这类名字。
嫌改 YAML 麻烦，可装社区插件 dsh-mcp-servers，换成图形界面：
Settings → MCP Servers → 添加 → Test → Save。`;

const TARGETS: Record<string, { desc: string; text: string }> = {
  claude: {
    desc: '标准 mcpServers JSON（Claude Desktop / Cursor / Cline / Cherry Studio）',
    text: CONFIG_SNIPPET,
  },
  openclaw: { desc: 'OpenClaw（同上，但必须多一个 transport 字段）', text: CONFIG_OPENCLAW },
  panel: { desc: '界面式宿主字段表（豆包 / 千问 / WorkBuddy / ChatGPT）', text: PANEL_FIELDS },
  code: { desc: 'CLI 宿主命令（Claude Code / Codex / OpenClaw）', text: CLI_COMMANDS },
  dsh: { desc: 'DeepSeek Harness 的 YAML patch', text: DSH_PATCH },
};

/** 宿主名 → 载体名。用户记不住载体分类，只记得住自己在用哪个客户端。 */
const ALIASES: Record<string, keyof typeof TARGETS | 'list'> = {
  json: 'claude',
  'claude-desktop': 'claude',
  cursor: 'claude',
  cline: 'claude',
  cherry: 'claude',
  doubao: 'panel',
  qianwen: 'panel',
  workbuddy: 'panel',
  chatgpt: 'panel',
  cli: 'code',
  'claude-code': 'code',
  codex: 'code',
  deepseek: 'dsh',
  harness: 'dsh',
  list: 'list',
};

function listTargets(): string {
  const rows = Object.entries(TARGETS).map(([k, v]) => `  ${k.padEnd(10)}${v.desc}`);
  return ['用法：--print-config <目标>（不带目标 = claude）', '', ...rows].join('\n');
}

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
  // --print-config [目标]：不带目标仍输出标准 JSON（旧脚本/文档不受影响）
  const cfgIdx = argv.findIndex((a) => a === '--print-config' || a.startsWith('--print-config='));
  if (cfgIdx !== -1) {
    const cur = argv[cfgIdx] ?? '';
    const next = cur === '--print-config' ? argv[cfgIdx + 1] : cur.slice('--print-config='.length);
    const want = (next && !next.startsWith('--') ? next : '').trim().toLowerCase();
    if (!want) {
      process.stdout.write(`${CONFIG_SNIPPET}\n`);
      // 提示走 stderr：stdout 要能原样重定向进配置文件
      process.stderr.write('提示：其他宿主用 --print-config <目标>，清单见 --print-config list\n');
      return;
    }
    const key = ALIASES[want] ?? want;
    if (key === 'list') {
      process.stdout.write(`${listTargets()}\n`);
      return;
    }
    const target = TARGETS[key as keyof typeof TARGETS];
    if (!target) {
      process.stderr.write(`未知目标：${want}\n\n${listTargets()}\n`);
      process.exit(2);
    }
    process.stdout.write(`${target.text}\n`);
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
