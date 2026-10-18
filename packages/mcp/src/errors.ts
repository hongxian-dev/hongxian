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
