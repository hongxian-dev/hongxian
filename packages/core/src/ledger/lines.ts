/**
 * 红线手账 · 姻缘线（D3② / D4 / D15④⑥）
 *
 * 手账是本地台账：已递出 / 已回音 / 未通过——**不假装知道对方心思**
 * （v1 无服务器，不知道对方是否已读已想，不得假装知道——D4）。
 * 多线并行（D15⑥）：每条线独立状态机，月老不主动评价"哪条线更好"。
 * 防骚扰（D15④）：同一发件人连续 3 次升级请求未获回应 → 月老建议拉黑；
 *                 拉黑后该发件人一切信封不再呈报主人（本地生效，不通知对方）。
 */

/** 姻缘线状态（本地认知的三种 + 流程态） */
export type LineStatus =
  | 'card_sent' // 已递出名片（等回音）
  | 'card_received' // 收到名片
  | 'in_rounds' // 深聊轮次中
  | 'graduated' // 已毕业（见面层已解锁）
  | 'no_follow_up' // 未通过（本地认知，对方不可见）
  | 'blocked'; // 已拉黑

export interface FateLine {
  /** 对端 card_id（姻缘线唯一标识） */
  line_id: string;
  /** 对端 owner_key_id 目录名（存储隔离） */
  owner_dir: string;
  status: LineStatus;
  /** 已发出的升级请求未获回应次数（D15④：3 次 → 建议拉黑） */
  unresponded_upgrades: number;
  rounds_total: number;
  created_at: string;
  last_activity: string;
  blocked: boolean;
  /** 本地备注（见面复盘等，只存本地） */
  notes: string[];
}

/** D15④ 铁律：3 次未回应 */
export const MAX_UNRESPONDED_UPGRADES = 3;

export function createLine(lineId: string, ownerDir: string, status: LineStatus = 'card_received'): FateLine {
  const now = new Date().toISOString();
  return {
    line_id: lineId,
    owner_dir: ownerDir,
    status,
    unresponded_upgrades: 0,
    rounds_total: 0,
    created_at: now,
    last_activity: now,
    blocked: false,
    notes: [],
  };
}

/** 发出一轮升级请求（topic/upgrade）→ 未回应计数 +1 */
export function noteUpgradeSent(line: FateLine): FateLine {
  return {
    ...line,
    unresponded_upgrades: line.unresponded_upgrades + 1,
    last_activity: new Date().toISOString(),
  };
}

/** 收到对方回音 → 未回应计数清零 */
export function noteResponseReceived(line: FateLine): FateLine {
  return {
    ...line,
    unresponded_upgrades: 0,
    last_activity: new Date().toISOString(),
  };
}

/** 进入深聊轮次 */
export function enterRounds(line: FateLine): FateLine {
  return { ...line, status: 'in_rounds', rounds_total: line.rounds_total + 1, last_activity: new Date().toISOString() };
}

/** 毕业（见面层解锁后） */
export function graduate(line: FateLine): FateLine {
  return { ...line, status: 'graduated', last_activity: new Date().toISOString() };
}

/** 本地认知"未通过"（对方不可见——D4 静默） */
export function markNoFollowUp(line: FateLine): FateLine {
  return { ...line, status: 'no_follow_up', last_activity: new Date().toISOString() };
}

/** 是否达到拉黑建议线（D15④） */
export function shouldSuggestBlock(line: FateLine): boolean {
  return !line.blocked && line.unresponded_upgrades >= MAX_UNRESPONDED_UPGRADES;
}

/** 拉黑（本地生效，不通知对方，静默到底） */
export function blockLine(line: FateLine): FateLine {
  return { ...line, blocked: true, status: 'blocked', last_activity: new Date().toISOString() };
}

/** 解除拉黑（主人显式操作） */
export function unblockLine(line: FateLine): FateLine {
  return { ...line, blocked: false, status: 'card_received', last_activity: new Date().toISOString() };
}

/** 该线的信封是否呈报主人（拉黑后一切信封不再呈报） */
export function shouldPresentEnvelope(line: FateLine): boolean {
  return !line.blocked;
}

/** 手账视图（ledger 工具的返回） */
export interface LedgerView {
  total: number;
  by_status: Record<LineStatus, number>;
  block_suggestions: { line_id: string; unresponded: number }[];
}

export function ledgerView(lines: FateLine[]): LedgerView {
  const by_status: Record<LineStatus, number> = {
    card_sent: 0,
    card_received: 0,
    in_rounds: 0,
    graduated: 0,
    no_follow_up: 0,
    blocked: 0,
  };
  for (const l of lines) by_status[l.status] += 1;
  return {
    total: lines.length,
    by_status,
    block_suggestions: lines
      .filter(shouldSuggestBlock)
      .map((l) => ({ line_id: l.line_id, unresponded: l.unresponded_upgrades })),
  };
}
