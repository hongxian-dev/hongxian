import { describe, expect, it } from 'vitest';
import {
  STAGE_ORDER,
  assembleProfile,
  buildDepth,
  buildRecap,
  computeCompleteness,
  confirmRecap,
  createInterviewState,
  rejectRecap,
  submitStageAnswers,
  validateDealbreakers,
  validateVocabFields,
} from '../src/profile/interview.js';

const facts = {
  nickname: '阿泽',
  gender: 'male' as const,
  seeking: 'female' as const,
  age_band: '26_30',
  city: { code: '310100', name: '上海' },
  height_band: '171_175',
  marital_status: 'never_married',
  job_category: 'tech',
  education_band: 'bachelor',
  interests: ['outdoor', 'reading'],
  bio: '写代码也爬山',
  goal: 'marriage_oriented' as const,
};

describe('渐进访谈状态机（D1）', () => {
  it('三阶段顺序：facts → preferences → values', () => {
    expect(STAGE_ORDER).toEqual(['facts', 'preferences', 'values']);
    let s = createInterviewState();
    expect(s.stage).toBe('facts');
    s = confirmRecap(submitStageAnswers(s, 'facts', facts, '复述稿'));
    expect(s.stage).toBe('preferences');
    expect(s.confirmed_stages).toEqual(['facts']);
  });

  it('复述门闩：未确认的答案不进 confirmed', () => {
    let s = createInterviewState();
    s = submitStageAnswers(s, 'facts', facts, '我理解的你是……');
    expect(s.pending_recap).not.toBeNull();
    expect(s.confirmed.facts).toBeUndefined(); // 门闩：未确认不写入
    s = confirmRecap(s);
    expect(s.confirmed.facts?.nickname).toBe('阿泽');
    expect(s.pending_recap).toBeNull();
  });

  it('否决复述：丢弃答案留在本阶段', () => {
    let s = createInterviewState();
    s = submitStageAnswers(s, 'facts', facts, '复述稿');
    s = rejectRecap(s);
    expect(s.pending_recap).toBeNull();
    expect(s.confirmed.facts).toBeUndefined();
    expect(s.stage).toBe('facts');
  });

  it('复述稿包含关键事实（防 AI 幻觉写歪的可核对文本）', () => {
    const recap = buildRecap('facts', facts);
    expect(recap).toContain('阿泽');
    expect(recap).toContain('上海');
    expect(recap).toContain('确认后我才写进画像');
  });

  it('completeness：空画像 0、全画像高、部分中等', () => {
    const empty = computeCompleteness({ l1: {}, l2: {} });
    expect(empty).toBe(0);
    const full = computeCompleteness({ l1: facts as unknown as Record<string, unknown>, l2: sampleL2 });
    expect(full).toBeGreaterThan(0.8);
    const partial = computeCompleteness({ l1: { nickname: 'x' }, l2: {} });
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(0.2);
  });

  it('depth 标记：completeness 钳制 0–1', () => {
    expect(buildDepth(3, 1.5, 'local').completeness).toBe(1);
    expect(buildDepth(3, -0.5, 'cloud').completeness).toBe(0);
  });

  it('assembleProfile：三阶段答案分流到 L1/L2', () => {
    let s = createInterviewState();
    s = confirmRecap(submitStageAnswers(s, 'facts', facts, 'r'));
    const profile = assembleProfile(s);
    expect(profile.l1.nickname).toBe('阿泽');
    expect(profile.l2.dealbreakers).toEqual([]);
  });
});

const sampleL2 = {
  values_tags: [{ tag: 'family_first', weight: 0.8 }],
  lifestyle: { sleep: 'normal' },
  family_view: { childbearing: 'want' },
  money_view: 'balanced',
  assets_brief: { house: 'not_yet' },
  dealbreakers: [{ dimension: 'smoking', note: '完全不能接受' }],
  values_qa: [
    { question: 'q1', answer: 'a1' },
    { question: 'q2', answer: 'a2' },
    { question: 'q3', answer: 'a3' },
  ],
  partner_pref: '情绪稳定',
};

describe('画像字段校验（受控词表纪律）', () => {
  it('dealbreakers：≤5 条、维度受控、描述 ≤50 字', () => {
    expect(validateDealbreakers([{ dimension: 'smoking', note: '不接受' }]).valid).toBe(true);
    expect(validateDealbreakers([{ dimension: 'no_such_dim', note: 'x' }]).valid).toBe(false);
    expect(validateDealbreakers([{ dimension: 'smoking', note: 'x'.repeat(51) }]).valid).toBe(false);
    const six = Array.from({ length: 6 }, () => ({ dimension: 'smoking', note: 'x' }));
    expect(validateDealbreakers(six).valid).toBe(false);
  });

  it('兴趣 ≤5、价值观 ≤8、问答 3–5 段', () => {
    expect(validateVocabFields({ interests: ['outdoor', 'sports'] }).valid).toBe(true);
    expect(validateVocabFields({ interests: ['outdoor', '不存在的'] }).valid).toBe(false);
    expect(validateVocabFields({ interests: ['a', 'b', 'c', 'd', 'e', 'f'] as never }).valid).toBe(false);
    expect(validateVocabFields({ values_qa: [1, 2] }).valid).toBe(false);
    expect(validateVocabFields({ values_qa: [1, 2, 3, 4] }).valid).toBe(true);
  });
});
