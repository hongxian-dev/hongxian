/**
 * 画像模块（D1：渐进式建画像）
 *
 * 三次渐进访谈（每次 15–20 分钟，可跨天）：① 硬事实 ② 偏好与生活方式 ③ 价值观故事。
 * 复述确认门闩：每次会话结束月老总结"我理解的你是……"，用户确认后才写入——
 * 防 AI 幻觉写歪画像（信任的关键时刻）。
 * dealbreaker 负面清单优先于偏好收集（排除项的预测力远高于偏好项）。
 */

import { DEALBREAKER_DIMENSIONS, INTERESTS, VALUES_TAGS } from '@hongxian/schema';

export type InterviewStage = 'facts' | 'preferences' | 'values';

export const STAGE_ORDER: readonly InterviewStage[] = ['facts', 'preferences', 'values'];

export const STAGE_LABEL: Record<InterviewStage, string> = {
  facts: '硬事实',
  preferences: '偏好与生活方式',
  values: '价值观故事',
};

/** 一次访谈会话的结构化答案（由宿主 LLM 按 interview_flow 产出，core 校验） */
export interface StageAnswers {
  // facts 阶段
  nickname?: string;
  gender?: 'female' | 'male';
  seeking?: 'female' | 'male';
  age_band?: string;
  city?: { code: string; name: string };
  height_band?: string;
  marital_status?: string;
  job_category?: string;
  education_band?: string;
  interests?: string[];
  bio?: string;
  goal?: 'serious_dating' | 'marriage_oriented';
  // preferences 阶段
  values_tags?: { tag: string; weight: number }[];
  lifestyle?: Record<string, string>;
  family_view?: Record<string, string>;
  money_view?: string;
  assets_brief?: Record<string, string>;
  dealbreakers?: { dimension: string; note: string }[];
  partner_pref?: string;
  // values 阶段
  values_qa?: { question: string; answer: string }[];
}

/** 访谈状态（持久化于 profile/interviews.jsonl + profile.json） */
export interface InterviewState {
  stage: InterviewStage;
  /** 已完成并确认的阶段 */
  confirmed_stages: InterviewStage[];
  /** 待复述确认的会话草稿（确认前不算数） */
  pending_recap: { stage: InterviewStage; answers: StageAnswers; recap: string } | null;
  /** 已确认的答案（按阶段） */
  confirmed: Partial<Record<InterviewStage, StageAnswers>>;
}

export function createInterviewState(): InterviewState {
  return { stage: 'facts', confirmed_stages: [], pending_recap: null, confirmed: {} };
}

/** 提交一次会话答案 → 生成复述确认稿（门闩：未确认不写入 confirmed） */
export function submitStageAnswers(
  state: InterviewState,
  stage: InterviewStage,
  answers: StageAnswers,
  recapText: string,
): InterviewState {
  return { ...state, pending_recap: { stage, answers, recap: recapText } };
}

/** 用户确认复述 → 写入 confirmed，推进到下一阶段 */
export function confirmRecap(state: InterviewState): InterviewState {
  if (!state.pending_recap) {
    throw new Error('没有待确认的复述稿');
  }
  const { stage, answers } = state.pending_recap;
  const confirmed = { ...state.confirmed, [stage]: { ...state.confirmed[stage], ...answers } };
  const confirmed_stages = state.confirmed_stages.includes(stage)
    ? state.confirmed_stages
    : [...state.confirmed_stages, stage];
  const idx = STAGE_ORDER.indexOf(stage);
  const nextStage = idx >= 0 && idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1]! : stage;
  return { stage: nextStage, confirmed_stages, pending_recap: null, confirmed };
}

/** 用户否决复述 → 丢弃本次答案，留在本阶段重聊 */
export function rejectRecap(state: InterviewState): InterviewState {
  return { ...state, pending_recap: null };
}

// ---------- 画像组装与校验 ----------

/** 从已确认答案组装 L1/L2 payload 草稿（供 sign_card 消费） */
export function assembleProfile(state: InterviewState): {
  l1: Record<string, unknown>;
  l2: Record<string, unknown>;
} {
  const facts = state.confirmed.facts ?? {};
  const prefs = state.confirmed.preferences ?? {};
  const values = state.confirmed.values ?? {};
  return {
    l1: {
      nickname: facts.nickname,
      gender: facts.gender,
      seeking: facts.seeking,
      age_band: facts.age_band,
      city: facts.city,
      height_band: facts.height_band,
      marital_status: facts.marital_status,
      job_category: facts.job_category,
      education_band: facts.education_band,
      interests: facts.interests ?? [],
      bio: facts.bio ?? '',
      goal: facts.goal,
    },
    l2: {
      values_tags: prefs.values_tags ?? [],
      lifestyle: prefs.lifestyle ?? {},
      family_view: prefs.family_view ?? {},
      money_view: prefs.money_view,
      assets_brief: prefs.assets_brief ?? {},
      dealbreakers: prefs.dealbreakers ?? [],
      values_qa: values.values_qa ?? [],
      partner_pref: prefs.partner_pref ?? '',
    },
  };
}

/** 校验 dealbreakers：≤5 条、维度受控、描述 ≤50 字 */
export function validateDealbreakers(
  list: { dimension: string; note: string }[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (list.length > 5) errors.push(`dealbreakers 最多 5 条（当前 ${list.length}）`);
  for (const [i, d] of list.entries()) {
    if (!(DEALBREAKER_DIMENSIONS as readonly string[]).includes(d.dimension)) {
      errors.push(`第 ${i + 1} 条维度"${d.dimension}"不在受控词表`);
    }
    if (d.note.length > 50) errors.push(`第 ${i + 1} 条描述超 50 字`);
  }
  return { valid: errors.length === 0, errors };
}

/** 校验受控词表字段（兴趣 ≤5、价值观标签 ≤8、问答 3–5 段） */
export function validateVocabFields(profile: {
  interests?: string[];
  values_tags?: { tag: string }[];
  values_qa?: unknown[];
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (profile.interests && profile.interests.length > 5) errors.push('兴趣标签最多 5 个');
  for (const t of profile.interests ?? []) {
    if (!(INTERESTS as readonly string[]).includes(t)) errors.push(`兴趣"${t}"不在受控词表`);
  }
  if (profile.values_tags && profile.values_tags.length > 8) errors.push('价值观标签最多 8 个');
  for (const t of profile.values_tags ?? []) {
    if (!(VALUES_TAGS as readonly string[]).includes(t.tag)) errors.push(`价值观"${t.tag}"不在受控词表`);
  }
  const qa = profile.values_qa?.length ?? 0;
  if (qa > 0 && (qa < 3 || qa > 5)) errors.push('价值观问答须为 3–5 段');
  return { valid: errors.length === 0, errors };
}

// ---------- 画像深度（D7：卡片强制带深度标记，供对方标注置信度） ----------

/** L1/L2 必填字段清单（completeness 计算基准） */
const L1_REQUIRED = [
  'nickname',
  'gender',
  'seeking',
  'age_band',
  'city',
  'height_band',
  'marital_status',
  'job_category',
  'education_band',
  'bio',
  'goal',
] as const;
const L2_REQUIRED = [
  'values_tags',
  'lifestyle',
  'family_view',
  'money_view',
  'assets_brief',
  'dealbreakers',
  'values_qa',
  'partner_pref',
] as const;

/** completeness = 已填必填字段 / 总必填字段（0–1，Schema meta.depth.completeness） */
export function computeCompleteness(profile: { l1: Record<string, unknown>; l2: Record<string, unknown> }): number {
  const filled = (obj: Record<string, unknown>, keys: readonly string[]) =>
    keys.filter((k) => {
      const v = obj[k];
      if (v === undefined || v === null || v === '') return false;
      if (Array.isArray(v) && v.length === 0) return false;
      if (typeof v === 'object' && Object.keys(v as object).length === 0) return false;
      return true;
    }).length;
  const total = L1_REQUIRED.length + L2_REQUIRED.length;
  return Math.round(((filled(profile.l1, L1_REQUIRED) + filled(profile.l2, L2_REQUIRED)) / total) * 100) / 100;
}

/** 画像深度标记（meta.depth） */
export function buildDepth(
  interviewRounds: number,
  completeness: number,
  modelTier: 'local' | 'cloud',
): { interview_rounds: number; completeness: number; model_tier: 'local' | 'cloud' } {
  return {
    interview_rounds: interviewRounds,
    completeness: Math.max(0, Math.min(1, completeness)),
    model_tier: modelTier,
  };
}

/** 复述确认稿生成（月老口吻的"我理解的你是……"——措辞由 prompt 指引，core 只组装事实） */
export function buildRecap(stage: InterviewStage, answers: StageAnswers): string {
  const parts: string[] = [];
  if (stage === 'facts') {
    parts.push(`昵称"${answers.nickname ?? '（未答）'}"，${answers.age_band ?? '?'} 岁段，${answers.city?.name ?? '?'}`);
    if (answers.marital_status) parts.push(`婚况：${answers.marital_status}`);
    if (answers.goal) parts.push(`目标：${answers.goal}`);
  } else if (stage === 'preferences') {
    if (answers.money_view) parts.push(`消费观：${answers.money_view}`);
    const dbs = answers.dealbreakers ?? [];
    if (dbs.length) parts.push(`底线 ${dbs.length} 条：${dbs.map((d) => d.dimension).join('、')}`);
  } else if (stage === 'values') {
    const qa = answers.values_qa ?? [];
    if (qa.length) parts.push(`价值观问答 ${qa.length} 段`);
  }
  return `我理解的你是——${parts.join('；')}。理解对吗？确认后我才写进画像。`;
}
