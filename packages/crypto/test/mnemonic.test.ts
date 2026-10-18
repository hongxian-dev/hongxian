import { describe, expect, it } from 'vitest';
import {
  generateMnemonicZh,
  mnemonicToSeed,
  normalizeMnemonic,
  validateMnemonicZh,
  MNEMONIC_WORDS,
} from '../src/mnemonic.js';

describe('BIP39 中文恢复短语', () => {
  it('生成 24 词中文短语', () => {
    const phrase = generateMnemonicZh();
    const words = phrase.split(' ');
    expect(words).toHaveLength(MNEMONIC_WORDS);
    expect(validateMnemonicZh(phrase)).toBe(true);
  });

  it('校验：错误词数 / 篡改校验和 / 英文词拒绝', () => {
    const phrase = generateMnemonicZh();
    expect(validateMnemonicZh(phrase.split(' ').slice(0, 23).join(' '))).toBe(false);
    const words = phrase.split(' ');
    words[3] = words[3] === '的' ? '地' : '的';
    expect(validateMnemonicZh(words.join(' '))).toBe(false);
    expect(
      validateMnemonicZh(
        'legal winner thank year wave sausage worth useful legal winner thank yellow',
      ),
    ).toBe(false);
  });

  it('seed 确定性：同短语同 seed，不同短语不同 seed', () => {
    const a = generateMnemonicZh();
    const b = generateMnemonicZh();
    const seedA1 = mnemonicToSeed(a);
    const seedA2 = mnemonicToSeed(a);
    expect(Buffer.from(seedA1).equals(Buffer.from(seedA2))).toBe(true);
    expect(Buffer.from(seedA1).equals(Buffer.from(mnemonicToSeed(b)))).toBe(false);
    expect(seedA1).toHaveLength(64);
  });

  it('归一化：全角空格与多余空白', () => {
    const phrase = generateMnemonicZh();
    const messy = '　' + phrase.split(' ').join('   ') + '  ';
    expect(normalizeMnemonic(messy)).toBe(phrase);
  });
});
