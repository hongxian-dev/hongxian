/**
 * 门闩错误（会话未解锁 / 未完成知情同意）
 * 独立模块：避免 context ↔ tools-profile 环依赖。
 */

export class LockedError extends Error {
  constructor() {
    super('会话未解锁：请先用 24 词恢复短语解锁（interview(action="unlock")）。');
    this.name = 'LockedError';
  }
}

export class ConsentError extends Error {
  constructor() {
    super('首次使用需完成知情同意（interview(action="start")）。');
    this.name = 'ConsentError';
  }
}

/**
 * 风险提示未确认（D7 / C2①）
 *
 * 这是**可继续的中间态，不是报错**——上层据此把全文展示给用户并等他确认。
 * 与 ConsentError 分开，是因为它必须排在知情同意**之前**：先知道会出什么事，
 * 再决定要不要开始。
 */
export class SafetyAckError extends Error {
  readonly code = 'ACK_REQUIRED';
  constructor() {
    super('建画像前请先读完风险提示（interview(action="start") 会返回全文）。');
    this.name = 'SafetyAckError';
  }
}
