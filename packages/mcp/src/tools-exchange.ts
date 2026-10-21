/**
 * MCP Tools · 交换链路：compare / send_envelope / receive_envelope / ledger / coach
 *
 * compare：粗筛零 token（D7）+ 报告输入组装（叙事交宿主 LLM，report_narrative prompt 指引）。
 * send/receive_envelope：九类信封的出入口（D3 握手信道）。
 * ledger：姻缘线手账（D3②/D4/D15④⑥）。coach：选题教练（D12）。
 *
 * v0.4 / M1.3 重构：消息体补全（completeMessageBody）、信封构造（buildSignedEnvelope）、
 * 信封路由（routeEnvelope）三个共享函数抽出——send_via_server（广场流）与
 * receive_envelope（文件流）复用同一套信封逻辑，两条信道一个实现。
 */

import { z } from 'zod';
import {
  buildCompareResult,
  cardFingerprint,
  createLine,
  enterRounds,
  filterOutboundTopic,
  ledgerView,
  noteResponseReceived,
  noteUpgradeSent,
  neutralizeTopic,
  blockLine,
  unblockLine,
  graduate,
  markNoFollowUp,
  openMessageBody,
  sealMessageBody,
  l3FieldKey,
  l3ContainerKey,
  detectLeakRisk,
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
  GrantL1Body,
  GrantL2Body,
  GrantL3Body,
  L3_FIELD_NAMES,
  MsgEnvelope,
  TopicPackBody,
  UpgradeRequestBody,
  canonicalBytes,
  fromBase64,
  toBase64,
  uuidV7,
  type CipherBlock,
} from '@hongxian/schema';
import { verifyDetached } from '@hongxian/crypto';
import { reportMetric } from './counter.js';
import { store } from './context.js';
import { dirNameFromKeyId } from './tools-profile.js';
import {
  findCachedPlazaCardByFingerprint,
  findOwnPlazaCardById,
  findOwnPlazaCardByFingerprint,
  listOwnPlazaCards,
} from './plaza-store.js';
import { applyAnswer, applyOpenTopic, loadLineRounds, saveLineRounds } from './rounds-store.js';
import { findContactCard, flattenProfile } from './profile-view.js';
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
    // L1 钥匙解析：文件流随卡携带；广场流不在卡上（§10.5）——经 grant_l1 解锁后存于姻缘线层密钥
    let l1KeyB64 = theirCard.key_l1 as string | undefined;
    if (!l1KeyB64) {
      const lineKeys = s.read<{ key_l1?: string }>(
        `${LINES_DIR}/${dirNameFromKeyId((theirCard.meta as { owner_key_id: string }).owner_key_id)}/layer-keys.json`,
      );
      l1KeyB64 = lineKeys?.key_l1;
    }
    if (!l1KeyB64) return text('对方卡片未携带 key_L1，且尚未经 grant_l1 解锁——无法比对。');

    // 本方画像
    const myState = s.read<{ confirmed: Record<string, Record<string, unknown>> }>('profile/interview-state.json');
    if (!myState || !myState.confirmed.values) {
      return text('你的画像尚未完成（三阶段访谈）。先完成建画像。');
    }
    const mine = flattenProfile(myState.confirmed);

    // 对方 L1（文件流 key 随卡；广场流经 grant_l1 解锁——见上方解析）
    const openedL1 = decryptLayer(theirCard as never, 'L1', fromBase64(l1KeyB64));
    if (!openedL1.ok) return text('对方一阶解密失败。');
    // 对方 L2：需已通过 grant_l2 获得层密钥（目录名 = hex(owner_key_id)）。
    // 注意按 key_l2 字段判定而非文件存在性——广场流下线层密钥文件可能只含 key_l1（V6）
    const lineDir = dirNameFromKeyId((theirCard.meta as { owner_key_id: string }).owner_key_id);
    const l2KeyB64 = s.read<{ key_l2?: string }>(`${LINES_DIR}/${lineDir}/layer-keys.json`)?.key_l2;
    let theirsL2: Record<string, unknown> = {};
    if (l2KeyB64) {
      const openedL2 = decryptLayer(theirCard as never, 'L2', fromBase64(l2KeyB64));
      if (openedL2.ok) theirsL2 = openedL2.payload as Record<string, unknown>;
    }

    const theirs: ProfileView = { l1: openedL1.payload as Record<string, unknown>, l2: theirsL2 };
    const completenessMine = s.read<number>('profile/completeness.json') ?? 0.5;
    const completenessTheirs = (theirCard.meta as { depth: { completeness: number } }).depth.completeness;

    const result = buildCompareResult(mine, theirs, completenessMine, completenessTheirs);
    const l2Missing = !l2KeyB64;
    // 报告留档（只存本机）：同一对象的历次比对按时间排列，供自己回看档位怎么变
    const reportAt = new Date().toISOString();
    const reportName = `${reportAt.replace(/[:.]/g, '')}.json`;
    s.write(`${LINES_DIR}/${lineDir}/reports/${reportName}`, {
      at: reportAt,
      card_id: args.card_id,
      tier: result.tier,
      confidence_low: result.confidence_low,
      l2_unlocked: !l2Missing,
      result,
    });
    return text(
      JSON.stringify(
        {
          compare_result: result,
          note: l2Missing
            ? '对方匹配层尚未解锁（未经过双方同意的升级握手）——当前仅基于一阶名片层比对，结论置信度有限。'
            : '匹配层已解锁，比对基于一阶 + 匹配层。',
          report_saved: `${LINES_DIR}/${lineDir}/reports/${reportName}`,
          report_instruction:
            '请按 report_narrative prompt 生成报告：五档结论 + 三区叙事（共鸣点/可聊差异/硬伤预警），' +
            '每个结论必须有 narrative_input 中的原话依据；硬伤命中不得掩盖；信息不足须降档并说明。' +
            '报告只在本机呈现，绝不自动发给对方。',
        },
        null,
        2,
      ),
    );
  },
};


// ---------- send_envelope（九类信封出口） ----------

export const ENVELOPE_TYPES = [
  'upgrade_request',
  'grant_l1',
  'grant_l2',
  'topic_pack',
  'answer_card',
  'graduation_invite',
  'grant_l3',
  'decline_silent',
] as const;

export type EnvelopeMsgType = (typeof ENVELOPE_TYPES)[number];

/**
 * 消息体按类型校验（v0.4：LLM 输出不合 schema → 明确报错重试，不静默发畸形信封）。
 * 对应技术详设 §9 风险对策"Zod 校验 + 降级为字段补全追问"的第一半。
 */
const BODY_SCHEMAS: Partial<Record<EnvelopeMsgType, z.ZodTypeAny>> = {
  upgrade_request: UpgradeRequestBody,
  grant_l1: GrantL1Body,
  grant_l2: GrantL2Body,
  topic_pack: TopicPackBody,
  answer_card: AnswerCardBody,
  graduation_invite: GraduationInviteBody,
  grant_l3: GrantL3Body,
  decline_silent: DeclineSilentBody,
};

/** 消息体按类型校验（send_via_server 与 send_envelope 共用） */
export function validateBody(msgType: EnvelopeMsgType, body: Record<string, unknown>): string | null {
  const schema = BODY_SCHEMAS[msgType];
  if (!schema) return null;
  const r = schema.safeParse(body);
  if (r.success) return null;
  return r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('；');
}

/**
 * 出站泄露面审查（D15⑦）：考题本身会泄露主人在意什么。
 * 触发条件：题目/追问/理由里出现主人 dealbreaker 的原话关键词。
 * 处理：不静默改写，也不放行——把中性化版本交回给月老，由它重发（留痕可查）。
 */
export function checkOutboundLeak(
  msgType: EnvelopeMsgType,
  body: Record<string, unknown>,
  s: ReturnType<typeof store>,
): string | null {
  if (msgType !== 'topic_pack') return null;
  const state = s.read<{ confirmed?: { preferences?: { dealbreakers?: { dimension: string; note: string }[] } } }>(
    'profile/interview-state.json',
  );
  const breakers = state?.confirmed?.preferences?.dealbreakers ?? [];
  if (breakers.length === 0) return null;
  const text = [
    body.topic as string,
    ...((body.followups as string[]) ?? []),
    body.reason as string,
  ]
    .filter(Boolean)
    .join(' ');
  const risky = breakers.filter((b) => b.note && b.note.length >= 2 && text.includes(b.note));
  if (risky.length === 0) return null;

  const dim = risky[0]!.dimension;
  return (
    `这道题会把你的底牌露给对方：题目里出现了你自己写在底线清单里的原话「${risky[0]!.note}」。\n\n` +
    `对方会读出来"这个人在意${dim}"——而你只是不想被这件事筛掉。\n\n` +
    `改法：用中性化措辞代问（D9④）：\n` +
    `  topic: "${neutralizeTopic(dim)}"\n` +
    `  reason: 保持你原来的理由，但不要引用底线原话\n\n` +
    `改好后重发。这不是文字洁癖——出站过滤是代访机制的安全边界。`
  );
}

// ---------- 共享：消息体补全（v0.4；send_envelope 与 send_via_server 共用） ----------

export interface CompletedBody {
  ok: true;
  body: Record<string, unknown>;
  /** 收件人协商公钥（grant_l1 由消息体派生；其余类型由调用方从卡片解析） */
  recipientKx?: Uint8Array;
}

/**
 * 消息体补全——两类 LLM 无法自行构造的字段在此派生：
 * ① upgrade_request：缺省补 requester_kx_public（v0.4 必填）、from_card_id、attach_card_ref；
 * ② grant_l1：由 card_fingerprint + requester_kx_public 派生 sealed_key_l1
 *    （本方 L1 层密钥经请求方公钥密封——密文构造必须是工具职责，不是 LLM 职责）。
 */
export function completeMessageBody(
  msgType: EnvelopeMsgType,
  body: Record<string, unknown>,
  session: Session,
  s: ReturnType<typeof store>,
  opts: { recipientKx?: Uint8Array } = {},
): CompletedBody | { ok: false; error: string } {
  if (msgType === 'upgrade_request') {
    const key = session.keyProvider();
    const mine = s.list('cards/mine').filter((f) => f.endsWith('.json'));
    const myLatest = mine.length ? mine[mine.length - 1]!.replace(/\.json$/, '') : null;
    const ownPlaza = listOwnPlazaCards(s);
    const myPlazaId = ownPlaza.length ? ownPlaza[ownPlaza.length - 1]!.meta.card_id : null;
    const fromCardId = (body.from_card_id as string | undefined) ?? myPlazaId ?? myLatest;
    if (!fromCardId) return { ok: false, error: '你还没有签发任何卡片（sign_card），无法发起升级请求。' };
    return {
      ok: true,
      body: {
        ...body,
        from_card_id: fromCardId,
        attach_card_ref: (body.attach_card_ref as string | undefined) ?? (myPlazaId ? `plaza:${myPlazaId}` : `card:${fromCardId}`),
        requester_kx_public: (body.requester_kx_public as string | undefined) ?? toBase64(key.kexPublic()),
      },
    };
  }
  if (msgType === 'grant_l1') {
    const fingerprint = body.card_fingerprint as string | undefined;
    const requesterKxB64 = body.requester_kx_public as string | undefined;
    if (!fingerprint || !/^[0-9a-f]{16}$/.test(fingerprint)) {
      return { ok: false, error: 'grant_l1 需要 card_fingerprint（16 位十六进制——对方所见广场卡的指纹）。' };
    }
    if (!requesterKxB64) {
      return { ok: false, error: 'grant_l1 需要 requester_kx_public（请求方协商公钥，来自对方 upgrade_request 消息体）。' };
    }
    const own = findOwnPlazaCardByFingerprint(s, fingerprint);
    if (!own) {
      return { ok: false, error: `找不到指纹为 ${fingerprint} 的本方广场卡（可能已被撤下或从未贴卡——plaza_publish 先贴卡）。` };
    }
    const key = session.keyProvider();
    let recipientKx: Uint8Array;
    try {
      recipientKx = fromBase64(requesterKxB64);
      if (recipientKx.length !== 32) throw new Error('length');
    } catch {
      return { ok: false, error: 'requester_kx_public 不是合法的 32 字节 base64 公钥。' };
    }
    const sealed = key.sealFor(recipientKx, key.layerKey('L1'));
    return {
      ok: true,
      recipientKx,
      body: {
        from_card_id: (body.from_card_id as string | undefined) ?? own.meta.card_id,
        card_fingerprint: fingerprint,
        sealed_key_l1: toBase64(sealed),
      },
    };
  }
  if (msgType === 'grant_l2') {
    // 同一原则：层密钥的封装是工具职责。LLM 只需说"同意解锁"，不必自己构造密文。
    const recipientKx = opts.recipientKx;
    if (!recipientKx) {
      return { ok: false, error: 'grant_l2 缺少收件人协商公钥（请用 target_card_id 指定收件人）。' };
    }
    const mine = s.list('cards/mine').filter((f) => f.endsWith('.json'));
    const myLatest = mine.length ? mine[mine.length - 1]!.replace(/\.json$/, '') : null;
    const fromCardId = (body.from_card_id as string | undefined) ?? myLatest;
    if (!fromCardId) return { ok: false, error: '你还没有签发任何卡片（sign_card），无法授权匹配层。' };
    const key = session.keyProvider();
    const wrapped = key.sealFor(recipientKx, key.layerKey('L2'));
    return {
      ok: true,
      recipientKx,
      body: { from_card_id: fromCardId, wrapped_key_l2: toBase64(wrapped) },
    };
  }
  if (msgType === 'grant_l3') {
    // D13 逐字段 opt-in：LLM 只需给字段名数组，子密钥封装由工具完成
    // （密文构造必须是工具职责——与 grant_l1 同一原则，v1.0 曾让 LLM 自己 wrap，实际不可行）
    const rawFields = body.fields;
    const names: string[] = Array.isArray(rawFields)
      ? rawFields.map((f) => (typeof f === 'string' ? f : String((f as { field?: unknown })?.field ?? '')))
      : [];
    if (names.length === 0) {
      return { ok: false, error: 'grant_l3 需要 fields：要交付的见面层字段名数组（如 ["contact_wechat"]）。' };
    }
    if (names.length > 6) return { ok: false, error: 'grant_l3 一次最多交付 6 个字段。' };
    const bad = names.filter((n) => !(L3_FIELD_NAMES as readonly string[]).includes(n));
    if (bad.length) return { ok: false, error: `见面层字段名不认识：${bad.join('、')}。可用：${L3_FIELD_NAMES.join(' / ')}` };
    const recipientKx = opts.recipientKx;
    if (!recipientKx) {
      return { ok: false, error: 'grant_l3 缺少收件人协商公钥（请用 target_card_id 指定收件人）。' };
    }
    const key = session.keyProvider();
    const l3Key = key.layerKey('L3');
    const fields = names.map((name) => ({
      field: name,
      wrapped_key: toBase64(key.sealFor(recipientKx, l3FieldKey(l3Key, name))),
    }));
    const mine = s.list('cards/mine').filter((f) => f.endsWith('.json'));
    const myLatest = mine.length ? mine[mine.length - 1]!.replace(/\.json$/, '') : null;
    const fromCardId = (body.from_card_id as string | undefined) ?? myLatest;
    if (!fromCardId) return { ok: false, error: '你还没有签发任何卡片（sign_card），无法交付见面层。' };
    // 容器密钥随字段一起交付：它只能解出各字段密文，解不出未授权字段的明文
    const containerKey = toBase64(key.sealFor(recipientKx, l3ContainerKey(l3Key)));
    return {
      ok: true,
      recipientKx,
      body: { from_card_id: fromCardId, container_key: containerKey, fields },
    };
  }
  return { ok: true, body };
}

// ---------- 共享：信封构造与签名 ----------

/** 构造并签名一封消息信封（meta + sealed 消息体 + Ed25519 整体签名） */
export function buildSignedEnvelope(
  msgType: EnvelopeMsgType,
  body: Record<string, unknown>,
  opts: { targetCardId?: string; depth: unknown; recipientKx: Uint8Array },
  session: Session,
): MsgEnvelope {
  const key = session.keyProvider();
  const block: CipherBlock = sealMessageBody(body, opts.recipientKx, key);
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
    msg_type: msgType,
    ...(opts.targetCardId ? { target_card_id: opts.targetCardId } : {}),
    depth: opts.depth,
    algo: { sig: 'ed25519', aead: 'aes-256-gcm', kex: 'x25519' },
  };
  return {
    meta: meta as never,
    payload: block,
    signature: toBase64(key.sign(canonicalBytes({ meta, payload: block }))),
  };
}

export const sendEnvelopeTool = {
  name: 'send_envelope',
  description:
    '发送一封结构化信封给对方（D3：月老间仅结构化握手，v1 禁自由聊天）。' +
    '类型：upgrade_request(申请解锁L2；广场流为解锁L1) / grant_l1(一阶解锁授权·广场流密封交付) / grant_l2(授权) / topic_pack(考题包) / answer_card(回卷) / ' +
    'graduation_invite(毕业邀请) / grant_l3(见面层授权) / decline_silent(婉拒，v1建议不回复)。' +
    '消息体按类型经协议 schema 校验（v0.4），缺字段会明确报错并列出，不会静默发出畸形信封；' +
    'grant_l1 的密封钥匙由工具自动派生（传 card_fingerprint + requester_kx_public 即可）。',
  inputSchema: {
    msg_type: z.enum(ENVELOPE_TYPES),
    target_card_id: z.string().describe('对端卡片 ID'),
    body: z.record(z.unknown()).describe('消息体（各类型字段见协议 schema；topic_pack 的 followups ≤2）'),
    my_card_id: z.string().optional().describe('本方卡片 ID（缺省取最新一张）'),
  },
  handler: async (
    args: { msg_type: EnvelopeMsgType; target_card_id: string; body: Record<string, unknown>; my_card_id?: string },
    session: Session,
  ) => {
    const s = store();
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

    // 消息体补全（v0.4：grant_l1 的 sealed_key_l1 等密文字段由工具派生，LLM 不构造密文）
    const completed = completeMessageBody(args.msg_type, args.body, session, s, { recipientKx: theirKx });
    if (!completed.ok) return text(completed.error);
    // 补全后按协议 schema 校验（缺字段/畸形一律拒绝并说明，防 LLM 产出静默劣化）
    const bodyError = validateBody(args.msg_type, completed.body);
    if (bodyError) {
      return text(
        `消息体不合法（${args.msg_type}）：${bodyError}。\n\n` +
          `请按协议 schema 修正后重发；不要删改协议字段。`,
      );
    }
    // 出站泄露面审查（D15⑦）：考题会暴露主人自己在意的维度
    const leakWarning = checkOutboundLeak(args.msg_type, completed.body, s);
    if (leakWarning) return text(leakWarning);
    const env = buildSignedEnvelope(
      args.msg_type,
      completed.body,
      {
        targetCardId: args.target_card_id,
        depth: (myCard.meta as { depth: unknown }).depth,
        recipientKx: completed.recipientKx ?? theirKx,
      },
      session,
    );
    const linePath = `${LINES_DIR}/${dirNameFromKeyId((theirCard.meta as { owner_key_id: string }).owner_key_id)}`;
    const fileName = `${new Date().toISOString().replace(/[:.]/g, '')}-${args.msg_type}${ENV_FILE_EXT}`;
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


// ---------- receive_envelope / mailbox_pull 共用：信封路由（验签后） ----------

/**
 * 路由一封已验证的消息信封：拉黑检查 → 建线 → 解封 → 按 msg_type 分流。
 * receive_envelope（文件流）与 mailbox_pull（广场流）共用——两条信道一个实现（V9）。
 * 返回 MCP 工具结果（月老口吻的指引文本，宿主 LLM 据此决定下一步）。
 */
export function routeEnvelope(env: MsgEnvelope, session: Session) {
  const s = store();
  const lineDir = dirNameFromKeyId(env.meta.owner_key_id);
  const linePath = `${LINES_DIR}/${lineDir}`;
  const line = s.read<FateLine>(`${linePath}/state.json`);
  if (line?.blocked) {
    return text('（该发件人已被拉黑，信封不再呈报。）');
  }
  if (!line) {
    // 首封信 = 建线（match_card 换卡握手 / 广场敲门均适用）
    s.write(`${linePath}/state.json`, createLine(env.meta.card_id, lineDir, 'card_received'));
  }
  const lineNow = s.read<FateLine>(`${linePath}/state.json`)!;
  const lineId = lineNow.line_id;

  // 解封消息体（本方 X25519 私钥）
  const key = session.keyProvider();
  const opened = openMessageBody(env.payload, key);
  const body = opened.ok ? opened.body : null;

  switch (env.meta.msg_type) {
    case 'upgrade_request': {
      // 广场流判别（V6）：target_card_id 命中本方已贴广场卡、且一阶未解锁 → 敲门请求解锁 L1；
      // 否则为 L2 深聊请求（文件流，或一阶已解锁后的广场流续段）。
      const targetPlaza = env.meta.target_card_id ? findOwnPlazaCardById(s, env.meta.target_card_id) : null;
      const l1Granted = !!s.read<{ key_l1?: string }>(`${linePath}/layer-keys.json`)?.key_l1;
      if (targetPlaza && !l1Granted) {
        const fp = cardFingerprint(targetPlaza);
        const reqKx = (body as { requester_kx_public?: string } | null)?.requester_kx_public ?? '';
        return text(
          `对方通过广场看到你的轮廓，敲门请求解锁一阶名片。\n\n` +
            `对方地址：${env.meta.owner_key_id}\n附带信息：${JSON.stringify(body)}\n\n` +
            `**你的选择**：\n` +
            `同意 → send_via_server(msg_type="grant_l1", target_address="${env.meta.owner_key_id}", ` +
            `body={ card_fingerprint: "${fp}", requester_kx_public: "${reqKx}" })\n` +
            `不愿意 → 不回复即可（静默，对方收不到任何信号）。`,
        );
      }
      if (line) s.write(`${linePath}/state.json`, noteResponseReceived(line));
      return text(
        `对方请求解锁匹配层（深聊层）。\n\n附带信息：${JSON.stringify(body)}\n\n` +
          `**你的选择**：同意 → send_envelope(grant_l2，携带用对方公钥封装的 key_L2）；` +
          `不愿意 → 不回复即可（静默，对方收不到任何信号）。`,
      );
    }
    case 'grant_l1': {
      // 广场流一阶解锁（V6）：请求方已持有广场卡密文，只缺钥匙——解封即得 L1
      const b = body as GrantL1Body | null;
      if (!b?.sealed_key_l1) return text('grant_l1 消息体缺失（解封失败或信封被裁剪）。');
      const openedKey = key.openSealed(fromBase64(b.sealed_key_l1));
      if (!openedKey) return text('grant_l1 解封失败（非本方密钥或已篡改）。');
      const card = findCachedPlazaCardByFingerprint(s, b.card_fingerprint);
      if (!card) {
        return text('一阶钥匙已收到，但本地找不到对应的广场卡密文（浏览存证被清理了）——请重新 plaza_browse 后再 compare。');
      }
      // 层密钥落线（与 key_l2 合并——L1 先解锁、L2 后解锁的场景不能互相覆盖）
      const lineKeyPath = `${linePath}/layer-keys.json`;
      const existingKeys = s.read<Record<string, string>>(lineKeyPath) ?? {};
      s.write(lineKeyPath, { ...existingKeys, key_l1: toBase64(openedKey) });
      // 广场卡转为联系人卡（无 key_l1——compare 经层密钥兜底解密）
      const ownerDir = dirNameFromKeyId(card.meta.owner_key_id);
      s.write(`${CARDS_CONTACTS_DIR}/${ownerDir}/${card.meta.card_id}.json`, card);
      return text(
        `一阶名片已解锁——对方显式授权交付了钥匙（V6：广场流的"解锁一阶"是授权动作，不是文件易手）。\n\n` +
          `现在可以 compare(card_id="${card.meta.card_id}") 做完整比对了。\n` +
          `（对方看不到你读没读——拉取无回执，V9。）`,
      );
    }
    case 'grant_l2': {
      // 对方交付的 key_L2：用本方 kx 私钥解封
      const wrapped = fromBase64((body as { wrapped_key_l2: string }).wrapped_key_l2);
      const l2Key = key.openSealed(wrapped);
      if (!l2Key) return text('grant_l2 解封失败（非本方密钥或已篡改）。');
      const lineKeyPath = `${linePath}/layer-keys.json`;
      const existingKeys = s.read<Record<string, string>>(lineKeyPath) ?? {};
      s.write(lineKeyPath, { ...existingKeys, key_l2: toBase64(l2Key) }); // 合并：不清掉已解锁的 key_l1
      const l = s.read<FateLine>(`${linePath}/state.json`);
      if (l) s.write(`${linePath}/state.json`, enterRounds(noteResponseReceived(l)));
      return text('匹配层已解锁——现在可以 compare 做完整比对了。');
    }
    case 'topic_pack': {
      const l = s.read<FateLine>(`${linePath}/state.json`);
      if (l) s.write(`${linePath}/state.json`, noteResponseReceived(l));
      // 入站轮次记账（D11）：对方出题 → 我的 in 方向开一轮
      const rounds = loadLineRounds(s, lineDir, lineId);
      if (!rounds.in.current_topic) {
        const tb = body as {
          topic: string;
          followups?: string[];
          reason?: string;
          channel: 'owner' | 'yuelao';
        } | null;
        if (tb) {
          rounds.in = applyOpenTopic(rounds.in, {
            topic: tb.topic,
            followups: tb.followups ?? [],
            reason: tb.reason ?? '',
            channel: tb.channel,
          });
          saveLineRounds(s, lineDir, rounds);
        }
      }
      return text(
        `对方月老传来一道考题（第 ${(body as { round: number }).round} 轮）：\n\n` +
          `主题：${(body as { topic: string }).topic}\n追问：${((body as { followups: string[] }).followups ?? []).join('；') || '无'}\n` +
          `出题理由：${(body as { reason: string }).reason}\n通道：${(body as { channel: string }).channel === 'owner' ? '主人想问的' : '月老建议的'}\n\n` +
          `请按三态应答（round(action="respond", direction="in", card_id="${lineId}", status=... ) 记账）：` +
          `现场可答 → status=answered；超出画像 → status=ask_master（带回去问主人）；暂时不想答 → status=deferred（不判红旗）。\n` +
          `你对本题有对等反问权（D11 对称出题权）。`,
      );
    }
    case 'answer_card': {
      const l = s.read<FateLine>(`${linePath}/state.json`);
      if (l) s.write(`${linePath}/state.json`, noteResponseReceived(l));
      // 出站轮次记账：对方回卷 → 记进我的 out 方向（轮次号不匹配则不动，交 round 工具处理）
      const rounds = loadLineRounds(s, lineDir, lineId);
      const ab = body as {
        round: number;
        topic_ref: string;
        status: 'answered' | 'ask_master' | 'deferred';
        answer?: string;
        note?: string;
      } | null;
      if (rounds.out.current_topic && ab && ab.round === rounds.out.round_no) {
        try {
          rounds.out = applyAnswer(rounds.out, {
            round: ab.round,
            topic_ref: ab.topic_ref,
            status: ab.status,
            answer: ab.answer,
            note: ab.note,
          });
          saveLineRounds(s, lineDir, rounds);
        } catch {
          /* 主题不符等：保持原状，由主人用 round 工具处理 */
        }
      }
      return text(
        `对方已回答你出的题（第 ${(body as { round: number }).round} 轮，状态：${(body as { status: string }).status}）：\n\n` +
          `${(body as { answer?: string }).answer ?? (body as { note?: string }).note ?? '（对方选择暂不回应——婉答也是信息，但不自动判为红旗）'}\n\n` +
          `按 D11 收尾这一轮：round(action="close", card_id="${lineId}", incremental=<本轮是否有新信息>, dimensions=[...])。`,
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
      const b = body as GrantL3Body | null;
      const fields = b?.fields ?? [];
      if (fields.length === 0) return text('grant_l3 消息体缺失（解封失败或信封被裁剪）。');
      const lineKeyPath = `${linePath}/layer-keys.json`;
      const existing = s.read<Record<string, string>>(lineKeyPath) ?? {};
      const granted: string[] = [];
      const failed: string[] = [];
      // 容器密钥（v1.1）：只能解出各字段密文，解不出未授权字段的明文
      if (b?.container_key) {
        const ck = key.openSealed(fromBase64(b.container_key));
        if (ck) existing.l3_container = toBase64(ck);
      }
      for (const f of fields) {
        const k = key.openSealed(fromBase64(f.wrapped_key));
        if (k) {
          existing[`l3_${f.field}`] = toBase64(k);
          granted.push(f.field);
        } else {
          failed.push(f.field);
        }
      }
      s.write(lineKeyPath, existing);
      // 手账：见面层解锁 = 毕业
      const l = s.read<FateLine>(`${linePath}/state.json`);
      if (l) s.write(`${linePath}/state.json`, graduate(l));

      const fieldLabel: Record<string, string> = {
        contact_wechat: '微信号',
        contact_phone: '手机号',
        real_name: '真实姓名',
        employer_category: '工作单位大类',
        hangout_areas: '常去区域',
        photo_refs: '照片引用',
      };
      return text(
        `**见面层已按字段解锁**：${granted.map((f) => fieldLabel[f] ?? f).join('、') || '（无）'}\n` +
          (failed.length ? `未能解封：${failed.join('、')}（密钥不匹配或信封被裁剪）\n` : '') +
          `未授权的字段仍是他拿到的密文——解不开（逐字段密钥，D13）。\n\n` +
          `**红线交到你们自己手里了**——此后月老只做见面复盘，不介入你们两人的对话。\n\n` +
          `看对方给的联系方式：view_l3(card_id="<对方卡片 ID>")。\n` +
          `安全提示：任何涉及金钱的请求，立即警惕；第一次见面选公共场所、自己往返。`,
      );
    }
    case 'decline_silent':
      return text('（对方婉拒。静默处理，不向你的主人展示任何被拒信号——D4）');
    default:
      return text(`未支持的信封类型：${env.meta.msg_type}`);
  }
}

export const receiveEnvelopeTool = {
  name: 'receive_envelope',
  description:
    '接收并处理对方发来的信封：验签 → 按类型路由（换卡/升级请求/授权/考题/回卷/毕业邀请/婉拒）。' +
    '拉黑线的一切信封不呈报。',
  inputSchema: {
    file_content: z.string().describe('对方 .hongxian-env 文件 JSON 全文'),
  },
  handler: async (args: { file_content: string }, session: Session) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.file_content);
    } catch {
      return text('信封不是合法 JSON。');
    }
    const check = MsgEnvelope.safeParse(parsed);
    if (!check.success) return text(`信封结构不合法：${check.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    const env = check.data;
    // 验签（卡自带公钥）
    const sigOk = verifyDetached(
      fromBase64(env.signature),
      canonicalBytes({ meta: env.meta, payload: env.payload }),
      fromBase64(env.meta.sig_public),
    );
    if (!sigOk) return text('信封验签失败——可能被伪造或篡改，拒绝处理。');
    return routeEnvelope(env, session);
  },
};

// ---------- ledger（姻缘线手账） ----------

export const ledgerTool = {
  name: 'ledger',
  description:
    '红线手账：姻缘线列表（已递出/已回音/深聊中/已毕业/未通过/已拉黑）、拉黑建议（3 次未回应）、备注、' +
    '状态标记（no_follow_up=本地记"未通过"，graduate=见面层已解锁）、历次报告（reports）。',
  inputSchema: {
    action: z.enum(['list', 'block', 'unblock', 'note', 'no_follow_up', 'graduate', 'reports']).default('list'),
    line_id: z.string().optional().describe('姻缘线 ID（block/unblock/note/状态标记/reports 时）'),
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
        .map((l) => {
          const lastReport = latestReportTier(s, l.owner_dir);
          return (
            `- ${l.line_id.slice(0, 8)}… [${l.status}]${l.blocked ? '（已拉黑）' : ''}` +
            ` 轮次${l.rounds_total}${l.unresponded_upgrades ? ` 未回应${l.unresponded_upgrades}` : ''}` +
            `${lastReport ? ` 最近结论：${lastReport}` : ''}`
          );
        })
        .join('\n');
      const suggestions = view.block_suggestions.length
        ? `\n\n**拉黑建议**（连续 ${view.block_suggestions[0]!.unresponded} 次未回应）：${view.block_suggestions.map((b) => b.line_id.slice(0, 8)).join('、')}——拉黑后其一切信封不再呈报，且不通知对方。`
        : '';
      return text(`姻缘线 ${view.total} 条：\n${detail || '（还没有线）'}${suggestions}`);
    }
    if (!args.line_id) return text('请提供 line_id。');
    const lineIdArg = args.line_id;
    const line = lines.find((l) => l.line_id === lineIdArg || l.line_id.startsWith(lineIdArg));
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
    if (args.action === 'no_follow_up') {
      // 本地认知"未通过"——对方永远收不到任何信号（D4 静默）
      s.write(path, markNoFollowUp(line));
      return text('已标记为「暂时没有下文」（只存本机，对方收不到任何信号——他要等到自然淡去）。');
    }
    if (args.action === 'graduate') {
      s.write(path, graduate(line));
      return text('已标记为「已毕业」：见面层已解锁，此后月老只做复盘，不介入你们两人的对话。');
    }
    if (args.action === 'reports') {
      const list = listReports(s, line.owner_dir);
      if (list.length === 0) return text('这条线还没有比对记录（compare 一次就会留档）。');
      return text(
        `这条线的比对记录（${list.length} 次，最新在前）：\n\n` +
          list
            .slice(0, 10)
            .map((r) => `- ${r.at.slice(0, 16).replace('T', ' ')} → ${r.tier}${r.l2_unlocked ? '' : '（仅一阶）'}`)
            .join('\n') +
          `\n\n档位变化本身就是信息：解锁更多层后结论通常会变，别用旧报告下新判断。`,
      );
    }
    if (args.action === 'note') {
      if (!args.note) return text('请提供备注内容。');
      s.write(path, { ...line, notes: [...line.notes, `${new Date().toISOString().slice(0, 10)} ${args.note}`] });
      return text('备注已记录（只存本机）。');
    }
    return text('未知 action。');
  },
};

interface ReportEntry {
  at: string;
  tier: string;
  l2_unlocked: boolean;
}

function listReports(s: ReturnType<typeof store>, ownerDir: string): ReportEntry[] {
  const dir = `${LINES_DIR}/${ownerDir}/reports`;
  const out: ReportEntry[] = [];
  for (const f of s.list(dir)) {
    if (!f.endsWith('.json')) continue;
    const r = s.read<ReportEntry>(`${dir}/${f}`);
    if (r?.at) out.push(r);
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

function latestReportTier(s: ReturnType<typeof store>, ownerDir: string): string | null {
  return listReports(s, ownerDir)[0]?.tier ?? null;
}

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
