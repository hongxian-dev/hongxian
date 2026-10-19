/**
 * 广场卡本地存储（月老 Skill 侧——哑管道的"存证"落地）
 *
 * 布局（~/.hongxian 下新增两个目录，与既有 cards/mine、cards/contacts 并列）：
 *   cards/plaza-mine/<card_id>.json          本方已贴广场的 plaza_card 变体（无 key_l1）
 *   cards/plaza/<hex(owner_key_id)>/<card_id>.json  浏览存证的他人广场卡
 *
 * 为什么必须落盘：
 *   ① grant_l1 只送钥匙不送密文——请求方解密 L1 需要自己浏览时存下的广场卡；
 *   ② 卡主应答 upgrade_request 时需要按指纹定位"被请求的是哪张广场卡"；
 *   ③ 撤卡/重贴需要指纹与 card_id 的本地记录。
 * 密码学边界：plaza_card 全程无 key_l1（§10.5）——本目录不存在可解密材料。
 */

import { cardFingerprint } from '@hongxian/core';
import type { MatchCardEnvelope } from '@hongxian/schema';
import { store } from './context.js';
import { dirNameFromKeyId } from './tools-profile.js';

export const PLAZA_MINE_DIR = 'cards/plaza-mine';
export const PLAZA_CACHE_DIR = 'cards/plaza';

type S = ReturnType<typeof store>;

function readCard(s: S, path: string): MatchCardEnvelope | null {
  return s.read<MatchCardEnvelope>(path);
}

/** 本方已贴广场卡列表（按 card_id） */
export function listOwnPlazaCards(s: S): MatchCardEnvelope[] {
  return s
    .list(PLAZA_MINE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readCard(s, `${PLAZA_MINE_DIR}/${f}`))
    .filter((c): c is MatchCardEnvelope => c !== null);
}

export function saveOwnPlazaCard(s: S, card: MatchCardEnvelope): void {
  s.write(`${PLAZA_MINE_DIR}/${card.meta.card_id}.json`, card);
}

export function saveCachedPlazaCard(s: S, card: MatchCardEnvelope): void {
  s.write(`${PLAZA_CACHE_DIR}/${dirNameFromKeyId(card.meta.owner_key_id)}/${card.meta.card_id}.json`, card);
}

export function findOwnPlazaCardById(s: S, cardId: string): MatchCardEnvelope | null {
  return readCard(s, `${PLAZA_MINE_DIR}/${cardId}.json`);
}

export function findOwnPlazaCardByFingerprint(s: S, fingerprint: string): MatchCardEnvelope | null {
  return listOwnPlazaCards(s).find((c) => cardFingerprint(c) === fingerprint) ?? null;
}

export function findCachedPlazaCardById(s: S, cardId: string): MatchCardEnvelope | null {
  for (const owner of s.list(PLAZA_CACHE_DIR)) {
    const c = readCard(s, `${PLAZA_CACHE_DIR}/${owner}/${cardId}.json`);
    if (c) return c;
  }
  return null;
}

/**
 * 联系人卡回退寻址（cards/contacts）——广场流中段（L1 已解锁导入为联系人、
 * 或对方已撤卡）仍可按 card_id 找到协商公钥续投。
 */
export function findContactCardById(s: S, cardId: string): MatchCardEnvelope | null {
  for (const owner of s.list('cards/contacts')) {
    const c = readCard(s, `cards/contacts/${owner}/${cardId}.json`);
    if (c) return c;
  }
  return null;
}

export function findCachedPlazaCardByFingerprint(s: S, fingerprint: string): MatchCardEnvelope | null {
  for (const owner of s.list(PLAZA_CACHE_DIR)) {
    for (const f of s.list(`${PLAZA_CACHE_DIR}/${owner}`).filter((x) => x.endsWith('.json'))) {
      const c = readCard(s, `${PLAZA_CACHE_DIR}/${owner}/${f}`);
      if (c && cardFingerprint(c) === fingerprint) return c;
    }
  }
  return null;
}

/** 已拉黑发件人的 opaque_id 集合（姻缘线拉黑——D15④，广场过滤同步生效） */
export function blockedOpaqueIds(s: S): string[] {
  const out: string[] = [];
  for (const dir of s.list('lines')) {
    const line = s.read<{ blocked?: boolean }>(`lines/${dir}/state.json`);
    // 目录名 = hex(owner_key_id)——还原为 base64 口径与广场卡 meta 对齐
    if (line?.blocked) out.push(Buffer.from(dir, 'hex').toString('base64'));
  }
  return out;
}
