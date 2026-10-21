/**
 * 见面锦囊 + 安全提示（D3④ / D13）
 *
 * 定位红线：月老可以做「代见」的准备——话题、场合、节奏、安全清单；
 * 但**见面与心动永远归主人**（D9 代理边界三段式的终点）。
 * 所以锦囊里没有"该说什么让对方喜欢你"，只有"怎么好好认识一个人"。
 *
 * 纯函数：输入双方画像视图，输出结构化锦囊。不调 LLM、不评分、不排序。
 */

import type { ProfileView } from '../match/screen.js';
import { findResonance, findTalkableDifferences } from '../match/screen.js';

export interface MeetingKit {
  /** 破冰话题（来自双方画像的真实共鸣与差异，不编造） */
  topics: { kind: 'resonance' | 'difference'; label: string; suggest: string }[];
  /** 场合与节奏建议（固定纪律，随画像微调） */
  setting: string[];
  /** 安全清单（首次见面必附） */
  safety: string[];
  /** 反诈终检（转入深度联系是杀猪盘高发节点——D13） */
  anti_fraud: string[];
  /** 已经互相交付了哪些层（对称性回顾：你给了什么，对方给了什么） */
  symmetry: { layer: string; note: string }[];
}

export interface MeetingKitInput {
  mine: ProfileView;
  /** 对方画像（L2 未解锁时只传 l1，锦囊只给一阶层话题） */
  theirs: ProfileView;
  /** 已解锁的层（'L1' | 'L2' | 'L3'） */
  unlocked: string[];
  /** 对方已交付的见面层字段名（对称性回顾用） */
  grantedFields?: string[];
}

export function buildMeetingKit(input: MeetingKitInput): MeetingKit {
  const resonance = findResonance(input.mine, input.theirs);
  const differences = findTalkableDifferences(input.mine, input.theirs);

  const topics: MeetingKit['topics'] = [
    ...resonance.slice(0, 3).map((r) => ({
      kind: 'resonance' as const,
      label: r.point,
      suggest: `从这里开场最自然：${r.point}。可以问对方"你最喜欢其中哪一次？"`,
    })),
    ...differences.slice(0, 2).map((d) => ({
      kind: 'difference' as const,
      label: d.dimension,
      suggest: `${d.suggestion}。注意问法：问"你怎么想"，不问"你为什么这样"`,
    })),
  ];
  if (topics.length === 0) {
    topics.push({
      kind: 'resonance',
      label: '（画像信息不足）',
      suggest: '先聊对方最近在忙什么、周末通常怎么过——开放式、不追问、不评判。',
    });
  }

  const setting = [
    '第一次见面选公共场所（咖啡馆、公园、书店），白天优先',
    '时长控制在 60–90 分钟：意犹未尽好过撑到尴尬',
    '各自往返、各自买单——第一次不谈谁请客，AA 最省心',
    '不安排"见朋友/见家人"这类加码环节，第一次只认识彼此',
  ];

  const safety = [
    '地点由你定：公共场所、白天优先——对方坚持换到私密场所，就是危险信号',
    '把见面时间、地点、对方基本信息告诉一位你信任的人',
    '自己到、自己走，不坐对方安排的车、不去对方住处',
    '酒量留在自己清楚的范围里；饮品离开视线后不再喝',
    '感觉不对随时可以走——礼貌告辞不需要理由，也不需要解释',
    '（已解锁的联络方式之外，不要在第一次就给身份证件、住址、公司门牌）',
  ];

  const anti_fraud = [
    '**任何涉及金钱的请求，立即警惕**：借钱、投资、代付、刷单、"帮我垫一下"——无论故事多动人',
    '杀猪盘的高发节点正是"刚转深度联系"这一段：越是在你觉得顺利的时候，越要慢一步',
    '真人对质：让对方在你熟悉的领域讲一件具体的事，骗子经不起细节追问',
    '不点对方发来的陌生链接、不装对方推荐的 App、不扫码付款',
    '对称性回顾：下面这张表里，你给的和他给的应当大致对等——"只看不给"是骗子最常见的姿态',
  ];

  const symmetry: MeetingKit['symmetry'] = [
    {
      layer: '一阶 · 名片层',
      note: input.unlocked.includes('L1') ? '已双向解锁（昵称/年龄段/城市/职业大类等公开信息）' : '尚未完成一阶互换',
    },
    {
      layer: '二阶 · 深聊层',
      note: input.unlocked.includes('L2')
        ? '已双向解锁（价值观问答、生活方式、房车概况、dealbreakers）'
        : '未解锁——本次见面仍属"初次认识"，不要追问收入、婚史细节',
    },
    {
      layer: '三阶 · 见面层',
      note: input.grantedFields?.length
        ? `对方已交付：${input.grantedFields.join('、')}`
        : '对方尚未交付任何联系方式——若你已给而对方没给，注意保持对等',
    },
  ];

  return { topics, setting, safety, anti_fraud, symmetry };
}

/** 锦囊渲染为月老口吻文本（MCP 工具直接返回） */
export function renderMeetingKit(kit: MeetingKit): string {
  const topicLines = kit.topics.map((t, i) => `${i + 1}. [${t.kind === 'resonance' ? '共鸣' : '差异'}] ${t.suggest}`).join('\n');
  return [
    '**见面锦囊**——话题、场合、安全，三样齐了再去。',
    '',
    '## 可以聊的',
    topicLines,
    '',
    '## 怎么见',
    kit.setting.map((s) => `- ${s}`).join('\n'),
    '',
    '## 安全（第一次见面必看）',
    kit.safety.map((s) => `- ${s}`).join('\n'),
    '',
    '## 反诈终检',
    kit.anti_fraud.map((s) => `- ${s}`).join('\n'),
    '',
    '## 对称性回顾',
    kit.symmetry.map((s) => `- ${s.layer}：${s.note}`).join('\n'),
    '',
    '最后一句：见面和心动归你自己。我只把路铺平，走不走、往哪走，都是你的事。',
  ].join('\n');
}
