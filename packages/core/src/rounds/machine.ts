/**
 * 轮次状态机（D11：一轮 = 最小决策单元）
 *
 * 一轮结构：甲出 1 题（1 主题 + ≤2 追问封顶）→ 乙作答 + 对等反问 → 甲答 → 回卷闭合
 *          → 双方月老各出增量小报告 → 双方主人各自决策：继续 / 毕业 / 放下。
 * 毕业机制：跟踪信息饱和度与维度覆盖度，连续无增量 → 诚实建议"毕业或放下"
 *          ——月老不做笔友经纪（无限网聊是约会产品的经典死法）。
 */

export type RoundPhase = 'topic_out' | 'answer_in' | 'closed';

export interface TopicRecord {
  round: number;
  topic: string;
  followups: string[];
  reason: string;
  channel: 'owner' | 'yuelao';
}

export interface AnswerRecord {
  round: number;
  topic_ref: string;
  status: 'answered' | 'ask_master' | 'deferred';
  answer?: string;
  note?: string;
}

export interface RoundRecord {
  round: number;
  topic: TopicRecord;
  answer: AnswerRecord | null;
  /** 本轮是否有增量信息（饱和度跟踪） */
  incremental: boolean;
  closed_at: string;
}

/** 一条姻缘线的轮次状态（对端 card_id 维度，D15⑥ 多线互不污染） */
export interface RoundState {
  line_id: string;
  round_no: number;
  phase: RoundPhase;
  current_topic: TopicRecord | null;
  history: RoundRecord[];
  /** 连续无增量的轮数（毕业机制判据） */
  stagnant_rounds: number;
  /** 已覆盖的题库维度 */
  covered_dimensions: string[];
}

/** D11 铁律：追问封顶（防审讯化） */
export const MAX_FOLLOWUPS = 2;
/** 毕业机制：连续无增量轮数阈值 */
export const STAGNATION_THRESHOLD = 2;

export function createRoundState(lineId: string): RoundState {
  return {
    line_id: lineId,
    round_no: 0,
    phase: 'topic_out',
    current_topic: null,
    history: [],
    stagnant_rounds: 0,
    covered_dimensions: [],
  };
}

/** 出题（D11：1 主题 + ≤2 追问；追问封顶在 schema 层已约束，这里再断言） */
export function openTopic(state: RoundState, topic: TopicRecord): RoundState {
  if (topic.followups.length > MAX_FOLLOWUPS) {
    throw new Error(`追问最多 ${MAX_FOLLOWUPS} 个（防审讯化，D11）`);
  }
  const round = state.round_no + 1;
  return {
    ...state,
    round_no: round,
    phase: 'topic_out',
    current_topic: { ...topic, round },
  };
}

/** 回卷三态应答（D10：answered / ask_master / deferred） */
export function recordAnswer(state: RoundState, answer: AnswerRecord): RoundState {
  if (!state.current_topic) throw new Error('当前没有待答的考题');
  if (answer.round !== state.round_no) throw new Error('回卷轮次与当前轮次不符');
  return { ...state, phase: 'answer_in' };
}

/** 闭合一轮：记录增量性（增量 = 新信息进入画像 or 覆盖新维度） */
export function closeRound(state: RoundState, incremental: boolean, newDimensions: string[] = []): RoundState {
  if (!state.current_topic) throw new Error('没有进行中的轮次');
  const record: RoundRecord = {
    round: state.round_no,
    topic: state.current_topic,
    answer: null, // 由调用方在闭合前经 recordAnswer 的答案补充（此处为纯状态推进）
    incremental,
    closed_at: new Date().toISOString(),
  };
  const covered = new Set([...state.covered_dimensions, ...newDimensions]);
  return {
    ...state,
    phase: 'closed',
    current_topic: null,
    history: [...state.history, record],
    stagnant_rounds: incremental ? 0 : state.stagnant_rounds + 1,
    covered_dimensions: [...covered],
  };
}

/** 带答案闭合（便捷：把答案并入记录） */
export function closeRoundWithAnswer(
  state: RoundState,
  answer: AnswerRecord,
  incremental: boolean,
  newDimensions: string[] = [],
): RoundState {
  const withAnswer = recordAnswer(state, answer);
  return closeRound(withAnswer, incremental, newDimensions);
}

/** 毕业机制判据：连续无增量 ≥ 阈值 → 月老诚实建议"毕业或放下" */
export function shouldSuggestGraduation(state: RoundState): boolean {
  return state.stagnant_rounds >= STAGNATION_THRESHOLD;
}

/** 信息饱和度：已回答轮次 / 总轮次（供报告引用） */
export function saturationRatio(state: RoundState): number {
  if (state.history.length === 0) return 0;
  const answered = state.history.filter((h) => h.incremental).length;
  return Math.round((answered / state.history.length) * 100) / 100;
}

/** 轮次摘要（增量小报告的输入素材） */
export function roundSummary(state: RoundState): {
  total_rounds: number;
  stagnant_rounds: number;
  saturation: number;
  covered: string[];
  suggest_graduation: boolean;
} {
  return {
    total_rounds: state.history.length,
    stagnant_rounds: state.stagnant_rounds,
    saturation: saturationRatio(state),
    covered: state.covered_dimensions,
    suggest_graduation: shouldSuggestGraduation(state),
  };
}
