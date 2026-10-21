/**
 * Skill 侧匿名计数：出网纪律 + 工作量证明（与 Worker 同口径）
 *
 * 2026-10-21 修复：原实现只发 { metric, bucket }，Worker 要求 { salt, nonce } 并校验
 * sha256(salt|metric|bucket|nonce) 前导 0——不补 PoW 的话每次上报都是 403，静默失败。
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportMetric } from '../src/counter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reportMetric', () => {
  it('opt-in 关闭 → 零出网（不调用 fetch）', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const r = await reportMetric(false, 'card_signed', 'female');
    expect(r.reported).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('词表外指标拒绝上报', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const r = await reportMetric(true, 'photo_uploaded', 'none');
    expect(r.reported).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('开启时携带可验证的 PoW（Worker 侧按同公式校验）', async () => {
    let sent: { metric: string; bucket: string; salt: string; nonce: string } | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sent = JSON.parse(String((init as RequestInit).body));
      return new Response('{"ok":true}', { status: 200 });
    });

    const r = await reportMetric(true, 'card_signed', 'female');
    expect(r.reported).toBe(true);
    expect(sent).not.toBeNull();
    const b = sent!;
    expect(b.metric).toBe('card_signed');
    expect(b.bucket).toBe('female');
    expect(b.salt).toMatch(/^[0-9a-f]{32}$/);

    const h = createHash('sha256').update(`${b.salt}|${b.metric}|${b.bucket}|${b.nonce}`).digest('hex');
    expect(h.startsWith('0000')).toBe(true);
  });
});
