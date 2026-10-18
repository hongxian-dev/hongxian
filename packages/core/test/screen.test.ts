import { describe, expect, it } from 'vitest';
import {
  buildCompareResult,
  computeTier,
  findResonance,
  findTalkableDifferences,
  screenCompatibility,
  type ProfileView,
} from '../src/match/screen.js';

const mine: ProfileView = {
  l1: {
    nickname: '阿泽',
    gender: 'male',
    seeking: 'female',
    interests: ['outdoor', 'reading', 'food'],
    age_band: '26_30',
    marital_status: 'never_married',
  },
  l2: {
    values_tags: [
      { tag: 'family_first', weight: 0.8 },
      { tag: 'life_balance', weight: 0.6 },
    ],
    money_view: 'balanced',
    lifestyle: { sleep: 'normal', smoking: 'never' },
    family_view: { childbearing: 'want' },
    dealbreakers: [{ dimension: 'smoking', note: '完全不能接受' }],
    values_qa: [],
  },
};

const hers: ProfileView = {
  l1: {
    nickname: '小满',
    gender: 'female',
    seeking: 'male',
    interests: ['reading', 'travel', 'food'],
    age_band: '26_30',
    marital_status: 'never_married',
  },
  l2: {
    values_tags: [
      { tag: 'family_first', weight: 0.7 },
      { tag: 'free_explore', weight: 0.5 },
    ],
    money_view: 'experiential',
    lifestyle: { sleep: 'early_bird', smoking: 'never' },
    family_view: { childbearing: 'want' },
    dealbreakers: [],
    values_qa: [],
  },
};

describe('粗筛（零 token 结构化规则，D7）', () => {
  it('方向匹配 + 无硬伤 → 通过', () => {
    const r = screenCompatibility(mine, hers);
    expect(r.passed).toBe(true);
    expect(r.direction_ok).toBe(true);
    expect(r.dealbreaker_hits).toHaveLength(0);
  });

  it('匹配方向不一致 → 不通过', () => {
    const wrongDir: ProfileView = { ...hers, l1: { ...hers.l1, gender: 'male' } };
    const r = screenCompatibility(mine, wrongDir);
    expect(r.passed).toBe(false);
    expect(r.direction_ok).toBe(false);
    expect(r.reasons.some((x) => x.includes('方向'))).toBe(true);
  });

  it('dealbreaker 双向冲突命中（我的底线撞对方的生活方式）', () => {
    const smoker: ProfileView = {
      ...hers,
      l2: { ...hers.l2, lifestyle: { sleep: 'normal', smoking: 'regularly' } },
    };
    const r = screenCompatibility(mine, smoker);
    expect(r.passed).toBe(false);
    expect(r.dealbreaker_hits.length).toBeGreaterThan(0);
    expect(r.dealbreaker_hits[0]!.dimension).toBe('smoking');
  });

  it('对方也把吸烟当底线 = 双向共识，不算硬伤命中', () => {
    const alsoNoSmoke: ProfileView = {
      ...hers,
      l2: { ...hers.l2, dealbreakers: [{ dimension: 'smoking', note: '不接受烟味' }] },
    };
    const r = screenCompatibility(mine, alsoNoSmoke);
    expect(r.passed).toBe(true);
  });
});

describe('共鸣与可聊差异（D6 三区素材）', () => {
  it('兴趣重叠 → 共鸣点', () => {
    const resonance = findResonance(mine, hers);
    expect(resonance.some((r) => r.point.includes('共同兴趣'))).toBe(true);
    expect(resonance.find((r) => r.point.includes('共同兴趣'))!.point).toContain('reading');
  });

  it('价值观标签重叠 → 共鸣点', () => {
    const resonance = findResonance(mine, hers);
    expect(resonance.some((r) => r.point.includes('价值观共鸣'))).toBe(true);
  });

  it('消费观/作息差异 → 可聊差异（破冰话题）', () => {
    const diffs = findTalkableDifferences(mine, hers);
    expect(diffs.some((d) => d.dimension === '消费观')).toBe(true);
    expect(diffs.some((d) => d.dimension === '作息')).toBe(true);
  });

  it('unspecified 不计入差异', () => {
    const unspecified: ProfileView = { ...hers, l2: { ...hers.l2, money_view: 'unspecified' } };
    const diffs = findTalkableDifferences(mine, unspecified);
    expect(diffs.some((d) => d.dimension === '消费观')).toBe(false);
  });
});

describe('档位计算（D6 三条兜底）', () => {
  it('粗筛未过 → 缘分未至', () => {
    const screen = { passed: false, reasons: [], dealbreaker_hits: [], direction_ok: false };
    const { tier } = computeTier(screen, 0, 0, 0.9, 0.9);
    expect(tier).toBe('not_yet');
  });

  it('硬伤命中 → 封顶"可以聊聊"', () => {
    const screen = {
      passed: false,
      reasons: ['硬伤'],
      dealbreaker_hits: [{ dimension: 'smoking', mine: 'a', theirs: 'b' }],
      direction_ok: true,
    };
    const { tier, capped } = computeTier(screen, 3, 2, 0.9, 0.9);
    expect(tier).toBe('can_chat');
    expect(capped).toBe(true);
  });

  it('信息不足（completeness<0.6）→ 降档 + 低置信', () => {
    const screen = { passed: true, reasons: [], dealbreaker_hits: [], direction_ok: true };
    const high = computeTier(screen, 3, 2, 0.9, 0.9);
    expect(high.tier).toBe('worth_meeting');
    const low = computeTier(screen, 3, 2, 0.9, 0.4);
    expect(low.lowConfidence).toBe(true);
    expect(low.tier).toBe('worth_knowing'); // 降一档
  });

  it('共鸣多 → 档位更高', () => {
    const screen = { passed: true, reasons: [], dealbreaker_hits: [], direction_ok: true };
    expect(computeTier(screen, 1, 0, 0.9, 0.9).tier).toBe('can_chat');
    expect(computeTier(screen, 2, 1, 0.9, 0.9).tier).toBe('worth_knowing');
    expect(computeTier(screen, 3, 2, 0.9, 0.9).tier).toBe('worth_meeting');
  });
});

describe('buildCompareResult（compare 工具输出契约）', () => {
  it('完整组装：档位 + 叙事素材 + 双完整性', () => {
    const r = buildCompareResult(mine, hers, 0.85, 0.75);
    expect(r.screened_out).toBe(false);
    expect(r.tier).not.toBe('not_yet');
    expect(r.narrative_input.resonance.length).toBeGreaterThan(0);
    expect(r.narrative_input.talkable_differences.length).toBeGreaterThan(0);
    expect(r.completeness_mine).toBe(0.85);
    expect(r.confidence_low).toBe(false);
  });

  it('硬伤场景：capped 置位 + hits 进入叙事', () => {
    const smoker: ProfileView = {
      ...hers,
      l2: { ...hers.l2, lifestyle: { sleep: 'normal', smoking: 'regularly' } },
    };
    const r = buildCompareResult(mine, smoker, 0.9, 0.9);
    expect(r.screened_out).toBe(true);
    expect(r.tier_capped_by_dealbreaker).toBe(true);
    expect(r.narrative_input.dealbreaker_hits[0]!.dimension).toBe('smoking');
  });
});
