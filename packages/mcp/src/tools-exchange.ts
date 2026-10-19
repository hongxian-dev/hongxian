/**
 * MCP Tools · 交换链路：compare / send_envelope / receive_envelope / ledger / coach
 *
 * compare：粗筛零 token（D7）+ 报告输入组装（叙事交宿主 LLM，report_narrative prompt 指引）。
 * send/receive_envelope：九类信封的出入口（D3 握手信道）。
 * ledger：姻缘线手账（D3②/D4/D15④⑥）。coach：选题教练（D12）。
 */

import { z } from 'zod';
import {
  buildCompareResult,
  createLine,
  enterRounds,
  filterOutboundTopic,
  ledgerView,
  noteResponseReceived,
  noteUpgradeSent,
  neutralizeTopic,
  blockLine,
  unblockLine,
  openMessageBody,
  sealMessageBody,
  signMatchCard,
  decryptLayer,
  verifyMatchCard,
  type AuthorizationScope,
  type FateLine,
  type ProfileView,
  type RoundState,
} from '@hongxian/core';
import {
  AnswerCardBody,
  DeclineSilentBody,
  ENV_FILE_EXT,
  GraduationInviteBody,
  GrantL2Body,
  GrantL3Body,
  MsgEnvelope,
  TopicPackBody,
  UpgradeRequestBody,
  canonicalBytes,
  fromBase64,
  toBase64,
  uuidV7,
  type CipherBlock,
} from '@hongxian/schema';
import { reportMetric } from './counter.js';
import { store } from './context.js';
import { dirNameFromKeyId } from './tools-profile.js';
import type { Session } from './session.js';

const CARDS_CONTACTS_DIR = 'cards/contacts';
const LINES_DIR = 'lines';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

// ---------- compare（S6 本地比对） ----------

export const compareTool = {
  name: 'compare',
  description:
    '本地比对：对已导入的对方卡片做粗筛（零 token 结构化规则）+ 组装五档报告输入。' +
    '报告叙事由你（宿主模型）按 report_narrative prompt 生成——每个结论必须有双方原话依据。',
  inputSchema: {
    card_id: z.string().describe('对方卡片 ID（import_card 入库的）'),
  },
  handler: async (args: { card_id: string }, session: Session) => {
    const s = store();
    // 找对方卡
    const owners = s.list(CARDS_CONTACTS_DIR);
    let theirCard: Record<string, unknown> | null = null;
    for (const owner of owners) {
      const c = s.read<Record<string, unknown>>(`${CARDS_CONTACTS_DIR}/${owner}/${args.card_id}.json`);
      if (c) {
        theirCard = c;
        break;
      }
    }
    if (!theirCard) return text(`找不到对方卡片 ${args.card_id}（需先 import_card）。`);
    if (!theirCard.key_l1) return text('对方卡片未携带 key_L1，无法比对。');

    // 本方画像
    const myState = s.read<{ confirmed: Record<string, Record<string, unknown>> }>('profile/interview-state.json');
    if (!myState || !myState.confirmed.values) {
      return text('你的画像尚未完成（三阶段访谈）。先完成建画像。');
    }
    const mine = flattenProfile(myState.confirmed);

    // 对方 L1（key 随卡）
    const openedL1 = decryptLayer(theirCard as never, 'L1', fromBase64(theirCard.key_l1 as string));
    if (!openedL1.ok) return text('对方一阶解密失败。');
    // 对方 L2：需已通过 grant_l2 获得层密钥（目录名 = hex(owner_key_id)）
    const lineDir = dirNameFromKeyId((theirCard.meta as { owner_key_id: string }).owner_key_id);
    const l2Key = s.read<{ key_l2: string }>(`${LINES_DIR}/${lineDir}/layer-keys.json`);
    let theirsL2: Record<string, unknown> = {};
    if (l2Key) {
      const openedL2 = decryptLayer(theirCard as never, 'L2', fromBase64(l2Key.key_l2));
      if (openedL2.ok) theirsL2 = openedL2.payload as Record<string, unknown>;
    }

    const theirs: ProfileView = { l1: openedL1.payload as Record<string, unknown>, l2: theirsL2 };
    const completenessMine = s.read<number>('profile/completeness.json') ?? 0.5;
    const completenessTheirs = (theirCard.meta as { depth: { completeness: number } }).depth.completeness;

    const result = buildCompareResult(mine, theirs, completenessMine, completenessTheirs);
    const l2Missing = !l2Key;
    return text(
      JSON.stringify(
        {
          compare_result: result,
          note: l2Missing
            ? '对方匹配层尚未解锁（未经过双方同意的升级握手）——当前仅基于一阶名片层比对，结论置信度有限。'
            : '匹配层已解锁，比对基于一阶 + 匹配层。',
          report_instruction:
            '请按 report_narrative prompt 生成报告：五档结论 + 三区叙事（共鸣点/可聊差异/硬伤预警），' +
            '每个结论必须有 narrative_input 中的原话依据；硬伤命中不得掩盖；信息不足须降档并说明。',
        },
        null,
        2,
      ),
    );
  },
};

function flattenProfile(confirmed: Record<string, Record<string, unknown>>): ProfileView {
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
      marital_status: facts.marital_status,
      bio: facts.bio,
    },
    l2: {
      values_tags: prefs.values_tags ?? [],
      money_view: prefs.money_view,
      lifestyle: prefs.lifestyle ?? {},
      family_view: prefs.family_view ?? {},
      dealbreakers: prefs.dealbreakers ?? [],
      values_qa: values.values_qa ?? [],
    },
  };
}

// ---------- send_envelope（九类信封出口） ----------

const ENVELOPE_TYPES = [
  'upgrade_request',
  'grant_l2',
  'topic_pack',
  'answer_card',
  'graduation_invite',
  'grant_l3',
  'decline_silent',
] as const;

/**
 * 消息体按类型校验（v0.4：LLM 输出不合 schema → 明确报错重试，不静默发畸形信封）。
 * 对应技术详设 §9 风险对策"Zod 校验 + 降级为字段补全追问"的第一半。
 */
const BODY_SCHEMAS: Partial<Record<(typeof ENVELOPE_TYPES)[number], z.ZodTypeAny>> = {
  upgrade_request: UpgradeRequestBody,
  grant_l2: GrantL2Body,
  topic_pack: TopicPackBody,
  answer_card: AnswerCardBody,
  graduation_invite: GraduationInviteBody,
  grant_l3: GrantL3Body,
  decline_silent: DeclineSilentBody,
};

function validateBody(msgType: (typeof ENVELOPE_TYPES)[number], body: Record<string, unknown>): string | null {
  const schema = BODY_SCHEMAS[msgType];
  if (!schema) return null;
  const r = schema.safeParse(body);
  if (r.success) return null;
  return r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('；');
}

export const sendEnvelopeTool = {
  name: 'send_envelope',
  description:
    '发送一封结构化信封给对方（D3：月老间仅结构化握手，v1 禁自由聊天）。' +
    '类型：upgrade_request(申请解锁L2) / grant_l2(授权) / topic_pack(考题包) / answer_card(回卷) / ' +
    'graduation_invite(毕业邀请) / grant_l3(见面层授权) / decline_silent(婉拒，v1建议不回复)。' +
    '消息体按类型经协议 schema 校验（v0.4），缺字段会明确报错并列出，不会静默发出畸形信封。',
  inputSchema: {
    msg_type: z.enum(ENVELOPE_TYPES),
    target_card_id: z.string().describe('对端卡片 ID'),
    body: z.record(z.unknown()).describe('消息体（各类型字段见协议 schema；topic_pack 的 followups ≤2）'),
    my_card_id: z.string().optional().describe('本方卡片 ID（缺省取最新一张）'),
  },
  handler: async (
    args: { msg_type: (typeof ENVELOPE_TYPES)[number]; target_card_id: string; body: Record<string, unknown>; my_card_id?: string },
    session: Session,
  ) => {
    const s = store();
    // 消息体按类型校验（v0.4）：缺字段/畸形一律拒绝并说明，防 LLM 产出静默劣化
    const bodyError = validateBody(args.msg_type, args.body);
    if (bodyError) {
      return text(
        `消息体不合法（${args.msg_type}）：${bodyError}。\n\n` +
          `请按协议 schema 修正后重发；不要删改协议字段。`,
      );
    }
    const mine = s.list('cards/mine').filter((f) => f.endsWith('.json'));
    if (mine.length === 0) return text('你还没有签发匹配卡。');
    const myCard = s.read<Record<string, unknown>>(
      `cards/mine/${args.my_card_id ? `${args.my_card_id}.json` : mine[mine.length - 1]!}`,
    );
    if (!myCard) return text('找不到本方卡片。');
    // 对端协商公钥（从对方卡 meta 取——换卡即换公钥）
    const theirCard = findContactCard(s, args.target_card_id);
    if (!theirCard) return text(`找不到对端卡片 ${args.target_card_id}（需先 import_card）。`);
    const theirKx = fromBase64((theirCard.meta as { kx_public: string }).kx_public);

    const key = session.keyProvider();
    const block: CipherBlock = sealMessageBody(args.body, theirKx, key);
    const now = Date.now();
    const meta = {
      schema_version: 1,
      card_id: uuidV7(),
      owner_key_id: toBase64(key.keyId()),
      sig_public: toBase64(key.identityPublic()),
      kx_public: toBase64(key.kexPublic()),
      version: 1,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 7 * 86400_000).toISOString(), // 握手信封 TTL 7 天
      card_type: 'match_card',
      msg_type: args.msg_type,
      target_card_id: args.target_card_id,
      depth: (myCard.meta as { depth: unknown }).depth,
      algo: { sig: 'ed25519', aead: 'aes-256-gcm', kex: 'x25519' },
    };
    const env: MsgEnvelope = {
      meta: meta as never,
      payload: block,
      signature: toBase64(key.sign(canonicalBytes({ meta, payload: block }))),
    };
    const linePath = `${LINES_DIR}/${dirNameFromKeyId((theirCard.meta as { owner_key_id: string }).owner_key_id)}`;
    const fileName = `${new Date(now).toISOString().replace(/[:.]/g, '')}-${args.msg_type}${ENV_FILE_EXT}`;
    s.write(`${linePath}/envelopes/${fileName}`, env);
    // 手账：升级请求未回应计数（D15④）
    const line = s.read<FateLine>(`${linePath}/state.json`);
    if (line) {
      const updated =
        args.msg_type === 'upgrade_request' || args.msg_type === 'topic_pack' || args.msg_type === 'graduation_invite'
          ? noteUpgradeSent(line)
          : args.msg_type === 'grant_l2' || args.msg_type === 'answer_card'
            ? noteResponseReceived(line)
            : line;
      s.write(`${linePath}/state.json`, updated);
    }
    void reportMetric(session.settings().opt_in_counter, 'exchange_initiated', 'none');
    return text(
      `信封已生成并存入本机：${linePath}/envelopes/${fileName}\n\n` +
        `文件内容（传给对方，对方用 receive_envelope 导入）：\n\n\`\`\`json\n${JSON.stringify(env, null, 2)}\n\`\`\`\n\n` +
        `对方回应前，你不会知道对方读没读、想没想（v1 无服务器，不假装知道）。`,
    );
  },
};

function findContactCard(s: ReturnType<typeof store>, cardId: string): Record<string, unknown> | null {
  for (const owner of s.list(CARDS_CONTACTS_DIR)) {
    const c = s.read<Record<string, unknown>>(`${CARDS_CONTACTS_DIR}/${owner}/${cardId}.json`);
    if (c) return c;
  }
  return null;
}

// ---------- receive_envelope（九类信封入口） ----------

export const receiveEnvelopeTool = {
  name: 'receive_envelope',
  description:
    '接收并处理对方发来的信封：验签 → 按类型路由（换卡/升级请求/授权/考题/回卷/毕业邀请/婉拒）。' +
    '拉黑线的一切信封不呈报。',
  inputSchema: {
    file_content: z.string().describe('对方 .hongxian-env 文件 JSON 全文'),
  },
  handler: async (args: { file_content: string }, session: Session) => {
    const s = store();
    let parsed: MsgEnvelope;
    try {
      parsed = JSON.parse(args.file_content) as MsgEnvelope;
    } catch {
      return text('信封不是合法 JSON。');
    }
    const check = MsgEnvelope.safeParse(parsed);
    if (!check.success) return text(`信封结构不合法：${check.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    const env = check.data;
    // 验签（卡自带公钥）
    const { verifyDetached } = await import('@hongxian/crypto');
    const sigOk = verifyDetached(
      fromBase64(env.signature),
      canonicalBytes({ meta: env.meta, payload: env.payload }),
      fromBase64(env.meta.sig_public),
    );
    if (!sigOk) return text('信封验签失败——可能被伪造或篡改，拒绝处理。');

    const lineDir = dirNameFromKeyId(env.meta.owner_key_id);
    const linePath = `${LINES_DIR}/${lineDir}`;
    const line = s.read<FateLine>(`${linePath}/state.json`);
    if (line?.blocked) {
      return text('（该发件人已被拉黑，信封不再呈报。）');
    }
    if (!line) {
      // 首封信 = match_card（换卡握手）
      s.write(`${linePath}/state.json`, createLine(env.meta.card_id, lineDir, 'card_received'));
    }

    // 解封消息体（本方 X25519 私钥）
    const key = session.keyProvider();
    const opened = openMessageBody(env.payload, key);
    const body = opened.ok ? opened.body : null;

    switch (env.meta.msg_type) {
      case 'upgrade_request': {
        if (line) s.write(`${linePath}/state.json`, noteResponseReceived(line));
        return text(
          `对方请求解锁匹配层（深聊层）。\n\n附带信息：${JSON.stringify(body)}\n\n` +
            `**你的选择**：同意 → send_envelope(grant_l2，携带用对方公钥封装的 key_L2)；` +
            `不愿意 → 不回复即可（静默，对方收不到任何信号）。`,
        );
      }
      case 'grant_l2': {
        // 对方交付的 key_L2：用本方 kx 私钥解封
        const wrapped = fromBase64((body as { wrapped_key_l2: string }).wrapped_key_l2);
        const l2Key = key.openSealed(wrapped);
        if (!l2Key) return text('grant_l2 解封失败（非本方密钥或已篡改）。');
        s.write(`${linePath}/layer-keys.json`, { key_l2: toBase64(l2Key) });
        const l = s.read<FateLine>(`${linePath}/state.json`);
        if (l) s.write(`${linePath}/state.json`, enterRounds(noteResponseReceived(l)));
        return text('匹配层已解锁——现在可以 compare 做完整比对了。');
      }
      case 'topic_pack': {
        const l = s.read<FateLine>(`${linePath}/state.json`);
        if (l) s.write(`${linePath}/state.json`, noteResponseReceived(l));
        return text(
          `对方月老传来一道考题（第 ${(body as { round: number }).round} 轮）：\n\n` +
            `主题：${(body as { topic: string }).topic}\n追问：${((body as { followups: string[] }).followups ?? []).join('；') || '无'}\n` +
            `出题理由：${(body as { reason: string }).reason}\n通道：${(body as { channel: string }).channel === 'owner' ? '主人想问的' : '月老建议的'}\n\n` +
            `请按三态应答：现场可答 → send_envelope(answer_card, status=answered)；` +
            `超出画像 → status=ask_master（带回去问主人）；暂时不想答 → status=deferred（不判红旗）。\n` +
            `你对本题有对等反问权（D11 对称出题权）。`,
        );
      }
      case 'answer_card': {
        const l = s.read<FateLine>(`${linePath}/state.json`);
        if (l) s.write(`${linePath}/state.json`, noteResponseReceived(l));
        return text(
          `对方已回答你出的题（第 ${(body as { round: number }).round} 轮，状态：${(body as { status: string }).status}）：\n\n` +
            `${(body as { answer?: string }).answer ?? (body as { note?: string }).note ?? '（对方选择暂不回应——婉答也是信息，但不自动判为红旗）'}`,
        );
      }
      case 'graduation_invite': {
        const l = s.read<FateLine>(`${linePath}/state.json`);
        if (l) s.write(`${linePath}/state.json`, noteResponseReceived(l));
        return text(
          `**毕业邀请**——对方主人发来线下认识邀请。\n\n` +
            `${(body as { letter?: string }).letter ? `亲笔短信：「${(body as { letter: string }).letter}」\n\n` : ''}` +
            `申请解锁的见面层字段：${((body as { request_l3_fields: string[] }).request_l3_fields ?? []).join('、')}\n\n` +
            `三态应答：同意（grant_l3 逐字段交付）/ 暂缓（无需理由，继续深聊——月老永不催促见面）/ 婉拒（不回复即静默）。`,
        );
      }
      case 'grant_l3': {
        const fields = (body as { fields: { field: string; wrapped_key: string }[] }).fields ?? [];
        const lineKeyPath = `${linePath}/layer-keys.json`;
        const existing = s.read<Record<string, string>>(lineKeyPath) ?? {};
        for (const f of fields) {
          const k = key.openSealed(fromBase64(f.wrapped_key));
          if (k) existing[`l3_${f.field}`] = toBase64(k);
        }
        s.write(lineKeyPath, existing);
        return text(
          `见面层已按字段解锁：${fields.map((f) => f.field).join('、')}。\n\n` +
            `**红线交到你们自己手里了**——此后月老只做见面复盘，不介入你们两人的对话。\n` +
            `安全提示：任何涉及金钱的请求，立即警惕。`,
        );
      }
      case 'decline_silent':
        return text('（对方婉拒。静默处理，不向你的主人展示任何被拒信号——D4）');
      default:
        return text(`未支持的信封类型：${env.meta.msg_type}`);
    }
  },
};

// ---------- ledger（姻缘线手账） ----------

export const ledgerTool = {
  name: 'ledger',
  description: '红线手账：姻缘线列表（已递出/已回音/未通过/深聊中/已毕业/已拉黑）、拉黑建议（3 次未回应）、备注。',
  inputSchema: {
    action: z.enum(['list', 'block', 'unblock', 'note']).default('list'),
    line_id: z.string().optional().describe('姻缘线 ID（block/unblock/note 时）'),
    note: z.string().optional().describe('备注内容（见面复盘等，只存本地）'),
  },
  handler: async (args: { action: string; line_id?: string; note?: string }, _session: Session) => {
    const s = store();
    const lines: FateLine[] = [];
    for (const dir of s.list(LINES_DIR)) {
      const l = s.read<FateLine>(`${LINES_DIR}/${dir}/state.json`);
      if (l) lines.push(l);
    }
    if (args.action === 'list') {
      const view = ledgerView(lines);
      const detail = lines
        .map(
          (l) =>
            `- ${l.line_id.slice(0, 8)}… [${l.status}]${l.blocked ? '（已拉黑）' : ''}` +
            ` 轮次${l.rounds_total}${l.unresponded_upgrades ? ` 未回应${l.unresponded_upgrades}` : ''}`,
        )
        .join('\n');
      const suggestions = view.block_suggestions.length
        ? `\n\n**拉黑建议**（连续 ${view.block_suggestions[0]!.unresponded} 次未回应）：${view.block_suggestions.map((b) => b.line_id.slice(0, 8)).join('、')}——拉黑后其一切信封不再呈报，且不通知对方。`
        : '';
      return text(`姻缘线 ${view.total} 条：\n${detail || '（还没有线）'}${suggestions}`);
    }
    if (!args.line_id) return text('请提供 line_id。');
    const line = lines.find((l) => l.line_id === args.line_id);
    if (!line) return text('找不到该姻缘线。');
    const path = `${LINES_DIR}/${line.owner_dir}/state.json`;
    if (args.action === 'block') {
      s.write(path, blockLine(line));
      return text('已拉黑。此后该发件人的一切信封不再呈报（本地生效，不通知对方）。');
    }
    if (args.action === 'unblock') {
      s.write(path, unblockLine(line));
      return text('已解除拉黑。');
    }
    if (args.action === 'note') {
      if (!args.note) return text('请提供备注内容。');
      s.write(path, { ...line, notes: [...line.notes, `${new Date().toISOString().slice(0, 10)} ${args.note}`] });
      return text('备注已记录（只存本机）。');
    }
    return text('未知 action。');
  },
};

// ---------- coach（选题教练 D12） ----------

/** v1 内置题库模板（三源之一：心理学与婚姻学知识模板——标注"参考框架非诊断"） */
const TOPIC_BANK: Record<string, { question: string; reason: string }[]> = {
  价值观: [
    { question: '你理想的一天是怎样的？从早到晚说一遍。', reason: '日常节奏比宏大的三观更能预测相处质量' },
    { question: '最近一次让你改变主意的事是什么？', reason: '开放性指标：能否被说服、如何整合异见' },
  ],
  家庭观: [
    { question: '你家里钱的事谁说了算？你家原来怎么管的？', reason: '金钱冲突多是规则冲突而非数额冲突' },
    { question: '逢年过节你怎么安排两边家庭？', reason: '家庭边界与仪式安排，预见婚后高频场景' },
  ],
  金钱观: [
    { question: '你最近一笔"值"的花费是什么？', reason: '价值排序的直接证据' },
    { question: '大额支出前你会怎么和伴侣商量？', reason: '财务沟通模式预测共同财务管理' },
  ],
  生活方式: [
    { question: '工作日晚上十点，你通常在做什么？', reason: '作息与共处时间的真实图景' },
    { question: '你一个人的时候怎么恢复精力？', reason: '内向/外向的能量管理方式' },
  ],
  dealbreakers验证: [
    { question: '有什么事对你来说是明确的底线？', reason: '负面清单的预测力远高于偏好（D1）' },
  ],
};

export const coachTool = {
  name: 'coach',
  description:
    '选题教练：基于题库与对方画像缺口，为主人拟下一轮 2–3 道候选题，每题附出题理由。' +
    '主人可选用/修改/自定（双通道标记）。伦理护栏：只出促进真实了解的题，禁止操纵性话术。',
  inputSchema: {
    dimension: z
      .string()
      .describe('拟考察维度：价值观/家庭观/金钱观/生活方式/dealbreakers验证'),
    my_topic: z.string().optional().describe('主人亲定的题（标记"主人想问的"，月老照问但不做评分式解读）'),
  },
  handler: async (args: { dimension: string; my_topic?: string }, session: Session) => {
    const s = store();
    const state = s.read<{ confirmed: { preferences?: { dealbreakers?: { dimension: string }[] } } }>(
      'profile/interview-state.json',
    );
    const scope: AuthorizationScope = {
      allowed_dimensions: ['价值观', '家庭观', '金钱观', '生活方式', 'dealbreakers验证'],
      allowed_fields: [],
      allow_proxy_sensitive: true,
    };
    const myBreakers = (state?.confirmed.preferences?.dealbreakers ?? []).map((d) => d.dimension);

    // 主人亲定题：直接采用（双通道标记）
    if (args.my_topic) {
      const decision = filterOutboundTopic(args.my_topic, args.dimension, scope, myBreakers);
      if (!decision.allowed && decision.action === 'ask_master') {
        return text(`这道题超出了你授权的可谈范围：${decision.reason}`);
      }
      return text(
        `已按「主人想问的」采用：${args.my_topic}\n\n` +
          `（月老照问，但报告中不做评分式解读——这是你的好奇或好感，不是系统评估。）`,
      );
    }

    const candidates = TOPIC_BANK[args.dimension] ?? TOPIC_BANK['价值观']!;
    const lines: string[] = [`下一轮候选题（维度：${args.dimension}）：\n`];
    for (const [i, c] of candidates.slice(0, 3).entries()) {
      const decision = filterOutboundTopic(c.question, args.dimension, scope, myBreakers);
      lines.push(
        `${i + 1}. ${c.question}\n   理由：${c.reason}（参考框架，非诊断）\n   通道：月老建议的` +
          (decision.allowed && 'neutralized' in decision ? `\n   注意：涉及你的底线维度，将以中性化措辞代问（"${neutralizeTopic(args.dimension)}"）` : ''),
      );
    }
    lines.push(
      `\n用法：选用（说"用第 N 道"）/ 修改后使用 / 完全自己出题（告诉我题目，标"主人想问的"）。\n` +
        `伦理提示：如果发现自己在想"怎么让对方对我印象更好"，那是在设计人设——月老不接这种单。`,
    );
    return text(lines.join('\n'));
  },
};
