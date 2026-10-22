/**
 * 声明式圈层（D8 / Schema v0.5）与代访预算帽（D9）测试
 *
 * 圈层要证明三件事：
 * 1. 声明进 meta 明文，且被签名锁死（改了验签就失败）；
 * 2. 两个圈都在本地算——拉取条件圈 A（我要看谁）+ 可见性声明圈 B（谁能看到我）；
 * 3. 方向性必须双向成立（单向过滤产出"我看到他、他看不到我"的错配）。
 */

import { describe, expect, it } from 'vitest';
import { MatchCardEnvelope } from '@hongxian/schema';
import { signMatchCard, verifyMatchCard } from '../src/card/envelope.js';
import { filterPlazaPool, toPlazaCard } from '../src/plaza.js';
import { checkTokenBudget, estimateTokens, withinTokenBudget } from '../src/filter/outbound.js';
import { makeTestKeyProvider, sampleL1, sampleL2 } from './helpers.js';

const depth = { interview_rounds: 9, completeness: 0.75, model_tier: 'local' as const };

/** 造一张带圈层声明的广场卡（自己的密钥 + 自己的声明） */
function plazaWith(declared: Record<string, unknown>) {
  const { key } = makeTestKeyProvider();
  const match = signMatchCard({ depth, l1: sampleL1, l2: sampleL2 }, key);
  return toPlazaCard(match, key, undefined, declared as never);
}

describe('toPlazaCard · 圈层声明进 meta', () => {
  it('声明携带在 meta 上，且验签通过', () => {
    const card = plazaWith({ gender: 'female', seeking: 'male', city: '310000', age_band: '26_30', visible_to: 'all' });
    expect(card.meta.declared_filters).toEqual({
      gender: 'female',
      seeking: 'male',
      city: '310000',
      age_band: '26_30',
      visible_to: 'all',
    });
    expect(verifyMatchCard(card).valid).toBe(true);
  });

  it('声明被签名覆盖：篡改城市后验签失败（服务端/第三方改不了）', () => {
    const card = plazaWith({ city: '310000' });
    const tampered: MatchCardEnvelope = {
      ...card,
      meta: { ...card.meta, declared_filters: { city: '110000' } },
    };
    expect(verifyMatchCard(tampered).valid).toBe(false);
  });

  it('不传声明则整字段缺省（不写空对象——空声明会误导对方以为你声明了范围）', () => {
    const card = plazaWith({});
    expect(card.meta.declared_filters).toBeUndefined();
    expect(verifyMatchCard(card).valid).toBe(true);
  });
});

describe('filterPlazaPool · 拉取条件圈 A', () => {
  it('同城条件：城市不同即排除，统计进 circle', () => {
    const theirs = plazaWith({ city: '110000', gender: 'male', seeking: 'female' });
    const r = filterPlazaPool([theirs], {
      my_filters: { city: '310000', gender: 'female', seeking: 'male' },
    });
    expect(r.outlines).toHaveLength(0);
    expect(r.rejected[0]!.reason).toContain('城市');
    expect(r.stats.circle).toBe(1);
  });

  it('同城命中 + 方向双向成立 → 通过', () => {
    const theirs = plazaWith({ city: '310000', gender: 'male', seeking: 'female', age_band: '26_30' });
    const r = filterPlazaPool([theirs], {
      my_filters: { city: '310000', gender: 'female', seeking: 'male', age_band: '26_30' },
    });
    expect(r.outlines).toHaveLength(1);
    expect(r.outlines[0]!.declared_filters?.city).toBe('310000');
    expect(r.stats).toEqual({ visibility: 0, circle: 0, other: 0 });
  });

  it('方向性单向不成立也排除：他要的不是我这类', () => {
    // 对方 seeking=female，我是 male → 不成立
    const theirs = plazaWith({ gender: 'male', seeking: 'female' });
    const r = filterPlazaPool([theirs], { my_filters: { gender: 'male', seeking: 'male' } });
    expect(r.outlines).toHaveLength(0);
    expect(r.rejected[0]!.reason).toContain('对方的择偶方向');
  });

  it('我要求了条件而对方没声明 → 按"无法确认"排除（否则筛选形同虚设）', () => {
    const theirs = plazaWith({ gender: 'male', seeking: 'female' });
    const r = filterPlazaPool([theirs], { my_filters: { city: '310000' } });
    expect(r.outlines).toHaveLength(0);
    expect(r.rejected[0]!.reason).toContain('无法确认');
  });

  it('不传 my_filters 则完全不筛（看全量——圈层是可选项，不是强制）', () => {
    const theirs = plazaWith({ city: '110000' });
    const r = filterPlazaPool([theirs]);
    expect(r.outlines).toHaveLength(1);
  });
});

describe('filterPlazaPool · 可见性声明圈 B', () => {
  it('对方声明"只对同城可见" + 我不同城 → 排除，统计进 visibility', () => {
    const theirs = plazaWith({ city: '110000', visible_to: 'same_city' });
    const r = filterPlazaPool([theirs], { my_filters: { city: '310000' } });
    expect(r.outlines).toHaveLength(0);
    expect(r.rejected[0]!.reason).toContain('仅同城可见');
    expect(r.stats.visibility).toBe(1);
  });

  it('对方声明仅同城 + 我同城 → 通过', () => {
    const theirs = plazaWith({ city: '310000', visible_to: 'same_city' });
    const r = filterPlazaPool([theirs], { my_filters: { city: '310000' } });
    expect(r.outlines).toHaveLength(1);
  });

  it('我未声明城市时无法互认 → 按不满足处理（声明了限制就得真生效）', () => {
    const theirs = plazaWith({ city: '310000', visible_to: 'same_city' });
    const r = filterPlazaPool([theirs]);
    expect(r.outlines).toHaveLength(0);
    expect(r.rejected[0]!.reason).toContain('无法互认');
  });

  it('respect_visibility=false 只用于调试，可绕过圈 B', () => {
    const theirs = plazaWith({ city: '110000', visible_to: 'same_city' });
    const r = filterPlazaPool([theirs], { respect_visibility: false });
    expect(r.outlines).toHaveLength(1);
  });
});

describe('D9 代访预算帽', () => {
  it('estimateTokens：中文按字计，且对混排偏高而非偏低', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('abcdefghij')).toBeGreaterThanOrEqual(3);
    const mixed = estimateTokens('你介意异地吗 hello world');
    expect(mixed).toBeGreaterThan(8);
  });

  it('checkTokenBudget：未超帽放行，超帽拦下并给出三个数字', () => {
    const ok = checkTokenBudget(100, 200, 8000);
    expect(ok.ok).toBe(true);
    expect(ok).toMatchObject({ used: 100, estimated: 200, cap: 8000 });

    const over = checkTokenBudget(7900, 300, 8000);
    expect(over.ok).toBe(false);
  });

  it('cap=0 表示不设帽（永远放行）', () => {
    expect(checkTokenBudget(1_000_000, 999_999, 0).ok).toBe(true);
    expect(withinTokenBudget(1_000_000, 0)).toBe(false); // 底层语义：0 是"无帽"，由 checkTokenBudget 处理
  });
});
