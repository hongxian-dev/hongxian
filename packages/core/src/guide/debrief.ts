/**
 * 见面复盘（D3③）
 *
 * 设计意图：真实感受 → 本地校准画像与 dealbreaker 权重 → 越用越懂主人。
 * 但校准的「决定权」必须在主人手里：月老只把「值得重新想一想的地方」摆出来，
 * 不自动改画像、不偷偷调权重（否则就是 AI 在替你定义你喜欢谁）。
 *
 * 纯函数 + 结构化记录，落盘在 mcp 层。
 */

export interface DebriefRecord {
  /** 对端 card_id */
  card_id: string;
  /** 总体感受：想再见 / 说不好 / 不想再见（主人自评，不是评分） */
  feeling: 'again' | 'unsure' | 'no';
  /** 具体哪里对上了 */
  matches: string[];
  /** 具体哪里别扭 / 意外 */
  surprises: string[];
  /** 下次想怎么调整（可选） */
  next_time?: string;
  created_at: string;
}

/** 校准建议：把复盘内容映射到「可以重新想一想」的画像点位（不自动改） */
export interface CalibrationHint {
  /** 画像点位（dealbreaker 维度 / lifestyle 字段 / values 维度） */
  target: string;
  /** 建议动作 */
  action: 'review_dealbreaker' | 'review_weight' | 'confirm_preference';
  reason: string;
}

/**
 * 生成校准建议。
 * 规则刻意保守：只在「复盘原话命中了已有画像点位」时才提示，
 * 不做语义发挥（弱模型环境下少说少错，宁可漏提示也不误导）。
 */
export function buildCalibrationHints(
  record: DebriefRecord,
  context: { dealbreakers?: { dimension: string; note: string }[]; values_tags?: { tag: string; weight: number }[] } = {},
): CalibrationHint[] {
  const hints: CalibrationHint[] = [];
  const text = [...record.matches, ...record.surprises, record.next_time ?? ''].join(' ');
  if (!text.trim()) return hints;

  for (const db of context.dealbreakers ?? []) {
    if (db.note && text.includes(db.note.slice(0, 4))) {
      hints.push({
        target: db.dimension,
        action: 'review_dealbreaker',
        reason: `你复盘时又提到「${db.note.slice(0, 12)}」——要不要重新确认它还是不是底线？`,
      });
    }
  }

  if (record.feeling === 'again' && (context.dealbreakers?.length ?? 0) > 0) {
    hints.push({
      target: 'dealbreakers',
      action: 'confirm_preference',
      reason: '这次见面感觉不错：如果对方的某些条件原本在你的底线清单里，值得复核一次是否真的不可接受。',
    });
  }

  if (record.feeling === 'no' && record.surprises.length > 0) {
    hints.push({
      target: 'surprises',
      action: 'confirm_preference',
      reason: '让你别扭的地方，往往是画像里还没写清楚的偏好——可以补一条到偏好或底线里。',
    });
  }

  // 去重（同一 target + action 只留一条）
  const seen = new Set<string>();
  return hints.filter((h) => {
    const k = `${h.target}|${h.action}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 复盘渲染为月老口吻文本 */
export function renderDebrief(record: DebriefRecord, hints: CalibrationHint[]): string {
  const feelingText =
    record.feeling === 'again' ? '想再见一面' : record.feeling === 'no' ? '不想再见' : '说不好';
  const parts = [
    `**复盘已记下**（只存本机）：${feelingText}。`,
    record.matches.length ? `\n对上的：${record.matches.join('、')}` : '',
    record.surprises.length ? `\n别扭或意外的：${record.surprises.join('、')}` : '',
    record.next_time ? `\n下次想调整：${record.next_time}` : '',
  ].filter(Boolean);

  if (hints.length) {
    parts.push(
      '\n## 可以重新想一想的地方（我不替你改画像）',
      hints.map((h) => `- ${h.reason}`).join('\n'),
      '\n要改就说一声，我按你的话改；不说就保持原样。',
    );
  } else {
    parts.push('\n这次没有需要动摇的画像点位——记着就好。');
  }
  return parts.join('\n');
}
