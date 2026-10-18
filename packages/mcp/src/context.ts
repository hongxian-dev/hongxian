/**
 * 进程级上下文：FsStore 单例 + 错误门闩辅助
 * （MCP server 进程无常驻内存状态——技术详设原则 2；
 *  这里只持有无状态的 IO 单例，领域状态全部从文件重建）
 */

import { FsStore } from './store-fs.js';
import { LockedError, ConsentError } from './errors.js';

let instance: FsStore | null = null;

export function store(): FsStore {
  if (!instance) instance = new FsStore();
  return instance;
}

/** handler 包装：门闩错误转成月老口吻的文本提示 */
export async function guard<T>(
  fn: () => Promise<T> | T,
  onError: (message: string) => T,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LockedError || e instanceof ConsentError) {
      return onError(e.message);
    }
    return onError(`出了点问题：${(e as Error).message}`);
  }
}
