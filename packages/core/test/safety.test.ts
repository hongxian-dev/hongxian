/**
 * 防护一 · 风险提示文案测试（D7 / C2①）
 *
 * 这一组测的不是"文案好不好"，而是**每条写作约束有没有被守住**：
 * 心软一次、加一句"我们会保护你"，出事那天就会成为反噬点。
 */

import { describe, expect, it } from 'vitest';
import {
  SAFETY_ACK_LABEL,
  SAFETY_ACK_REQUIRED,
  SAFETY_NOTICE_TEXT,
  SAFETY_NOTICE_VERSION,
  safetyAckBlock,
  safetyAckSatisfied,
} from '../src/guard/safety.js';

describe('风险提示（防护一）', () => {
  it('第一句是定性句：工具，不是婚介，也不是担保', () => {
    const first = SAFETY_NOTICE_TEXT.split('\n')[0]!;
    expect(first).toBe('红线是工具，不是婚介，也不是担保。');
  });

  it('先说「我们不知道对面是谁」——婚恋场景最容易被误解的地方要先破', () => {
    const iDontKnow = SAFETY_NOTICE_TEXT.indexOf('我们不知道对面是谁');
    const iMoney = SAFETY_NOTICE_TEXT.indexOf('钱一出现');
    const iFake = SAFETY_NOTICE_TEXT.indexOf('有人会冒充我们');
    expect(iDontKnow).toBeGreaterThan(0);
    expect(iDontKnow).toBeLessThan(iMoney);
    expect(iMoney).toBeLessThan(iFake);
  });

  it('不承诺能力之外的保护（无「保障 / 放心 / 绝对 / 百分百」这类词）', () => {
    for (const word of ['保障', '放心', '绝对', '百分百', '无条件']) {
      expect(SAFETY_NOTICE_TEXT).not.toContain(word);
    }
    // 「安全」只允许出现在「人身安全受威胁」这一处事实陈述里——不能拿它当卖点
    expect(SAFETY_NOTICE_TEXT).not.toContain('安全地');
    expect(SAFETY_NOTICE_TEXT.match(/安全/g)?.length).toBe(1);
    expect(SAFETY_NOTICE_TEXT).toContain('人身安全受威胁');
  });

  it('不写「实名认证」，也不用「提高警惕」这类无效建议', () => {
    expect(SAFETY_NOTICE_TEXT).not.toContain('实名认证');
    expect(SAFETY_NOTICE_TEXT).not.toContain('提高警惕');
    expect(SAFETY_NOTICE_TEXT).not.toContain('保持理性');
  });

  it('给具体号码与具体动作（钱一转出去就报警，且先报警不是先找平台）', () => {
    expect(SAFETY_NOTICE_TEXT).toContain('110');
    expect(SAFETY_NOTICE_TEXT).toContain('96110');
    expect(SAFETY_NOTICE_TEXT).toContain('不要先来找我们');
    expect(SAFETY_NOTICE_TEXT).toContain('先离开现场');
    expect(SAFETY_NOTICE_TEXT).toContain('追不回');
  });

  it('明确说出冒充红线会做什么（要钱/验证码/私钥/恢复短语都是假的）', () => {
    expect(SAFETY_NOTICE_TEXT).toContain('24 词恢复短语');
    expect(SAFETY_NOTICE_TEXT).toContain('验证码');
    expect(SAFETY_NOTICE_TEXT).toContain('都是假的');
  });

  it('末尾留一条零隐私成本的退路（随时退出、删净本地）', () => {
    expect(SAFETY_NOTICE_TEXT).toContain('随时可以退出');
    expect(SAFETY_NOTICE_TEXT).toContain('删');
  });

  it('确认块含全文 + 勾选行 + 下一步指令，且是「不是报错」的中间态', () => {
    const block = safetyAckBlock();
    expect(block).toContain(SAFETY_NOTICE_TEXT);
    expect(block).toContain(`[ ] ${SAFETY_ACK_LABEL}`);
    expect(block).toContain('interview(action="ack")');
    expect(block).toContain('不是报错');
    expect(SAFETY_ACK_REQUIRED).toBe('ACK_REQUIRED');
  });

  it('确认行不做默认勾选（勾选框必须是空的）', () => {
    expect(safetyAckBlock()).toContain('[ ]');
    expect(safetyAckBlock()).not.toContain('[x]');
  });

  it('版本号决定要不要重看：不一致就得重看，没有「向后兼容」这回事', () => {
    expect(SAFETY_NOTICE_VERSION).toMatch(/^\d+\.\d+$/);
    expect(safetyAckSatisfied(SAFETY_NOTICE_VERSION)).toBe(true);
    expect(safetyAckSatisfied(null)).toBe(false);
    expect(safetyAckSatisfied(undefined)).toBe(false);
    expect(safetyAckSatisfied('0.9')).toBe(false);
  });
});
