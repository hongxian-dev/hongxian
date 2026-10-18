/**
 * FsStore：~/.hongxian 文件存储（core.Store 的实现层）
 *
 * 技术详设 §5 布局：
 *   keys/（id.enc/kx.enc/lk.enc）profile/（interviews.jsonl + profile.json）
 *   cards/mine/ cards/contacts/<owner_key_id>/ lines/<key_id>/{state.json,envelopes/,notes.md}
 *   ledger.db（v1 纯 JSON 索引，见执行设计 E1） settings.json
 *
 * 路径全程 node:path API + NFC 归一化（Windows 中文路径，技术详设 §9 风险⑥）。
 * 目录可用 HONGXIAN_HOME 环境变量覆盖（测试与便携场景）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, dirname } from 'node:path';
import type { Store } from '@hongxian/core';

export function hongxianHome(): string {
  return normalize(process.env.HONGXIAN_HOME ?? join(homedir(), '.hongxian'));
}

function resolve(path: string): string {
  // 防目录逃逸：所有路径相对 home 且必须归一化后仍以 home 开头
  const home = hongxianHome();
  const full = normalize(join(home, path));
  if (full !== home && !full.startsWith(home + normalize('/'))) {
    throw new Error(`非法路径（越出数据目录）：${path}`);
  }
  return full;
}

export class FsStore implements Store {
  read<T = unknown>(path: string): T | null {
    const full = resolve(path);
    if (!existsSync(full)) return null;
    try {
      return JSON.parse(readFileSync(full, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  write(path: string, data: unknown): void {
    const full = resolve(path);
    mkdirSync(dirname(full), { recursive: true });
    // 原子写：临时文件 + rename（防云盘同步中断写坏文件——技术详设 §5 WAL 容忍的延伸）
    const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, full);
  }

  remove(path: string): void {
    const full = resolve(path);
    if (existsSync(full)) rmSync(full, { recursive: true, force: true });
  }

  list(dir: string): string[] {
    const full = resolve(dir);
    if (!existsSync(full)) return [];
    return readdirSync(full).sort();
  }

  exists(path: string): boolean {
    return existsSync(resolve(path));
  }
}

/** 删除整个数据目录并返回删除清单（wipe 验收：无残留） */
export function wipeHome(): { removed: string[] } {
  const home = hongxianHome();
  const removed: string[] = [];
  if (existsSync(home)) {
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else removed.push(p);
      }
    };
    walk(home);
    rmSync(home, { recursive: true, force: true });
  }
  return { removed };
}

/** 数据目录是否存在（首次启动判定） */
export function homeExists(): boolean {
  return existsSync(hongxianHome());
}
