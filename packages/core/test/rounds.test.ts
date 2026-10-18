import { describe, expect, it } from 'vitest';
import {
  MAX_FOLLOWUPS,
  STAGNATION_THRESHOLD,
  closeRound,
  closeRoundWithAnswer,
  createRoundState,
  openTopic,
  recordAnswer,
  roundSummary,
  saturationRatio,
  shouldSuggestGraduation,
} from '../src/rounds/machine.js';

describe('轮次状态机（D11）', () => {
  const topic = (over: Partial<Parameters<typeof openTopic>[1]> = {}) => ({
    round: 0,
    topic: '周末怎么过',
    followups: [] as string[],
    reason: '揭示生活方式',
    channel: 'yuelao' as const,
    ...over,
  });

  it('出题 → 回卷 → 闭合的完整一轮', () => {
    let s = createRoundState('line-1');
    s = openTopic(s, topic());
    expect(s.phase).toBe('topic_out');
    expect(s.round_no).toBe(1);
    s = recordAnswer(s, { round: 1, topic_ref: '周末怎么过', status: 'answered', answer: '去徒步' });
    expect(s.phase).toBe('answer_in');
    s = closeRound(s, true, ['生活方式']);
    expect(s.phase).toBe('closed');
    expect(s.history).toHaveLength(1);
    expect(s.covered_dimensions).toContain('生活方式');
  });

  it('追问 ≤2 封顶（防审讯化）', () => {
    const s = createRoundState('l');
    expect(MAX_FOLLOWUPS).toBe(2);
    expect(() => openTopic(s, topic({ followups: ['a', 'b', 'c'] }))).toThrow(/追问最多/);
    expect(() => openTopic(s, topic({ followups: ['a', 'b'] }))).not.toThrow();
  });

  it('轮次不符的回卷拒绝', () => {
    let s = createRoundState('l');
    s = openTopic(s, topic());
    expect(() => recordAnswer(s, { round: 99, topic_ref: 'x', status: 'answered' })).toThrow(/轮次/);
  });

  it('毕业机制：连续无增量 ≥2 轮 → 建议毕业或放下', () => {
    let s = createRoundState('l');
    expect(STAGNATION_THRESHOLD).toBe(2);
    for (let i = 0; i < 3; i++) {
      s = openTopic(s, topic({ topic: `问题${i}` }));
      s = closeRound(s, false);
    }
    expect(shouldSuggestGraduation(s)).toBe(true);
    expect(roundSummary(s).stagnant_rounds).toBe(3);
  });

  it('增量轮次重置停滞计数', () => {
    let s = createRoundState('l');
    s = openTopic(s, topic());
    s = closeRound(s, false);
    expect(s.stagnant_rounds).toBe(1);
    s = openTopic(s, topic());
    s = closeRound(s, true, ['金钱观']);
    expect(s.stagnant_rounds).toBe(0);
    expect(shouldSuggestGraduation(s)).toBe(false);
  });

  it('饱和度：增量轮 / 总轮', () => {
    let s = createRoundState('l');
    const topic = (t: string) => ({
      round: 0,
      topic: t,
      followups: [] as string[],
      reason: 'r',
      channel: 'yuelao' as const,
    });
    s = openTopic(s, topic('t1'));
    s = closeRoundWithAnswer(s, { round: 1, topic_ref: 't1', status: 'answered' }, true);
    s = openTopic(s, topic('t2'));
    s = closeRoundWithAnswer(s, { round: 2, topic_ref: 't2', status: 'answered' }, false);
    s = openTopic(s, topic('t3'));
    s = closeRoundWithAnswer(s, { round: 3, topic_ref: 't3', status: 'answered' }, true);
    expect(saturationRatio(s)).toBeCloseTo(0.67, 1);
    const summary = roundSummary(s);
    expect(summary.total_rounds).toBe(3);
    expect(summary.suggest_graduation).toBe(false);
  });

  it('没有进行中的轮次时闭合拒绝', () => {
    const s = createRoundState('l');
    expect(() => closeRound(s, true)).toThrow(/进行中/);
  });
});
