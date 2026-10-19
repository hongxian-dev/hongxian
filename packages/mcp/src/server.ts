/**
 * 月老 MCP Server 装配（薄壳：tools + prompts → core）
 *
 * STDIO 铁律：stdout 只走 MCP 协议帧；一切日志走 stderr（index.ts 统一处理）。
 * 门闩错误（未解锁/未同意）由 guard 转成月老口吻的文本，不抛异常给宿主。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Session } from './session.js';
import { guard } from './context.js';
import { interviewTool, signCardTool, exportCardTool, importCardTool } from './tools-profile.js';
import {
  compareTool,
  sendEnvelopeTool,
  receiveEnvelopeTool,
  ledgerTool,
  coachTool,
} from './tools-exchange.js';
import { backupTool, restoreTool, wipeTool } from './tools-lifecycle.js';
import { plazaBrowseTool, plazaPublishTool, sendViaServerTool, mailboxPullTool } from './tools-plaza.js';
import { ALL_PROMPTS } from './prompts.js';

const TOOLS = [
  interviewTool,
  signCardTool,
  exportCardTool,
  importCardTool,
  compareTool,
  sendEnvelopeTool,
  receiveEnvelopeTool,
  ledgerTool,
  coachTool,
  backupTool,
  restoreTool,
  wipeTool,
  // M1.3 平台接入（哑管道广场 + 加密信箱；V9：无 presence/回执/推送）
  plazaBrowseTool,
  plazaPublishTool,
  sendViaServerTool,
  mailboxPullTool,
] as const;

const PROMPT_DESCRIPTIONS: Record<string, string> = {
  yuelao_persona: '月老人格与禁令（D2）：温暖克制的靠谱长辈；不做闲聊、不推送、不替主人做主',
  interview_flow: '渐进式建画像指引（D1）：三次会话 + 复述确认 + 可见性提示',
  report_narrative: '匹配报告叙事规范（D6）：五档结论 + 三区叙事 + 三条兜底',
  coach_ethics: '选题教练伦理护栏（D12）：出题理由 + 双通道标记 + 反 PUA 红线',
};

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'yuelao', version: '0.1.0' },
    {
      instructions:
        '你是月老——住在用户设备里的本地婚恋工具。先读取 yuelao_persona prompt 确认人格与禁令，' +
        '再按用户意图调用工具。建画像走 interview_flow，比对报告走 report_narrative，' +
        '出题走 coach_ethics。一切明文数据只存用户本机（经服务端流转的只有密文）；' +
        '你与另一位月老之间只有结构化握手，没有自由聊天。' +
        '广场模式（M1.3）：plaza_browse 只看轮廓不见内容，send_via_server 敲门只确认"已入信箱"，' +
        'mailbox_pull 拉取即删——无在线状态、无已读回执、无推送。',
    },
  );
  const session = new Session();

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => {
        // 全局门闩：除 interview（自身管理同意/解锁流程）外，
        // 未完成知情同意或未解锁的工具一律不执行——wipe 后同样生效（S3 无残留的配套纪律）。
        if (tool.name !== 'interview') {
          if (!session.initialized) {
            return { content: [{ type: 'text' as const, text: '首次使用需完成知情同意（调用 interview，action="start"）。' }] };
          }
          if (!session.unlocked) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: '会话未解锁：请先提供 24 词恢复短语（interview，action="unlock"）。',
                },
              ],
            };
          }
        }
        const result = await guard(
          () => tool.handler(args as never, session),
          (message) => ({ content: [{ type: 'text' as const, text: message }] }),
        );
        return result;
      },
    );
  }

  for (const [name, promptText] of Object.entries(ALL_PROMPTS)) {
    server.registerPrompt(
      name,
      { description: PROMPT_DESCRIPTIONS[name] ?? name },
      async () => ({
        description: PROMPT_DESCRIPTIONS[name] ?? name,
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: promptText } }],
      }),
    );
  }

  return server;
}
