/**
 * 红线密钥体系 · 第一层：BIP39 恢复短语（技术详设 §4）
 *
 * 恢复短语 = 24 个中文简体词 = 身份的唯一备份通道（D15③）。
 * 丢失不可恢复（设计如此）；密钥文件只是短语的加密容器——容器可复制，短语才是身份。
 */

import { generateMnemonic as scureGenerate, mnemonicToSeedSync, validateMnemonic as scureValidate } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/simplified-chinese';

/** 24 词 = 256 bit 熵（协议定稿口径） */
export const MNEMONIC_WORDS = 24;

/** 生成 24 词中文简体恢复短语 */
export function generateMnemonicZh(): string {
  return scureGenerate(wordlist, 256);
}

/** 校验中文恢复短语（词表 + 校验和） */
export function validateMnemonicZh(phrase: string): boolean {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (words.length !== MNEMONIC_WORDS) return false;
  try {
    return scureValidate(phrase.trim(), wordlist);
  } catch {
    return false;
  }
}

/** 归一化用户输入（全角空格/多余空白 → 单空格分隔） */
export function normalizeMnemonic(phrase: string): string {
  return phrase
    .replace(/\u3000/g, ' ')
    .trim()
    .split(/\s+/)
    .join(' ');
}

/** 短语 → 64 字节 BIP39 seed（Argon2id 的密码输入） */
export function mnemonicToSeed(phrase: string): Uint8Array {
  if (!validateMnemonicZh(phrase)) {
    throw new Error('恢复短语无效：必须是 24 个中文词且校验和正确');
  }
  return mnemonicToSeedSync(normalizeMnemonic(phrase), wordlist);
}
