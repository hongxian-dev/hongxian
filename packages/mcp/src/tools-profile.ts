/**
 * MCP Tools · 画像链路：interview / sign_card / export_card / import_card
 *
 * 薄壳原则（技术详设原则 4）：这里只做参数解析、会话门闩、结果包装；
 * 领域逻辑全部在 @hongxian/core。
 */

import { z } from 'zod';
import {
  assembleProfile,
  buildDepth,
  buildRecap,
  computeCompleteness,
  confirmRecap,
  createInterviewState,
  rejectRecap,
  submitStageAnswers,
  validateDealbreakers,
  validateVocabFields,
  assertSignable,
  assertL3Signable,
  resignCard,
  decryptLayer,
  signMatchCard,
  verifyMatchCard,
  type InterviewState,
} from '@hongxian/core';
import { CARD_FILE_EXT, L3_FIELD_NAMES, fromBase64, toBase64 } from '@hongxian/schema';
import type { Session } from './session.js';
import { CONSENT_TEXT, needsConsent, readConsent, writeConsent } from './consent.js';
import { reportMetric } from './counter.js';
import { store } from './context.js';
import { LockedError, ConsentError } from './errors.js';

const PROFILE_DIR = 'profile';
const CARDS_MINE_DIR = 'cards/mine';
const CARDS_CONTACTS_DIR = 'cards/contacts';
/** 见面层字段值（本人所有，签发/重签时复用；只存本机） */
const L3_VALUES_PATH = 'profile/l3-values.json';

/**
 * owner_key_id（base64）→ 目录名（hex）。
 * base64 含 '/' '+' '=' 字符，直接做目录名会被解析为嵌套路径（Windows/Unix 均如此）——
 * hex 是唯一安全的目录名编码（64 字符，无特殊字符）。
 */
export function dirNameFromKeyId(ownerKeyIdB64: string): string {
  return Buffer.from(ownerKeyIdB64, 'base64').toString('hex');
}

// ---------- interview（D1 渐进访谈 + S1 知情同意） ----------

export const interviewTool = {
  name: 'interview',
  description:
    '渐进式建画像（三次会话：硬事实→偏好生活方式→价值观故事）。每次会话结束必须复述确认，' +
    '用户确认后才写入。首次调用返回知情同意书（含 ≥18 周岁声明）。' +
    '画像修订走 action="update"（D3① 续访）：同样要复述确认，确认后可重签名片（sign_card resign_of）。',
  inputSchema: {
    action: z
      .enum(['start', 'consent', 'confirm_mnemonic', 'unlock', 'submit', 'update', 'confirm', 'reject', 'status'])
      .describe(
        'start=开始/查看当前状态；consent=确认知情同意与年龄；confirm_mnemonic=确认已抄写恢复短语；' +
          'unlock=用恢复短语解锁；submit=提交本次会话答案；update=修订已确认阶段的画像（续访）；' +
          'confirm=确认复述稿；reject=否决复述稿重聊',
      ),
    age_attested: z.boolean().optional().describe('consent 时必填：确认已年满 18 周岁'),
    mnemonic: z.string().optional().describe('24 词中文恢复短语（confirm_mnemonic/unlock 时）'),
    stage: z.enum(['facts', 'preferences', 'values']).optional().describe('submit/update 时：本次会话阶段'),
    answers: z.record(z.unknown()).optional().describe('submit/update 时：本阶段结构化答案'),
  },
  handler: async (args: {
    action: string;
    age_attested?: boolean;
    mnemonic?: string;
    stage?: 'facts' | 'preferences' | 'values';
    answers?: Record<string, unknown>;
  }, session: Session) => {
    const s = store();

    switch (args.action) {
      case 'start': {
        if (!session.initialized) {
          return text(CONSENT_TEXT + '\n\n（确认以上条款并已年满 18 周岁，请调用 interview(action="consent", age_attested=true)）');
        }
        if (!session.unlocked) {
          return text('欢迎回来。请提供你的 24 词恢复短语解锁（interview(action="unlock", mnemonic="...")）。');
        }
        const state = loadState(s);
        return text(
          `当前进度：已完成 ${state.confirmed_stages.join('、') || '无'}，正在「${state.stage}」阶段。\n` +
            (state.pending_recap ? '有一份复述稿等待你确认（confirm / reject）。' : '可以开始本次会话的提问了。'),
        );
      }

      case 'consent': {
        if (args.age_attested !== true) {
          return text('使用本工具需要确认已年满 18 周岁（age_attested=true）。未成年人保护在婚恋场景零容忍。');
        }
        writeConsent(s);
        const { mnemonic } = await session.initIdentity();
        return text(
          `同意已记录。你的身份已在这台设备上生成。\n\n` +
            `**恢复短语（24 词）——这是你在这台设备上的唯一身份，请用纸笔抄写并妥善保管：**\n\n${mnemonic}\n\n` +
            `抄写完成后请调用 interview(action="confirm_mnemonic", mnemonic="<你抄写的短语>）——` +
            `我会逐字核对。丢失短语 = 身份无法恢复（设计如此，没有服务器可以找回）。`,
        );
      }

      case 'confirm_mnemonic': {
        if (!args.mnemonic) return text('请提供你抄写的 24 词短语。');
        const ok = await session.unlockOrDerive(args.mnemonic);
        return ok
          ? text('短语核对无误，身份已解锁。我们现在开始第一次访谈——硬事实。')
          : text('短语核对失败。请再仔细核对一遍（顺序、用字都要一致），或重新抄写。');
      }

      case 'unlock': {
        if (!args.mnemonic) return text('请提供 24 词恢复短语。');
        const ok = await session.unlockOrDerive(args.mnemonic);
        return ok ? text('解锁成功。' + statusLine(loadState(s))) : text('短语不正确，解锁失败。');
      }

      case 'submit':
      case 'update': {
        requireUnlocked(session);
        requireConsent(s);
        if (!args.stage || !args.answers) return text('请提供 stage 与 answers。');
        const state = loadState(s);
        if (args.action === 'update') {
          // 续访（D3①）：只允许修订已确认过的阶段，避免"跳过访谈直接改画像"
          if (!state.confirmed_stages.includes(args.stage)) {
            return text(`「${args.stage}」阶段还没完成过，先走正常的 submit 流程。`);
          }
        }
        // 负面清单与受控词表的前置校验（防弱模型产出劣质数据）
        if (args.stage === 'preferences' && Array.isArray(args.answers.dealbreakers)) {
          const v = validateDealbreakers(args.answers.dealbreakers as never);
          if (!v.valid) return text(`答案需要修正：\n${v.errors.join('\n')}`);
        }
        if (args.stage === 'facts' && Array.isArray(args.answers.interests)) {
          const v = validateVocabFields({ interests: args.answers.interests as never });
          if (!v.valid) return text(`答案需要修正：\n${v.errors.join('\n')}`);
        }
        if (args.stage === 'preferences' && Array.isArray(args.answers.values_tags)) {
          const v = validateVocabFields({ values_tags: args.answers.values_tags as never });
          if (!v.valid) return text(`答案需要修正：\n${v.errors.join('\n')}`);
        }
        if (args.stage === 'values' && Array.isArray(args.answers.values_qa)) {
          const v = validateVocabFields({ values_qa: args.answers.values_qa });
          if (!v.valid) return text(`答案需要修正：\n${v.errors.join('\n')}`);
        }
        const recap = buildRecap(args.stage, args.answers as never);
        const next = submitStageAnswers(state, args.stage, args.answers as never, recap);
        saveState(s, next);
        return text(
          `${recap}\n\n（复述稿基于你的原话整理。确认请调用 interview(action="confirm")；` +
            `有不对的地方调用 interview(action="reject") 我们重聊。）`,
        );
      }

      case 'confirm': {
        requireUnlocked(session);
        const state = loadState(s);
        if (!state.pending_recap) return text('当前没有待确认的复述稿。');
        const updatedStage = state.pending_recap.stage;
        const wasConfirmed = state.confirmed_stages.includes(updatedStage);
        const next = confirmRecap(state);
        saveState(s, next);
        const done = next.confirmed_stages.length;
        if (wasConfirmed) {
          return text(
            `画像已更新（${updatedStage} 阶段）。\n\n` +
              `已经发出去的旧卡片仍是旧内容——如果你想让今后的交换用上新画像，` +
              `调用 sign_card(resign_of="<旧卡 ID>") 重签一版（version+1，旧版本自动作废）。`,
          );
        }
        const msg =
          done === 3
            ? '三个阶段全部完成，画像已锁定。现在可以签发你的匹配卡了（sign_card）。'
            : `已写入。下一阶段：${next.stage}。`;
        return text(msg);
      }

      case 'reject': {
        requireUnlocked(session);
        const state = loadState(s);
        if (!state.pending_recap) return text('当前没有待确认的复述稿。');
        saveState(s, rejectRecap(state));
        return text('好，那部分我们重聊——是我哪里理解偏了？');
      }

      case 'status':
        return text(statusLine(loadState(s)));

      default:
        return text('未知 action。');
    }
  },
};

// ---------- sign_card（S4） ----------

export const signCardTool = {
  name: 'sign_card',
  description:
    '用已确认的画像签发加密匹配卡（三层：公开/匹配/私密，各自独立密钥 + Ed25519 签名）。签发前展示"对方将看到什么"。' +
    '见面层（L3）字段逐字段独立加密：只给 contact_wechat 时，对方拿到的子密钥解不开 contact_phone（D13）。' +
    '画像更新后可 resign_of=<旧卡 ID> 重签，version+1 且旧版本自动作废。',
  inputSchema: {
    l3: z
      .record(z.unknown())
      .optional()
      .describe(
        '见面层字段（可选，逐字段）：contact_wechat / contact_phone / real_name / ' +
          'employer_category / hangout_areas（数组）/ photo_refs（数组）。不传即不带见面层。',
      ),
    resign_of: z.string().optional().describe('重签的旧卡 ID（画像更新后用；version 自动 +1）'),
  },
  handler: async (args: { l3?: Record<string, unknown>; resign_of?: string }, session: Session) => {
    requireUnlocked(session);
    requireConsent(store());
    const s = store();
    const state = loadState(s);
    if (state.confirmed_stages.length < 3) {
      return text(`画像尚未完成（已完成 ${state.confirmed_stages.join('、') || '无'} / 共三阶段）。完成后再签卡。`);
    }
    const profile = assembleProfile(state);
    const l1: Record<string, unknown> = {
      ...profile.l1,
      age_attested: true,
      econ_signal: ['undisclosed'],
    };
    const l2: Record<string, unknown> = profile.l2;
    try {
      assertSignable(l1, l2);
    } catch (e) {
      return text(`画像还不能签卡：${(e as Error).message}`);
    }
    // 见面层：本次显式传入优先，否则沿用上次存下的字段（续签不必重填）
    const storedL3 = s.read<Record<string, unknown>>(L3_VALUES_PATH);
    const l3 = args.l3 && Object.keys(args.l3).length ? args.l3 : storedL3 ?? undefined;
    if (l3) {
      const unknown = Object.keys(l3).filter((k) => !(L3_FIELD_NAMES as readonly string[]).includes(k));
      if (unknown.length) {
        return text(`见面层字段名不认识：${unknown.join('、')}。可用字段：${L3_FIELD_NAMES.join(' / ')}`);
      }
      try {
        assertL3Signable(l3);
      } catch (e) {
        return text(`见面层字段不合法：${(e as Error).message}`);
      }
      s.write(L3_VALUES_PATH, l3);
    }
    const completeness = computeCompleteness({ l1, l2 });
    const settings = session.settings();
    const depth = buildDepth(state.confirmed_stages.length * 3, completeness, settings.model_tier);
    const input = { depth, l1: l1 as never, l2: l2 as never, l3: l3 as never };

    let card;
    let resignNote = '';
    if (args.resign_of) {
      const old = s.read<{ meta: { version: number; card_id: string } }>(`${CARDS_MINE_DIR}/${args.resign_of}.json`);
      if (!old) return text(`找不到要重签的旧卡 ${args.resign_of}。`);
      card = resignCard(old as never, input, session.keyProvider());
      resignNote = `\n\n（重签自 ${args.resign_of.slice(0, 8)}…，version ${old.meta.version} → ${card.meta.version}：旧版本自动作废，请把新卡重新交给对方。）`;
    } else {
      card = signMatchCard(input, session.keyProvider());
    }
    const path = `${CARDS_MINE_DIR}/${card.meta.card_id}.json`;
    s.write(path, card);

    // opt-in 计数（E7：默认关闭=零出网）
    void reportMetric(settings.opt_in_counter, 'card_signed', String(l1.gender));

    const l3Note = l3
      ? `\n见面层字段（逐字段独立加密，对方需被逐项授权）：${Object.keys(l3).join('、')}`
      : '\n见面层：本次未携带（到毕业轮再签也不迟）';
    return text(
      `匹配卡已签发并存入本机：${path}\n\n` +
        `**对方将看到的名片区（一阶）**：\n` +
        `昵称 ${l1.nickname} · ${l1.age_band} 岁段 · ${(l1.city as { name: string }).name} · ${l1.job_category} · ${l1.marital_status}\n` +
        `兴趣：${(l1.interests as string[]).join('、')}\n一句话：${l1.bio}\n` +
        `匹配层已加密随卡携带，未经双方同意对方解不开。${l3Note}${resignNote}\n\n` +
        `（导出给对方：export_card）`,
    );
  },
};

// ---------- export_card（S5：扫码/传文件） ----------

export const exportCardTool = {
  name: 'export_card',
  description: '导出一张已签发的匹配卡文件（.hongxian-card JSON）+ 交换确认码（QR 内容：防调包校验）。名片本体走文件，QR 只传哈希。',
  inputSchema: {
    card_id: z.string().optional().describe('卡 ID；缺省导出最新一张'),
  },
  handler: async (args: { card_id?: string }, session: Session) => {
    requireUnlocked(session);
    const files = store().list(CARDS_MINE_DIR).filter((f) => f.endsWith('.json'));
    if (files.length === 0) return text('你还没有签发过匹配卡（sign_card）。');
    const target = args.card_id ? `${args.card_id}.json` : files[files.length - 1]!;
    const card = store().read(`${CARDS_MINE_DIR}/${target}`);
    if (!card) return text(`找不到卡片 ${args.card_id}`);
    // QR 内容 = 交换确认码（card 指纹），名片本体走文件（技术详设 §2：卡片几 KB 超 QR 容量）
    const { cardFingerprint } = await import('@hongxian/core');
    const fingerprint = cardFingerprint(card as never);
    return text(
      `卡片文件内容（请保存为 <对方昵称>${CARD_FILE_EXT} 并通过你们商定的方式传给对方）：\n\n` +
        '```json\n' + JSON.stringify(card, null, 2) + '\n```\n\n' +
        `交换确认码（QR 内容，对方导入时核对防调包）：${fingerprint}`,
    );
  },
};

// ---------- import_card（S5：验签 + TTL + 入库） ----------

export const importCardTool = {
  name: 'import_card',
  description: '导入对方传来的匹配卡文件：验签（失败整卡作废）→ TTL 检查 → 入库。成功后返回一阶名片区（对方可见内容）。',
  inputSchema: {
    file_content: z.string().describe('对方 .hongxian-card 文件的 JSON 全文'),
  },
  handler: async (args: { file_content: string }, session: Session) => {
    requireUnlocked(session);
    requireConsent(store());
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.file_content);
    } catch {
      return text('文件不是合法 JSON——可能传输损坏。');
    }
    const result = verifyMatchCard(parsed);
    if (!result.valid || !result.card) {
      return text(`卡片未通过验证：\n${result.errors.join('\n')}`);
    }
    const card = result.card;
    // 一阶明文：key_L1 随卡携带（Schema §8 拍板①），任何持卡者可解出公开层
    let l1Text = '（卡片未携带 key_L1，无法读取名片区）';
    if (card.key_l1) {
      const opened = decryptLayer(card, 'L1', fromBase64(card.key_l1));
      if (opened.ok) {
        const l1 = opened.payload as Record<string, unknown>;
        l1Text = `昵称 ${l1.nickname} · ${l1.age_band} 岁段 · ${(l1.city as { name: string }).name} · ${l1.job_category} · ${l1.marital_status}\n兴趣：${(l1.interests as string[]).join('、')}\n一句话：${l1.bio}`;
      }
    }
    const dir = `${CARDS_CONTACTS_DIR}/${dirNameFromKeyId(card.meta.owner_key_id)}`;
    store().write(`${dir}/${card.meta.card_id}.json`, card);
    // 建姻缘线（D15⑥）
    const linePath = `lines/${dirNameFromKeyId(card.meta.owner_key_id)}`;
    if (!store().exists(`${linePath}/state.json`)) {
      const { createLine } = await import('@hongxian/core');
      store().write(
        `${linePath}/state.json`,
        createLine(card.meta.card_id, dirNameFromKeyId(card.meta.owner_key_id), 'card_received'),
      );
    }
    const settings = session.settings();
    void reportMetric(settings.opt_in_counter, 'card_imported', 'none');
    return text(
      `卡片验证通过${result.expired ? '（注意：已过期，建议请对方重签）' : ''}。\n\n` +
        `**对方的一阶名片区**：\n${l1Text}\n\n` +
        `匹配层仍加密。需要双方同意后才能解锁（send_envelope 发起升级请求）。`,
    );
  },
};

// ---------- 共享辅助 ----------

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

function requireUnlocked(session: Session): void | string {
  if (!session.unlocked) throw new LockedError();
}

function requireConsent(s: { exists: (p: string) => boolean }): void {
  if (needsConsent(s as never)) throw new ConsentError();
}

// ---------- 画像状态持久化（无状态工具 + 本地文件状态，D15 架构约束） ----------

const STATE_PATH = `${PROFILE_DIR}/interview-state.json`;

export function loadState(s: { read: <T>(p: string) => T | null }): InterviewState {
  return s.read<InterviewState>(STATE_PATH) ?? createInterviewState();
}

export function saveState(s: { write: (p: string, d: unknown) => void }, state: InterviewState): void {
  s.write(STATE_PATH, state);
}

function statusLine(state: InterviewState): string {
  return `画像进度：${state.confirmed_stages.join('、') || '尚未开始'}（当前阶段：${state.stage}）`;
}
