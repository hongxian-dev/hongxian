import { describe, expect, it } from 'vitest';
import { buildMeetingKit, renderMeetingKit } from '../src/guide/meeting-kit.js';
import { buildCalibrationHints, renderDebrief, type DebriefRecord } from '../src/guide/debrief.js';
import type { ProfileView } from '../src/match/screen.js';

const mine: ProfileView = {
  l1: { nickname: '阿泽', gender: 'male', seeking: 'female', interests: ['reading', 'outdoor'], city: { name: '上海' }, goal: 'marriage_oriented' },
  l2: {
    values_tags: [{ tag: 'family_first', weight: 0.8 }],
    lifestyle: { sleep: 'normal' },
    family_view: { childbearing: 'want' },
    money_view: 'balanced',
    dealbreakers: [{ dimension: 'smoking', note: '完全不能接受' }],
    values_qa: [{ question: '家是什么', answer: '可以说累的地方' }],
  },
};

const theirs: ProfileView = {
  l1: { nickname: '小满', gender: 'female', seeking: 'male', interests: ['reading'], city: { name: '上海' }, goal: 'marriage_oriented' },
  l2: {
    values_tags: [{ tag: 'family_first', weight: 0.6 }],
    lifestyle: { sleep: 'night_owl' },
    family_view: { childbearing: 'want' },
    money_view: 'experience_first',
    dealbreakers: [],
    values_qa: [{ question: '理想的一天', answer: '睡到自然醒再去看展' }],
  },
};

describe('见面锦囊（D3④ / D13）', () => {
  it('话题来自真实画像：共鸣 + 可聊差异，不编造', () => {
    const kit = buildMeetingKit({ mine, theirs, unlocked: ['L1', 'L2'] });
    expect(kit.topics.some((t) => t.kind === 'resonance')).toBe(true);
    expect(kit.topics.some((t) => t.kind === 'difference')).toBe(true);
    // 话题文本必须能追溯到画像里的字段
    const all = kit.topics.map((t) => t.suggest).join(' ');
    expect(all).toContain('reading');
  });

  it('安全清单与反诈终检必带（金钱红线不许省）', () => {
    const kit = buildMeetingKit({ mine, theirs, unlocked: ['L1'] });
    expect(kit.safety.length).toBeGreaterThanOrEqual(4);
    expect(kit.safety.join(' ')).toContain('公共场所');
    expect(kit.anti_fraud.join(' ')).toContain('任何涉及金钱的请求');
  });

  it('对称性回顾：按已解锁层与已交付字段如实标注', () => {
    const kit = buildMeetingKit({
      mine,
      theirs,
      unlocked: ['L1', 'L2', 'L3'],
      grantedFields: ['contact_wechat'],
    });
    const text = kit.symmetry.map((s) => s.note).join(' ');
    expect(text).toContain('已双向解锁');
    expect(text).toContain('contact_wechat');
  });

  it('未交付见面层时如实说"对方尚未交付"（不假装有）', () => {
    const kit = buildMeetingKit({ mine, theirs, unlocked: ['L1', 'L2'], grantedFields: [] });
    expect(kit.symmetry[2]!.note).toContain('尚未交付');
  });

  it('画像信息不足时给通用话题而不是编内容', () => {
    const kit = buildMeetingKit({ mine: { l1: {}, l2: {} }, theirs: { l1: {}, l2: {} }, unlocked: [] });
    expect(kit.topics).toHaveLength(1);
    expect(kit.topics[0]!.label).toContain('画像信息不足');
  });

  it('渲染文本包含全部四块', () => {
    const text = renderMeetingKit(buildMeetingKit({ mine, theirs, unlocked: ['L1', 'L2'] }));
    for (const heading of ['可以聊的', '怎么见', '安全（第一次见面必看）', '反诈终检', '对称性回顾']) {
      expect(text).toContain(heading);
    }
  });
});

describe('见面复盘（D3③：校准建议但不改画像）', () => {
  const base: DebriefRecord = {
    card_id: 'c1',
    feeling: 'again',
    matches: ['记得我说过的展览'],
    surprises: ['整场都在讲自己的项目'],
    created_at: '2026-10-21T00:00:00.000Z',
  };

  it('命中已有底线原话 → 提示复核，而不是自动改', () => {
    const hints = buildCalibrationHints(
      { ...base, surprises: ['完全不能接受他抽烟的样子'] },
      { dealbreakers: [{ dimension: 'smoking', note: '完全不能接受' }] },
    );
    expect(hints.some((h) => h.action === 'review_dealbreaker')).toBe(true);
    expect(hints[0]!.reason).toContain('重新确认');
  });

  it('感觉不错 → 提示复核底线是否还成立（不替主人下结论）', () => {
    const hints = buildCalibrationHints(base, { dealbreakers: [{ dimension: 'smoking', note: '不能接受' }] });
    expect(hints.some((h) => h.action === 'confirm_preference')).toBe(true);
  });

  it('无复盘内容 → 不给任何建议（少说少错）', () => {
    const hints = buildCalibrationHints(
      { ...base, matches: [], surprises: [], next_time: undefined, feeling: 'unsure' },
      { dealbreakers: [{ dimension: 'smoking', note: '不能接受' }] },
    );
    expect(hints).toHaveLength(0);
  });

  it('渲染明确声明"我不替你改画像"', () => {
    const text = renderDebrief(base, [{ target: 'smoking', action: 'review_dealbreaker', reason: '要不要重新确认？' }]);
    expect(text).toContain('我不替你改画像');
    expect(text).toContain('想再见一面');
  });
});
