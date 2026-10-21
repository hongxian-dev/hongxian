/**
 * 画像视图装载（compare / meeting_kit / debrief 共用）
 *
 * 把"我本地的访谈状态"与"对方卡片里能解开的层"统一成 ProfileView，
 * 避免每个工具各写一份拍平逻辑（v1.0 的 flattenProfile 只在 compare 里，
 * 见面锦囊与复盘拿不到同一份视图，只能各自拼）。
 */

import { decryptLayer, type ProfileView } from '@hongxian/core';
import { fromBase64 } from '@hongxian/schema';
import type { FsStore } from './store-fs.js';
import { dirNameFromKeyId } from './tools-profile.js';

const LINES_DIR = 'lines';
const CARDS_CONTACTS_DIR = 'cards/contacts';

/** 访谈状态 → ProfileView（L1 + L2） */
export function flattenProfile(confirmed: Record<string, Record<string, unknown>>): ProfileView {
  const facts = confirmed.facts ?? {};
  const prefs = confirmed.preferences ?? {};
  const values = confirmed.values ?? {};
  return {
    l1: {
      nickname: facts.nickname,
      gender: facts.gender,
      seeking: facts.seeking,
      interests: facts.interests ?? [],
      age_band: facts.age_band,
      city: facts.city,
      marital_status: facts.marital_status,
      job_category: facts.job_category,
      bio: facts.bio,
      goal: facts.goal,
    },
    l2: {
      values_tags: prefs.values_tags ?? [],
      money_view: prefs.money_view,
      lifestyle: prefs.lifestyle ?? {},
      family_view: prefs.family_view ?? {},
      assets_brief: prefs.assets_brief ?? {},
      dealbreakers: prefs.dealbreakers ?? [],
      values_qa: values.values_qa ?? [],
      partner_pref: prefs.partner_pref,
    },
  };
}

/** 我的画像（未完成访谈时返回 null） */
export function loadMyProfile(s: FsStore): ProfileView | null {
  const state = s.read<{ confirmed?: Record<string, Record<string, unknown>> }>('profile/interview-state.json');
  if (!state?.confirmed?.values) return null;
  return flattenProfile(state.confirmed);
}

/** 找对方联系人卡 */
export function findContactCard(s: FsStore, cardId: string): Record<string, unknown> | null {
  for (const owner of s.list(CARDS_CONTACTS_DIR)) {
    const c = s.read<Record<string, unknown>>(`${CARDS_CONTACTS_DIR}/${owner}/${cardId}.json`);
    if (c) return c;
  }
  return null;
}

export interface TheirProfile {
  view: ProfileView;
  /** 已解锁的层 */
  unlocked: string[];
  /** 该线的层密钥 */
  layerKeys: Record<string, string>;
  /** 该线存储目录名（hex(owner_key_id)） */
  lineDir: string;
}

/**
 * 对方画像：L1 用卡自带 key_l1（或线层密钥），L2 只在 grant_l2 后可用。
 * 解不开的层留空——绝不猜测、绝不用残缺数据装成完整画像。
 */
export function loadTheirProfile(s: FsStore, cardId: string): TheirProfile | null {
  const card = findContactCard(s, cardId);
  if (!card) return null;
  const meta = card.meta as { owner_key_id: string };
  const lineDir = dirNameFromKeyId(meta.owner_key_id);
  const layerKeys = s.read<Record<string, string>>(`${LINES_DIR}/${lineDir}/layer-keys.json`) ?? {};
  const unlocked: string[] = [];

  const l1KeyB64 = (card.key_l1 as string | undefined) ?? layerKeys.key_l1;
  let l1: Record<string, unknown> = {};
  if (l1KeyB64) {
    const opened = decryptLayer(card as never, 'L1', fromBase64(l1KeyB64));
    if (opened.ok) {
      l1 = opened.payload as Record<string, unknown>;
      unlocked.push('L1');
    }
  }
  let l2: Record<string, unknown> = {};
  if (layerKeys.key_l2) {
    const opened = decryptLayer(card as never, 'L2', fromBase64(layerKeys.key_l2));
    if (opened.ok) {
      l2 = opened.payload as Record<string, unknown>;
      unlocked.push('L2');
    }
  }
  const grantedFields = Object.keys(layerKeys)
    .filter((k) => k.startsWith('l3_') && k !== 'l3_container')
    .map((k) => k.slice(3));
  if (grantedFields.length) unlocked.push('L3');

  return { view: { l1, l2 }, unlocked, layerKeys, lineDir };
}
