/**
 * 计数器 Worker 契约测试（真实 fetch handler + 内存 KV）
 *
 * 目的：锁住「Skill 上报的事件名 ↔ Worker 计数家族 ↔ /stats 站点块」这条链。
 * 2026-10-21 修复前，两端词表完全对不上（Skill 发 card_signed，Worker 只认 cards），
 * 且 Skill 未实现 PoW——上报会被 400/403 静默拒绝，线上数字永远是 0。
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';

/** 内存 KV（对齐 Cloudflare KV 的三个方法） */
function fakeKV() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => {
      m.set(k, v);
    },
    list: async ({ prefix }: { prefix: string }) => ({
      keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
    }),
    _dump: () => m,
  };
}

function solvePow(salt: string, metric: string, bucket: string, difficulty = 4): string {
  const required = '0'.repeat(difficulty);
  for (let nonce = 0; nonce < 3_000_000; nonce++) {
    const h = createHash('sha256').update(`${salt}|${metric}|${bucket}|${nonce}`).digest('hex');
    if (h.startsWith(required)) return String(nonce);
  }
  throw new Error('pow not solved');
}

function env() {
  return { COUNTER: fakeKV(), POW_DIFFICULTY: '4', RL_SALT: 'test-salt' } as never;
}

async function bump(body: Record<string, unknown>, e: unknown) {
  const req = new Request('https://count.test/bump', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify(body),
  });
  const res = await (worker as { fetch: (r: Request, e: unknown) => Promise<Response> }).fetch(req, e);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function stats(e: unknown) {
  const res = await (worker as { fetch: (r: Request, e: unknown) => Promise<Response> }).fetch(
    new Request('https://count.test/stats'),
    e,
  );
  return (await res.json()) as { counters: Record<string, number>; site: Record<string, number> };
}

describe('计数器 Worker：事件名 → 计数家族', () => {
  it('Skill 事件名 card_signed 被接收，并同时计入性别聚合', async () => {
    const e = env();
    const salt = 'a1b2c3';
    const body = { metric: 'card_signed', bucket: 'female', salt, nonce: solvePow(salt, 'card_signed', 'female') };
    const r = await bump(body, e);
    expect(r.status).toBe(200);
    expect(r.json.metric).toEqual(['cards_total', 'gender_female']);

    const s = await stats(e);
    expect(s.counters.cards_total).toBe(1);
    expect(s.counters.gender_female).toBe(1);
  });

  it('exchange_initiated / plaza_published 分别计入 envelopes / plaza', async () => {
    const e = env();
    for (const [metric, expectKey] of [
      ['exchange_initiated', 'envelopes_total'],
      ['plaza_published', 'plaza_total'],
    ] as const) {
      const salt = 's-' + metric;
      const r = await bump({ metric, bucket: 'none', salt, nonce: solvePow(salt, metric, 'none') }, e);
      expect(r.status).toBe(200);
      expect(r.json.metric).toEqual([expectKey]);
    }
    const s = await stats(e);
    expect(s.counters.envelopes_total).toBe(1);
    expect(s.counters.plaza_total).toBe(1);
  });

  it('旧口径（metric=家族名 + bucket）继续兼容', async () => {
    const e = env();
    const salt = 'old';
    const r = await bump({ metric: 'cards', bucket: 'total', salt, nonce: solvePow(salt, 'cards', 'total') }, e);
    expect(r.status).toBe(200);
    expect(r.json.metric).toEqual(['cards_total']);
  });

  it('词表外指标一律 400', async () => {
    const e = env();
    expect((await bump({ metric: 'card_signed_by_name', bucket: 'none', salt: 'x', nonce: '0' }, e)).status).toBe(400);
    expect((await bump({ metric: 'cards', bucket: 'female', salt: 'x', nonce: '0' }, e)).status).toBe(400);
  });

  it('PoW 不达标 → 403（Skill 侧必须真解一次）', async () => {
    const e = env();
    const r = await bump({ metric: 'card_signed', bucket: 'none', salt: 'nope', nonce: '0' }, e);
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('pow required');
  });

  it('/stats 的 site 块给出网站四个格子的稳定键名', async () => {
    const e = env();
    const s0 = await stats(e);
    expect(s0.site).toEqual({ cards: 0, imports: 0, envelopes: 0, plaza: 0 });

    const salt = 'q';
    await bump({ metric: 'plaza_published', bucket: 'none', salt, nonce: solvePow(salt, 'plaza_published', 'none') }, e);
    const s1 = await stats(e);
    expect(s1.site.plaza).toBe(1);
    expect(s1.site.cards).toBe(0);
  });
});
