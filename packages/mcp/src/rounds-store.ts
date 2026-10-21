/**
 * 轮次状态存储（D11：一轮 = 最小决策单元）
 *
 * 一条姻缘线上有**两个方向**的轮次，必须分开记账：
 *   out = 我出题、对方答（我的 RoundState 推我的编号）
 *   in  = 对方出题、我答（对方编号，我只记在案）
 *
 * v1.0 的 round machine 只有纯函数、没有任何持久化入口——轮次功能
 * 在产品里完全不可达，答案也因此丢失。本文件补上落盘与双方向隔离。
 */

import {
  createRoundState,
  openTopic,
  recordAnswer,
  closeRound,
  roundSummary,
  latestRoundEvidence,
  type AnswerRecord,
  type RoundState,
  type TopicRecord,
} from '@hongxian/core';
import type { FsStore } from './store-fs.js';
import type { FateLine } from '@hongxian/core';

const LINES_DIR = 'lines';

export interface LineRounds {
  out: RoundState;
  in: RoundState;
}

export function loadLineRounds(s: FsStore, lineDir: string, lineId: string): LineRounds {
  const stored = s.read<Partial<LineRounds>>(`${LINES_DIR}/${lineDir}/rounds.json`);
  const fresh = (): RoundState => createRoundState(lineId);
  return {
    // 兼容 v1.0 落盘结构（字段缺失时按新状态起）
    out: normalizeState(stored?.out, lineId),
    in: normalizeState(stored?.in, lineId),
  };
}

function normalizeState(state: Partial<RoundState> | undefined, lineId: string): RoundState {
  const base = createRoundState(lineId);
  if (!state || typeof state !== 'object') return base;
  return {
    ...base,
    ...state,
    history: Array.isArray(state.history) ? state.history : [],
    covered_dimensions: Array.isArray(state.covered_dimensions) ? state.covered_dimensions : [],
    pending_answer: state.pending_answer ?? null,
  };
}

export function saveLineRounds(s: FsStore, lineDir: string, rounds: LineRounds): void {
  s.write(`${LINES_DIR}/${lineDir}/rounds.json`, rounds);
}

/** 找一条姻缘线（按 card_id 精确匹配，或 line_id 前缀；返回存储目录名） */
export function findLine(
  s: FsStore,
  cardIdOrPrefix: string,
): { line: FateLine; dir: string } | null {
  for (const dir of s.list(LINES_DIR)) {
    const line = s.read<FateLine>(`${LINES_DIR}/${dir}/state.json`);
    if (!line) continue;
    if (line.line_id === cardIdOrPrefix || line.line_id.startsWith(cardIdOrPrefix) || dir.startsWith(cardIdOrPrefix)) {
      return { line, dir };
    }
  }
  return null;
}

/** 轮次视图（供工具输出：两个方向 + 毕业建议） */
export function roundsView(rounds: LineRounds): {
  out: ReturnType<typeof roundSummary>;
  in: ReturnType<typeof roundSummary>;
  out_last: ReturnType<typeof latestRoundEvidence>;
  in_last: ReturnType<typeof latestRoundEvidence>;
} {
  return {
    out: roundSummary(rounds.out),
    in: roundSummary(rounds.in),
    out_last: latestRoundEvidence(rounds.out),
    in_last: latestRoundEvidence(rounds.in),
  };
}

/** 便捷：出题（自动推进轮次号） */
export function applyOpenTopic(state: RoundState, topic: Omit<TopicRecord, 'round'>): RoundState {
  return openTopic(state, { ...topic, round: 0 });
}

/** 便捷：记答案（轮次号不匹配时抛错，由工具层转成可读提示） */
export function applyAnswer(state: RoundState, answer: AnswerRecord): RoundState {
  return recordAnswer(state, answer);
}

/** 便捷：闭合 */
export function applyClose(state: RoundState, incremental: boolean, dimensions: string[] = []): RoundState {
  return closeRound(state, incremental, dimensions);
}
