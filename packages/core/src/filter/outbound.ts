/**
 * 出站过滤（D9 代访边界 / D15⑦ 泄露面审查）
 *
 * 出站消息逐条过授权过滤（D9）：
 *   - 超出主人预先授权的可谈范围 → 自动回"这条我得问问主人"
 *   - 涉及主人 dealbreakers 的敏感题 → 中性化措辞由月老代问（D9④/D15⑦），
 *     不得直述主人原话（"你介意异地吗"暴露主人在意异地）
 * 全程留痕主人可查、token 预算帽（D9）——预算帽在 mcp 层执行。
 */

/** 授权范围：主人预先圈定的可谈维度（字段白名单） */
export interface AuthorizationScope {
  /** 可谈的题库维度 */
  allowed_dimensions: string[];
  /** 可披露的画像字段（超出即须回问主人） */
  allowed_fields: string[];
  /** 是否允许代问敏感题（中性化） */
  allow_proxy_sensitive: boolean;
}

export type OutboundDecision =
  | { allowed: true }
  | { allowed: false; action: 'ask_master'; reason: string }
  | { allowed: true; neutralized: string; reason: string };

/**
 * 出站题目过滤：
 * 1. 维度在授权范围外 → ask_master（"这条我得问问主人"）
 * 2. 维度命中主人 dealbreaker 且允许代问 → 中性化（不暴露主人在意）
 * 3. 其余放行
 */
export function filterOutboundTopic(
  topic: string,
  dimension: string,
  scope: AuthorizationScope,
  myDealbreakerDimensions: string[],
): OutboundDecision {
  if (!scope.allowed_dimensions.includes(dimension)) {
    return {
      allowed: false,
      action: 'ask_master',
      reason: `维度"${dimension}"不在主人授权范围内——这条我得问问主人`,
    };
  }
  if (myDealbreakerDimensions.includes(dimension)) {
    if (scope.allow_proxy_sensitive) {
      return {
        allowed: true,
        neutralized: neutralizeTopic(dimension),
        reason: `涉及主人底线维度"${dimension}"——已转为中性化代问，不暴露主人原话（D15⑦）`,
      };
    }
    return {
      allowed: false,
      action: 'ask_master',
      reason: `涉及主人底线维度"${dimension}"且未开放代问——这条我得问问主人`,
    };
  }
  return { allowed: true };
}

/** 中性化题库（D9④：AI 问无社交代价——敏感题由题库代问） */
const NEUTRAL_TOPIC_MAP: Record<string, string> = {
  smoking: '你对吸烟怎么看？',
  drinking: '你对饮酒怎么看？',
  childbearing: '你对生育计划怎么看？',
  long_distance: '你怎么看异地相处？',
  pets: '你喜欢宠物吗？',
  debt: '你怎么看家庭财务规划？',
  religion: '你的家庭有什么信仰或传统吗？',
  other: '有什么事情对你来说是底线？',
};

export function neutralizeTopic(dimension: string): string {
  return NEUTRAL_TOPIC_MAP[dimension] ?? '你怎么看这件事？';
}

/**
 * 泄露面检测：题目文本是否直述主人原话中的 dealbreaker 关键词。
 * 用于出站前审查（D15⑦）——返回风险标记供 mcp 层提示月老改写。
 */
export function detectLeakRisk(topicText: string, myDealbreakerNotes: string[]): boolean {
  const lower = topicText.toLowerCase();
  return myDealbreakerNotes.some((note) => {
    const words = note
      .split(/[，。、\s]+/)
      .filter((w) => w.length >= 2);
    return words.some((w) => lower.includes(w.toLowerCase()));
  });
}

/** token 预算帽检查（D9：代访预算可预算化） */
export function withinTokenBudget(usedTokens: number, budgetCap: number): boolean {
  return usedTokens <= budgetCap;
}
