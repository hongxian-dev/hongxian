/**
 * D9 代访 token 预算帽（mcp 侧落地）
 *
 * 要证明：默认有帽、未超放行、超帽拒绝且给出"提额/收窄"两条路、
 * 记账只累加（预算不是可退余额）、cap=0 表示主人明确不设帽。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLine } from '@hongxian/core';
import { Session, DEFAULT_TOKEN_BUDGET_CAP } from '../src/session.js';
import { store } from '../src/context.js';
import { guardTopicBudget } from '../src/tools-exchange.js';
import { dirNameFromKeyId } from '../src/tools-profile.js';

let home: string;
let session: Session;
const prevHome = process.env.HONGXIAN_HOME;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'hx-budget-'));
  process.env.HONGXIAN_HOME = home;
  session = new Session();
  await session.initIdentity();
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HONGXIAN_HOME;
  else process.env.HONGXIAN_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

/** 造一条姻缘线（对方地址用本方 opaque_id 占位即可——只关心目录隔离） */
function seedLine(tokensUsed?: number): string {
  const s = store();
  const peer = session.keyIdB64;
  const dir = dirNameFromKeyId(peer);
  const line = { ...createLine('line-x', dir, 'in_rounds'), ...(tokensUsed === undefined ? {} : { tokens_used: tokensUsed }) };
  s.write(`lines/${dir}/state.json`, line);
  return peer;
}

const topicBody = (topic: string, followups: string[] = []) => ({
  topic,
  followups,
  reason: '想了解你的家庭观',
  dimension: 'family',
});

describe('D9 · 代访 token 预算帽', () => {
  it('默认有帽（8000/线）——不是"默认裸奔"', () => {
    expect(session.settings().token_budget_cap).toBe(DEFAULT_TOKEN_BUDGET_CAP);
    expect(DEFAULT_TOKEN_BUDGET_CAP).toBeGreaterThan(0);
  });

  it('未超帽：放行并返回本次估算 token', () => {
    const peer = seedLine(0);
    const r = guardTopicBudget(topicBody('你怎么看婚后和父母同住？'), session, store(), peer);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tokens).toBeGreaterThan(0);
  });

  it('超帽：拒绝发送，并给出提额 / 收窄两条路（不静默截断）', () => {
    const peer = seedLine(DEFAULT_TOKEN_BUDGET_CAP - 1);
    const r = guardTopicBudget(topicBody('这一轮的问题比较长，会把预算撑爆吗？'), session, store(), peer);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.text).toContain('提额');
      expect(r.text).toContain('收窄');
      expect(r.text).toContain(String(DEFAULT_TOKEN_BUDGET_CAP));
    }
  });

  it('预算按线隔离：另一条线不受影响', () => {
    const s = store();
    const peerNew = 'Zm9yZWlnbi1wZWVyLW9wYXF1ZS1pZC0wMDAwMDA=';
    const dir = dirNameFromKeyId(peerNew);
    s.write(`lines/${dir}/state.json`, { ...createLine('line-y', dir, 'in_rounds'), tokens_used: 0 });
    const r = guardTopicBudget(topicBody('换个话题'), session, s, peerNew);
    expect(r.ok).toBe(true);
  });

  it('cap=0 = 主人明确不设帽（此时任何长度都放行）', () => {
    const peer = seedLine(999_999);
    session.updateSettings({ token_budget_cap: 0 });
    const r = guardTopicBudget(topicBody('随便问'), session, store(), peer);
    expect(r.ok).toBe(true);
    session.updateSettings({ token_budget_cap: DEFAULT_TOKEN_BUDGET_CAP });
  });
});
