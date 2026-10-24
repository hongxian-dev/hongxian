/**
 * 发布许可契约测试（协议 v1.3）
 *
 * 这批断言对应《实名制处理口径决策备忘》§4.1 的四条硬约束里，
 * 能在这里守得住的两条：
 * - 「不存明文」的前提是标准化**确定性**：同一个邮箱永远得到同一个载体值，
 *   否则同一邮箱能绑多个身份，防女巫失效；
 * - 「防刷」的前提是**不展开别名**：`a+x@` 与 `a@` 必须被视为两个载体，
 *   不接受别名就是让"一个 Gmail 绑无限身份"这条走不通。
 */

import { describe, expect, it } from 'vitest';
import {
  PUBLISH_PERMIT_LENGTH,
  PERMIT_ALPHABET,
  describeCarrierReject,
  isNonceShaped,
  isPermitShaped,
  normalizeCarrier,
  normalizePermit,
  permitFromBytes,
} from '../src/index.js';

describe('载体标准化（邮箱）', () => {
  it('转小写 + 去首尾空格', () => {
    const r = normalizeCarrier('  Alice.Wang@Gmail.COM  ');
    expect(r).toEqual({ ok: true, carrier: 'alice.wang@gmail.com' });
  });

  it('同一个邮箱的不同写法得到同一个载体值（哈希可去重的前提）', () => {
    const a = normalizeCarrier('Alice@Gmail.com');
    const b = normalizeCarrier(' alice@gmail.COM ');
    expect(a.ok && b.ok && a.carrier === b.carrier).toBe(true);
  });

  it('不展开 + 别名（否则一个 Gmail 能绑无限身份）', () => {
    const plain = normalizeCarrier('a@gmail.com');
    const alias = normalizeCarrier('a+plaza@gmail.com');
    expect(plain.ok && alias.ok).toBe(true);
    if (plain.ok && alias.ok) expect(plain.carrier).not.toBe(alias.carrier);
  });

  it('不做 Gmail 点号归一（同理）', () => {
    const withDots = normalizeCarrier('a.b@gmail.com');
    const without = normalizeCarrier('ab@gmail.com');
    expect(withDots.ok && without.ok).toBe(true);
    if (withDots.ok && without.ok) expect(withDots.carrier).not.toBe(without.carrier);
  });

  it('拒绝空值 / 缺域名 / 多 @ / 无点域名', () => {
    expect(normalizeCarrier('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeCarrier('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeCarrier('alice')).toEqual({ ok: false, reason: 'malformed' });
    expect(normalizeCarrier('alice@')).toEqual({ ok: false, reason: 'malformed' });
    expect(normalizeCarrier('@gmail.com')).toEqual({ ok: false, reason: 'malformed' });
    expect(normalizeCarrier('a@b@c.com')).toEqual({ ok: false, reason: 'malformed' });
    expect(normalizeCarrier('alice@gmail')).toEqual({ ok: false, reason: 'malformed' });
    expect(normalizeCarrier('alice@gmail..com')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('拒绝超长（254 上限）与本地段超 64', () => {
    const longLocal = `${'a'.repeat(65)}@gmail.com`;
    expect(normalizeCarrier(longLocal)).toEqual({ ok: false, reason: 'malformed' });
    const longDomain = `a@${'b'.repeat(250)}.com`;
    expect(normalizeCarrier(longDomain)).toEqual({ ok: false, reason: 'too_long' });
  });

  it('拒绝一次性邮箱，且给出可读理由', () => {
    const r = normalizeCarrier('someone@mailinator.com');
    expect(r).toEqual({ ok: false, reason: 'disposable' });
    expect(describeCarrierReject('disposable')).toContain('一次性邮箱');
    // 拒绝原因是客户端直接展示的文案——四种都必须是一句完整的话
    for (const reason of ['empty', 'too_long', 'malformed', 'disposable'] as const) {
      const msg = describeCarrierReject(reason);
      expect(msg.length).toBeGreaterThanOrEqual(8);
      expect(msg.endsWith('。')).toBe(true);
    }
  });

  it('接受常见真实邮箱（含 + 号与多级域）', () => {
    for (const ok of [
      'zhang.san+plaza@qq.com',
      'user_name@163.com',
      'a@sub.example.co.uk',
      'x@outlook.com',
    ]) {
      expect(normalizeCarrier(ok).ok, ok).toBe(true);
    }
  });
});

describe('发布许可码', () => {
  it('固定 8 位且只来自去混淆字母表', () => {
    const bytes = new Uint8Array(32).fill(200);
    const permit = permitFromBytes(bytes);
    expect(permit).toHaveLength(PUBLISH_PERMIT_LENGTH);
    for (const ch of permit) expect(PERMIT_ALPHABET.includes(ch)).toBe(true);
    // 字母表本身不得含易混字符
    for (const bad of ['I', 'L', 'O', '0', '1']) expect(PERMIT_ALPHABET.includes(bad)).toBe(false);
  });

  it('不同字节源产出不同许可码（不退化）', () => {
    const a = permitFromBytes(new Uint8Array(16).fill(1));
    const b = permitFromBytes(new Uint8Array(16).fill(2));
    expect(a).not.toBe(b);
  });

  it('回填时容错空格与连字符、容忍小写', () => {
    const permit = permitFromBytes(new Uint8Array(16).map((_, i) => i * 11));
    const retyped = `${permit.slice(0, 4).toLowerCase()}-${permit.slice(4)}`;
    expect(normalizePermit(retyped)).toBe(permit);
    expect(isPermitShaped(retyped)).toBe(true);
  });

  it('形状校验拒绝长度错误与字母表外的字符', () => {
    expect(isPermitShaped('ABC')).toBe(false);
    expect(isPermitShaped('ABCDEFG0')).toBe(false); // 含 0
    expect(isPermitShaped('ABCDEFG')).toBe(false);
  });
});

describe('nonce 形状', () => {
  it('接受 16–32 字节 base64url', () => {
    expect(isNonceShaped('A'.repeat(22))).toBe(true);
    expect(isNonceShaped('aB3-_' + 'x'.repeat(17))).toBe(true);
  });

  it('拒绝过短/过长/含非法字符', () => {
    expect(isNonceShaped('short')).toBe(false);
    expect(isNonceShaped('A'.repeat(44))).toBe(false);
    expect(isNonceShaped('A'.repeat(21) + '+')).toBe(false); // + 不是 base64url
  });
});
