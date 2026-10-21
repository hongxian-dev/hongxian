/**
 * 粗筛与报告输入组装（D6/D7）
 *
 * 粗筛 = 纯结构化规则，零 token（D7 省 token 模式）：LLM 只做报告叙事。
 * 档位计算落实 D6 三条兜底：
 *   ① 硬伤命中 → 档位封顶并说明
 *   ② 信息不足 → 降档 + 置信提示
 *   ③ 每个结论必须有双方画像原话依据（由 narrative_input 承载，叙事交宿主 LLM）
 */

import {
  COMPLETENESS_LOW_THRESHOLD,
  type CompareResult,
  type ReportNarrative,
} from '@hongxian/schema';

/** 可比对的画像视图（L1 明文 + L2 明文；L3 不参与初筛） */
export interface ProfileView {
  l1: Record<string, any>;
  l2: Record<string, any>;
}

export interface ScreenResult {
  passed: boolean;
  reasons: string[];
  dealbreaker_hits: { dimension: string; mine: string; theirs: string }[];
  /** 双向匹配方向是否成立（seeking × gender） */
  direction_ok: boolean;
}

/**
 * 粗筛：硬性不相容 + dealbreaker 直接冲突。
 * 不做任何"评分"——粗筛只回答"是否值得进入报告"。
 */
export function screenCompatibility(mine: ProfileView, theirs: ProfileView): ScreenResult {
  const reasons: string[] = [];
  const hits: ScreenResult['dealbreaker_hits'] = [];

  // 1. 匹配方向（v0.3：gender × seeking 双向成立）
  const directionOk =
    mine.l1.seeking === theirs.l1.gender && theirs.l1.seeking === mine.l1.gender;
  if (!directionOk) {
    reasons.push('匹配方向不一致（双方寻求的性别不互为对方）');
  }

  // 2. dealbreakers 与生活方式的结构性冲突（负面清单优先于偏好——D1"错配克星"）
  //    语义：命中 = 一方的底线撞上另一方**实际的生活方式/意向**；
  //    双方都把同一维度当底线 = 共识，不算硬伤（甚至互相认可）。
  const myBreakers = (mine.l2.dealbreakers ?? []) as { dimension: string; note: string }[];
  const theirBreakers = (theirs.l2.dealbreakers ?? []) as { dimension: string; note: string }[];
  const noteOf = (d: string, level: string) =>
    `生活方式：${level === 'regularly' ? '经常' : level}${d === 'smoking' ? '吸烟' : d === 'drinking' ? '饮酒' : d}`;

  /** 结构化维度冲突判定：只比有受控词表的维度，其余交给报告叙事（不猜） */
  const structuredConflict = (
    dimension: string,
    mineView: Record<string, any>,
    theirsView: Record<string, any>,
    mineBreakers: readonly { dimension: string }[],
  ): boolean => {
    if (dimension === 'childbearing') {
      // 一方明确「不想要」，另一方明确「想要」——这是硬冲突，不是可聊差异
      const a = mineView.l2?.family_view?.childbearing;
      const b = theirsView.l2?.family_view?.childbearing;
      return (a === 'dont_want' && (b === 'want' || b === 'want_more')) ||
        (b === 'dont_want' && (a === 'want' || a === 'want_more')) ||
        false;
    }
    if (dimension === 'smoking' || dimension === 'drinking') {
      // 底线方自己不沾，对方经常来——单向忍不了的现实冲突
      const myLevel = mineView.l2?.lifestyle?.[dimension];
      const theirLevel = theirsView.l2?.lifestyle?.[dimension];
      const mineHasBreaker = mineBreakers.some((b) => b.dimension === dimension);
      if (mineHasBreaker) return theirLevel === 'regularly' && myLevel !== 'regularly';
      return myLevel === 'regularly' && theirLevel !== 'regularly';
    }
    return false;
  };

  for (const mb of myBreakers) {
    const theirHabit = theirs.l2.lifestyle?.[mb.dimension];
    const conflict = structuredConflict(mb.dimension, mine, theirs, myBreakers);
    if (theirHabit === 'regularly' || conflict) {
      hits.push({
        dimension: mb.dimension,
        mine: mb.note,
        theirs:
          typeof theirHabit === 'string'
            ? noteOf(mb.dimension, theirHabit)
            : `对方的${mb.dimension === 'childbearing' ? '生育意愿' : mb.dimension}与你的底线不一致`,
      });
    }
  }
  for (const tb of theirBreakers) {
    const myHabit = mine.l2.lifestyle?.[tb.dimension];
    const conflict = structuredConflict(tb.dimension, theirs, mine, theirBreakers);
    if ((myHabit === 'regularly' || conflict) && !hits.some((h) => h.dimension === tb.dimension)) {
      hits.push({
        dimension: tb.dimension,
        mine:
          typeof myHabit === 'string'
            ? noteOf(tb.dimension, myHabit)
            : `你的${tb.dimension === 'childbearing' ? '生育意愿' : tb.dimension}与对方的底线不一致`,
        theirs: tb.note,
      });
    }
  }

  if (hits.length > 0) {
    reasons.push(`命中 ${hits.length} 项硬伤（${hits.map((h) => h.dimension).join('、')}）`);
  }

  return {
    passed: directionOk && hits.length === 0,
    reasons,
    dealbreaker_hits: hits,
    direction_ok: directionOk,
  };
}

/** 共鸣点计算（可聊差异的素材：结构化字段重叠，供叙事引用） */
export function findResonance(mine: ProfileView, theirs: ProfileView): ReportNarrative['resonance'] {
  const out: ReportNarrative['resonance'] = [];
  const myInterests = new Set((mine.l1.interests ?? []) as string[]);
  const theirInterests = new Set((theirs.l1.interests ?? []) as string[]);
  const shared = [...myInterests].filter((i) => theirInterests.has(i));
  if (shared.length > 0) {
    out.push({
      point: `共同兴趣：${shared.join('、')}`,
      mine_quote: `我的兴趣：${[...myInterests].join('、')}`,
      theirs_quote: `对方的兴趣：${[...theirInterests].join('、')}`,
    });
  }
  // 价值观标签重叠（引用双方价值观问答的原话——D6 要求"每个结论有原话依据"，
  // 只有标签名称不算原话，故附上各自最接近的一段回答作为引文）
  const myValues = new Map((mine.l2.values_tags ?? []).map((t: any) => [t.tag, t.weight]));
  const theirValues = (theirs.l2.values_tags ?? []) as { tag: string; weight: number }[];
  const sharedValues = theirValues.filter((t) => myValues.has(t.tag));
  if (sharedValues.length > 0) {
    out.push({
      point: `价值观共鸣：${sharedValues.map((t) => t.tag).join('、')}`,
      mine_quote: firstQuote(mine, sharedValues[0]!.tag) ?? `我的价值观权重：${sharedValues.map((t) => `${t.tag}×${myValues.get(t.tag)}`).join('、')}`,
      theirs_quote: firstQuote(theirs, sharedValues[0]!.tag) ?? `对方的价值观权重：${sharedValues.map((t) => `${t.tag}×${t.weight}`).join('、')}`,
    });
  }
  // 目标一致（都以婚姻为导向 / 都只是认真交往）——推进节奏的共识，避免"一方想快一方想慢"的错配
  if (mine.l1.goal && theirs.l1.goal && mine.l1.goal === theirs.l1.goal) {
    out.push({
      point: `目标一致：${mine.l1.goal === 'marriage_oriented' ? '都以婚姻为导向' : '都在认真交往阶段'}`,
      mine_quote: `我的目标：${mine.l1.goal}`,
      theirs_quote: `对方的目标：${theirs.l1.goal}`,
    });
  }
  // 同城（城市级，不收精确位置）——见面的现实可行性
  const myCity = mine.l1.city as { name?: string } | undefined;
  const theirCity = theirs.l1.city as { name?: string } | undefined;
  if (myCity?.name && theirCity?.name && myCity.name === theirCity.name) {
    out.push({
      point: `同在${myCity.name}`,
      mine_quote: `我的城市：${myCity.name}`,
      theirs_quote: `对方的城市：${theirCity.name}`,
    });
  }
  return out;
}

/** 取与该价值观标签最相关的一段问答原话（简单包含匹配，不做语义推断） */
function firstQuote(view: ProfileView, tag: string): string | null {
  const qa = (view.l2.values_qa ?? []) as { question: string; answer: string }[];
  const hit = qa.find((x) => `${x.question}${x.answer}`.includes(tag));
  return hit ? `「${hit.answer}」` : null;
}

/** 可聊差异 = 破冰话题建议（D6 三区之二） */
export function findTalkableDifferences(
  mine: ProfileView,
  theirs: ProfileView,
): ReportNarrative['talkable_differences'] {
  const dims: { label: string; get: (p: ProfileView) => string | undefined }[] = [
    { label: '消费观', get: (p) => p.l2.money_view },
    { label: '作息', get: (p) => p.l2.lifestyle?.sleep },
    { label: '生育计划', get: (p) => p.l2.family_view?.childbearing },
  ];
  const out: ReportNarrative['talkable_differences'] = [];
  for (const d of dims) {
    const myVal = d.get(mine);
    const theirVal = d.get(theirs);
    if (
      myVal &&
      theirVal &&
      myVal !== theirVal &&
      myVal !== 'unspecified' &&
      theirVal !== 'unspecified'
    ) {
      out.push({
        dimension: d.label,
        suggestion: `双方${d.label}不同（${myVal} ↔ ${theirVal}），可作为破冰话题了解彼此考量`,
      });
    }
  }
  return out;
}

/** 档位计算（D6 五档 + 三条兜底） */
export function computeTier(
  screen: ScreenResult,
  resonanceCount: number,
  talkableCount: number,
  completenessMine: number,
  completenessTheirs: number,
): { tier: CompareResult['tier']; capped: boolean; lowConfidence: boolean } {
  // 兜底②：信息不足 → 降档 + 置信提示（双方任一深度不足即降档）
  const lowConfidence =
    completenessMine < COMPLETENESS_LOW_THRESHOLD || completenessTheirs < COMPLETENESS_LOW_THRESHOLD;

  let tier: CompareResult['tier'];
  if (!screen.direction_ok) {
    // 匹配方向不一致：缘分未至（不进报告叙事）
    tier = 'not_yet';
  } else if (screen.dealbreaker_hits.length > 0) {
    // 兜底①：硬伤命中 → 档位封顶"可以聊聊"并说明（不是未至——人值得认识，是条件不合）
    tier = 'can_chat';
  } else {
    // 基础档位：共鸣与可聊差异的结构化计数（叙事深度由 LLM 补充）。
    // 权重刻意保守：破冰话题（差异）只算 1，共鸣算 2——差异是话题，不是加分项。
    const score = resonanceCount * 2 + talkableCount;
    if (score >= 10) tier = 'dont_miss'; // 五档必须都可达：此前 dont_miss 是死档
    else if (score >= 6) tier = 'worth_meeting';
    else if (score >= 3) tier = 'worth_knowing';
    else tier = 'can_chat';
  }

  // 兜底② 落实：低置信 → 至少降一档
  if (lowConfidence && tier !== 'not_yet') {
    const ladder: CompareResult['tier'][] = ['not_yet', 'can_chat', 'worth_knowing', 'worth_meeting', 'dont_miss'];
    const idx = ladder.indexOf(tier);
    tier = ladder[Math.max(1, idx - 1)]!;
  }

  return { tier, capped: screen.dealbreaker_hits.length > 0, lowConfidence };
}

/** 组装 compare 工具的完整返回（叙事素材 + 档位 + 兜底标记） */
export function buildCompareResult(
  mine: ProfileView,
  theirs: ProfileView,
  completenessMine: number,
  completenessTheirs: number,
): CompareResult {
  const screen = screenCompatibility(mine, theirs);
  const resonance = findResonance(mine, theirs);
  const talkable = findTalkableDifferences(mine, theirs);
  const { tier, capped, lowConfidence } = computeTier(
    screen,
    resonance.length,
    talkable.length,
    completenessMine,
    completenessTheirs,
  );
  return {
    tier,
    tier_capped_by_dealbreaker: capped,
    confidence_low: lowConfidence,
    screened_out: !screen.passed,
    screen_reasons: screen.reasons,
    narrative_input: {
      resonance,
      talkable_differences: talkable,
      dealbreaker_hits: screen.dealbreaker_hits,
    },
    completeness_mine: completenessMine,
    completeness_theirs: completenessTheirs,
  };
}
