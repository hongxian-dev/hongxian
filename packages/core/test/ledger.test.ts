import { describe, expect, it } from 'vitest';
import {
  MAX_UNRESPONDED_UPGRADES,
  blockLine,
  createLine,
  enterRounds,
  graduate,
  ledgerView,
  markNoFollowUp,
  noteResponseReceived,
  noteUpgradeSent,
  shouldPresentEnvelope,
  shouldSuggestBlock,
  unblockLine,
} from '../src/ledger/lines.js';

describe('红线手账 · 姻缘线（D3②/D4/D15）', () => {
  it('生命周期：收卡 → 深聊 → 毕业', () => {
    let l = createLine('card-1', 'keyid-1', 'card_received');
    expect(l.status).toBe('card_received');
    l = enterRounds(l);
    expect(l.status).toBe('in_rounds');
    expect(l.rounds_total).toBe(1);
    l = graduate(l);
    expect(l.status).toBe('graduated');
  });

  it('防骚扰拉黑：3 次未回应 → 建议拉黑；拉黑后信封不再呈报（D15④）', () => {
    expect(MAX_UNRESPONDED_UPGRADES).toBe(3);
    let l = createLine('card-1', 'keyid-1');
    l = noteUpgradeSent(l);
    expect(shouldSuggestBlock(l)).toBe(false);
    l = noteUpgradeSent(l);
    l = noteUpgradeSent(l);
    expect(l.unresponded_upgrades).toBe(3);
    expect(shouldSuggestBlock(l)).toBe(true);
    l = blockLine(l);
    expect(l.blocked).toBe(true);
    expect(shouldPresentEnvelope(l)).toBe(false); // 静默到底
  });

  it('收到回音清零未回应计数', () => {
    let l = createLine('c', 'k');
    l = noteUpgradeSent(l);
    l = noteUpgradeSent(l);
    l = noteResponseReceived(l);
    expect(l.unresponded_upgrades).toBe(0);
    expect(shouldSuggestBlock(l)).toBe(false);
  });

  it('本地认知"未通过"：仅本地，不通知对方（D4）', () => {
    let l = createLine('c', 'k');
    l = markNoFollowUp(l);
    expect(l.status).toBe('no_follow_up');
    // 状态只存本地——没有"对方已读"这类假装知道的状态
    const view = ledgerView([l]);
    expect(view.by_status.no_follow_up).toBe(1);
  });

  it('手账视图：状态分布 + 拉黑建议清单（多线并行 D15⑥）', () => {
    const a = noteUpgradeSent(noteUpgradeSent(noteUpgradeSent(createLine('a', 'ka'))));
    const b = enterRounds(createLine('b', 'kb'));
    const view = ledgerView([a, b]);
    expect(view.total).toBe(2);
    expect(view.block_suggestions).toEqual([{ line_id: 'a', unresponded: 3 }]);
  });

  it('解除拉黑', () => {
    let l = blockLine(createLine('c', 'k'));
    expect(shouldPresentEnvelope(l)).toBe(false);
    l = unblockLine(l);
    expect(l.blocked).toBe(false);
    expect(shouldPresentEnvelope(l)).toBe(true);
  });
});
