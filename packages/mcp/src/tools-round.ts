/**
 * MCP Tool · round —— 第二次相亲的轮次管理（D10 / D11 / D12）
 *
 * v1.0 只有轮次状态机的纯函数与单测，没有任何工具入口：
 * 用户在真实对话里**无法开一轮、无法收尾一轮、拿不到增量小报告**。
 * 本工具把它接进产品面：
 *
 *   status  → 这条线两个方向各走到第几轮、是否该谈毕业
 *   open    → 出题（1 主题 + ≤2 追问，追问封顶由 core 兜）
 *   respond → 我这边作答（三态：答 / 带回去问主人 / 婉答）
 *   close   → 收尾本轮（增量判定 + 覆盖维度）→ 增量小报告素材
 *   history → 全部轮次记录（含对方原话）
 *
 * 对端出题/回卷到达时会自动记账（routeEnvelope 内），主人只需在
 * 「继续 / 毕业 / 放下」三个动作用上 close。
 */

import { z } from 'zod';
import { roundSummary, latestRoundEvidence, shouldSuggestGraduation } from '@hongxian/core';
import type { FateLine } from '@hongxian/core';
import { store } from './context.js';
import {
  applyAnswer,
  applyClose,
  applyOpenTopic,
  findLine,
  loadLineRounds,
  roundsView,
  saveLineRounds,
} from './rounds-store.js';
import type { Session } from './session.js';

const LINES_DIR = 'lines';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

export const roundTool = {
  name: 'round',
  description:
    '深聊轮次管理（D11 一轮 = 1 题 + ≤2 追问 → 对等反问 → 双方各出增量小报告 → 各自决定继续/毕业/放下）。' +
    'status=两条方向的进度与毕业建议；open=出题；respond=我作答（三态）；close=收尾并给增量素材；history=全部轮次。' +
    '毕业机制：连续 2 轮无增量、或超过 8 轮，月老会诚实建议"毕业或放下"——不做笔友经纪。',
  inputSchema: {
    action: z.enum(['status', 'open', 'respond', 'close', 'history']).default('status'),
    card_id: z.string().describe('对端卡片 ID（或用 ledger 里的 line_id 前缀）'),
    direction: z
      .enum(['out', 'in'])
      .default('out')
      .describe('out=我出题我在收；in=对方出题我在答'),
    topic: z.string().max(100).optional().describe('open 时：主题（一句）'),
    followups: z.array(z.string().max(100)).max(2).optional().describe('open 时：追问，最多 2 个'),
    reason: z.string().max(200).optional().describe('open 时：出题理由（D12）'),
    channel: z.enum(['owner', 'yuelao']).default('yuelao').describe('open 时：主人想问的 / 月老建议的'),
    round: z.number().int().min(1).optional().describe('respond 时：回卷轮次（缺省取当前轮）'),
    status: z.enum(['answered', 'ask_master', 'deferred']).optional().describe('respond 时：三态应答'),
    answer: z.string().max(500).optional().describe('respond 时：答案原话（answered 必填）'),
    note: z.string().max(100).optional().describe('respond 时：婉答/带回问主人的备注'),
    incremental: z.boolean().optional().describe('close 时：本轮是否有增量信息（默认 true）'),
    dimensions: z.array(z.string()).max(8).optional().describe('close 时：本轮覆盖的题库维度'),
  },
  handler: async (
    args: {
      action: 'status' | 'open' | 'respond' | 'close' | 'history';
      card_id: string;
      direction: 'out' | 'in';
      topic?: string;
      followups?: string[];
      reason?: string;
      channel: 'owner' | 'yuelao';
      round?: number;
      status?: 'answered' | 'ask_master' | 'deferred';
      answer?: string;
      note?: string;
      incremental?: boolean;
      dimensions?: string[];
    },
    _session: Session,
  ) => {
    const s = store();
    const found = findLine(s, args.card_id);
    if (!found) return text(`找不到这条姻缘线（${args.card_id}）。先 import_card 或等对方来信建线。`);
    const { line, dir } = found;
    const rounds = loadLineRounds(s, dir, line.line_id);
    const side = args.direction;
    const state = rounds[side];

    const persistLine = (patch: Partial<FateLine>) => {
      s.write(`${LINES_DIR}/${dir}/state.json`, { ...line, ...patch });
    };

    if (args.action === 'status') {
      const view = roundsView(rounds);
      const grad =
        shouldSuggestGraduation(rounds.out) || shouldSuggestGraduation(rounds.in)
          ? '\n\n**毕业建议**：信息已经问不出新东西了——诚实说，该谈"见面或放下"了。无限网聊是约会产品最经典的死法。'
          : '';
      return text(
        `轮次进度（线 ${line.line_id.slice(0, 8)}…）：\n\n` +
          `我出的题：第 ${view.out.total_rounds} 轮已收，当前 ${statePhase(rounds.out)}，覆盖维度 ${view.out.covered.join('、') || '无'}\n` +
          `对方出的题：第 ${view.in.total_rounds} 轮已收，当前 ${statePhase(rounds.in)}，覆盖维度 ${view.in.covered.join('、') || '无'}\n` +
          `饱和度：我这边 ${Math.round(view.out.saturation * 100)}% / 对方 ${Math.round(view.in.saturation * 100)}%` +
          grad,
      );
    }

    if (args.action === 'open') {
      if (!args.topic) return text('open 需要 topic（一句话主题）。');
      if (state.current_topic) {
        return text(
          `这条线还有一轮没闭合（第 ${state.round_no} 轮：${state.current_topic.topic}）——先 close 再开新一轮。`,
        );
      }
      try {
        rounds[side] = applyOpenTopic(state, {
          topic: args.topic,
          followups: args.followups ?? [],
          reason: args.reason ?? '',
          channel: args.channel,
        });
      } catch (e) {
        return text(`出题不合法：${(e as Error).message}`);
      }
      saveLineRounds(s, dir, rounds);
      return text(
        `第 ${rounds[side].round_no} 轮已开（${args.channel === 'owner' ? '主人想问的' : '月老建议的'}）：\n\n` +
          `主题：${args.topic}\n追问：${(args.followups ?? []).join('；') || '无'}\n` +
          `理由：${args.reason || '（未写——报告里会显得薄，建议补一句）'}\n\n` +
          `下一步：send_envelope(msg_type="topic_pack", target_card_id="${args.card_id}", ` +
          `body={ round: ${rounds[side].round_no}, topic: "${args.topic}", followups: ${JSON.stringify(args.followups ?? [])}, ` +
          `reason: "${args.reason ?? ''}", channel: "${args.channel}" })`,
      );
    }

    if (args.action === 'respond') {
      if (!state.current_topic) {
        return text('这一侧当前没有待答的考题（可能对方还没发题，或题已收尾）。');
      }
      if (!args.status) return text('respond 需要 status：answered / ask_master / deferred。');
      if (args.status === 'answered' && !args.answer) return text('answered 需要 answer（对方原话）。');
      const roundNo = args.round ?? state.round_no;
      try {
        rounds[side] = applyAnswer(state, {
          round: roundNo,
          topic_ref: state.current_topic.topic,
          status: args.status,
          answer: args.answer,
          note: args.note,
        });
      } catch (e) {
        return text(`记答案失败：${(e as Error).message}`);
      }
      saveLineRounds(s, dir, rounds);
      return text(
        `第 ${roundNo} 轮答案已记（${args.status}）。\n\n` +
          (args.status === 'deferred'
            ? '婉答也是信息，但不判红旗——报告里只会标"该维度置信度低"，由你的主人自行解读。\n'
            : '') +
          `下一步：send_envelope(msg_type="answer_card", target_card_id="${args.card_id}", ` +
          `body={ round: ${roundNo}, topic_ref: "${state.current_topic.topic}", status: "${args.status}"` +
          `${args.answer ? `, answer: "${args.answer}"` : ''}${args.note ? `, note: "${args.note}"` : ''} }）\n` +
          `发完这封，这一轮回卷就算闭合（D11）。`,
      );
    }

    if (args.action === 'close') {
      if (!state.current_topic) return text('这一侧没有进行中的轮次，无需收尾。');
      const incremental = args.incremental ?? true;
      rounds[side] = applyClose(state, incremental, args.dimensions ?? []);
      saveLineRounds(s, dir, rounds);
      const summary = roundSummary(rounds[side]);
      const last = latestRoundEvidence(rounds[side]);
      persistLine({
        rounds_total: line.rounds_total + 1,
        last_activity: new Date().toISOString(),
      });
      const advice = summary.suggest_graduation
        ? '\n\n**该谈毕业了**：连续无增量（或已超过 8 轮）——再问下去只是消耗彼此。' +
          '三个选项：继续（真的还有想问的）/ 毕业（约见面，走 graduation_invite）/ 放下（不回复，静默到底）。'
        : '';
      return text(
        `第 ${summary.total_rounds} 轮已收尾（增量：${incremental ? '有' : '无'}）。\n\n` +
          `本轮学到什么（增量小报告素材）：\n` +
          `- 题目：${last?.topic ?? '（无）'}\n` +
          `- 对方原话：${last?.answer ?? '（婉答/未答）'}\n` +
          `- 已覆盖维度：${summary.covered.join('、') || '无'}\n` +
          `- 饱和度：${Math.round(summary.saturation * 100)}%\n\n` +
          `把这三行按 report_narrative 的口吻扩成三句话给主人（学到什么 / 置信度怎么变 / 建议）。${advice}`,
      );
    }

    // history
    const records = [...rounds.out.history, ...rounds.in.history].sort((a, b) => a.round - b.round);
    if (records.length === 0) return text('这条线还没有收尾过的轮次。');
    const lines = records.map(
      (r) =>
        `第 ${r.round} 轮 · ${r.topic.topic}${r.topic.followups.length ? `（追问：${r.topic.followups.join('；')}）` : ''}\n` +
        `  答案：${r.answer ? `${r.answer.status} — ${r.answer.answer ?? r.answer.note ?? ''}` : '（未记录）'}` +
        `${r.incremental ? '  [有增量]' : '  [无增量]'}`,
    );
    return text(`轮次记录（${records.length} 轮）：\n\n${lines.join('\n')}`);
  },
};

function statePhase(state: { current_topic: unknown; round_no: number }): string {
  return state.current_topic ? `第 ${state.round_no} 轮待收尾` : '无进行中轮次';
}
