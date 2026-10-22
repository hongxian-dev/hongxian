/**
 * MCP Tools · 平台接入（M1.3）：plaza_browse / plaza_publish / send_via_server / mailbox_pull
 *
 * 工程设计 V1/V6/V8/V9 的月老侧落地：
 * - plaza_browse：哑管道拉池 + 本地验签过滤 + 存证。只见轮廓，不见内容。
 * - plaza_publish：本方匹配卡 → plaza_card 变体（剥离 key_l1）贴上服务端。
 * - send_via_server：经服务端定向投递。确认只到"已入信箱"——无回执、无 presence（V9）。
 * - mailbox_pull：POP3 式拉取（拉取即删）。无推送——你想知道有没有信，只能自己来问。
 *
 * 铁律：一切内容都是密文；服务端只存取转发。两条信道（文件/服务端）共用
 * tools-exchange 的 completeMessageBody / buildSignedEnvelope / routeEnvelope。
 */

import { z } from 'zod';
import { cardFingerprint, filterPlazaPool, noteResponseReceived, noteTokensUsed, noteUpgradeSent, toPlazaCard } from '@hongxian/core';
import {
  DeclaredFilters,
  REPORT_FLAG_THRESHOLD,
  REPORT_REASONS,
  canonicalBytes,
  fromBase64,
  MsgEnvelope,
  parseAddress,
  type MatchCardEnvelope,
} from '@hongxian/schema';
import { verifyDetached } from '@hongxian/crypto';
import { reportMetric } from './counter.js';
import { store } from './context.js';
import type { Session, Settings } from './session.js';
import { dirNameFromKeyId } from './tools-profile.js';
import { loadMyProfile } from './profile-view.js';
import {
  appendHistory,
  browsePlaza,
  deliverEnvelope,
  deleteMailboxItem,
  ensureRegistered,
  fetchInstanceStats,
  fetchReportSummary,
  loadHistory,
  loadRegistration,
  normalizeInstanceUrl,
  publishPlazaCard,
  pullMailbox,
  reportAbuse,
  withdrawPlazaCard,
  PULLED_PATH,
  SEEN_CARDS_PATH,
} from './server-client.js';
import {
  ENVELOPE_TYPES,
  buildSignedEnvelope,
  checkOutboundLeak,
  completeMessageBody,
  guardTopicBudget,
  routeEnvelope,
  validateBody,
  type EnvelopeMsgType,
} from './tools-exchange.js';
import {
  PLAZA_MINE_DIR,
  blockedOpaqueIds,
  findCachedPlazaCardById,
  findContactCardById,
  listOwnPlazaCards,
  saveCachedPlazaCard,
  saveOwnPlazaCard,
} from './plaza-store.js';
import type { FateLine } from '@hongxian/core';

const LINES_DIR = 'lines';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

// ---------- 共用：实例地址解析 ----------

function resolveInstance(
  s: ReturnType<typeof store>,
  explicit?: string,
): { ok: true; instance: string } | { ok: false; error: string } {
  const raw = explicit ?? s.read<Settings>('settings.json')?.plaza_instance;
  if (!raw) {
    return {
      ok: false,
      error:
        '尚未配置服务端地址。自托管一条龙：docker compose up 起服务后，把地址（如 http://localhost:8787）' +
        '传给任意广场工具的 server 参数——我会记住它，之后不用每次带。',
    };
  }
  const norm = normalizeInstanceUrl(raw);
  if (!norm) return { ok: false, error: `服务端地址不合法：${raw}（需以 http:// 或 https:// 开头）` };
  return { ok: true, instance: norm };
}

/** 显式传入的实例地址持久化到 settings（月老的口径：用户说连哪，就连哪） */
function persistInstance(session: Session, instance: string): void {
  if (session.settings().plaza_instance !== instance) {
    session.updateSettings({ plaza_instance: instance });
  }
}

function instanceHost(instance: string): string {
  try {
    return new URL(instance).hostname;
  } catch {
    return instance;
  }
}

/** 手账更新（与 send_envelope 同口径；grant_l1 计入"已回音"——应答敲门） */
function noteSentEnvelope(
  s: ReturnType<typeof store>,
  recipientOpaqueId: string,
  msgType: EnvelopeMsgType,
  budgetTokens = 0,
): void {
  const linePath = `${LINES_DIR}/${dirNameFromKeyId(recipientOpaqueId)}`;
  const line = s.read<FateLine>(`${linePath}/state.json`);
  if (!line) return; // 尚无姻缘线（如首次打招呼前的异常序）——不强行建线
  const updated =
    msgType === 'upgrade_request' || msgType === 'topic_pack' || msgType === 'graduation_invite'
      ? noteUpgradeSent(line)
      : msgType === 'grant_l1' || msgType === 'grant_l2' || msgType === 'answer_card'
        ? noteResponseReceived(line)
        : line;
  s.write(`${linePath}/state.json`, budgetTokens > 0 ? noteTokensUsed(updated, budgetTokens) : updated);
}

// ---------- 共用：声明式圈层（D8 / Schema v0.5） ----------

/**
 * 从本方画像 L1 派生圈层声明：缺哪项就不声明哪项——不猜、不补默认值。
 * 城市取 L1 的市级国标码（到市为止），性别方向取 L1 的 gender/seeking。
 */
function deriveDeclaredFilters(
  s: ReturnType<typeof store>,
  overrides?: Record<string, unknown>,
): { ok: true; filters: DeclaredFilters } | { ok: false; error: string } {
  const l1 = loadMyProfile(s)?.l1 ?? {};
  const base: Record<string, unknown> = {};
  if (typeof l1.gender === 'string') base.gender = l1.gender;
  if (typeof l1.seeking === 'string') base.seeking = l1.seeking;
  const cityCode = (l1.city as { code?: string } | undefined)?.code;
  if (typeof cityCode === 'string' && /^\d{6}$/.test(cityCode)) base.city = cityCode;
  if (typeof l1.age_band === 'string') base.age_band = l1.age_band;
  base.visible_to = 'all';
  const merged = { ...base, ...(overrides ?? {}) };
  const parsed = DeclaredFilters.safeParse(merged);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        `圈层声明不合法：${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('；')}\n\n` +
        `可用字段：gender(male|female) / seeking(male|female) / city(6 位国标码) / age_band / visible_to(all|same_city|same_age_band)。`,
    };
  }
  return { ok: true, filters: parsed.data };
}

/** 圈层声明的可读展开（贴卡前逐项念给主人听——D1④ 可见性提示的广场版） */
function describeDeclared(filters: DeclaredFilters, isMine: boolean): string {
  const rows: string[] = [];
  const who = isMine ? '你声明要公开' : '对方声明公开';
  if (filters.gender) rows.push(`${who}：性别 ${filters.gender}`);
  if (filters.seeking) rows.push(`${who}：想认识 ${filters.seeking}`);
  if (filters.city) rows.push(`${who}：城市代码 ${filters.city}`);
  if (filters.age_band) rows.push(`${who}：年龄段 ${filters.age_band}`);
  const vis =
    filters.visible_to === 'same_city'
      ? '只对同城可见'
      : filters.visible_to === 'same_age_band'
        ? '只对同年龄段可见'
        : '不限';
  rows.push(`${who}：可见范围 ${vis}`);
  return rows.join('\n');
}

// ---------- plaza_browse（哑管道浏览 + 本地过滤 + 存证） ----------

export const plazaBrowseTool = {
  name: 'plaza_browse',
  description:
    '浏览广场：拉取全量卡池，本地验签 + 圈层过滤（去自/去黑/去重/TTL/同城/年龄段/方向）。' +
    '你看到的是"有人在"的轮廓（opaque_id、公钥、TTL、指纹）+ 对方自己声明要公开的圈层条件——' +
    '看不到昵称、职业、照片等任何画像内容。' +
    '兴趣触发用 send_via_server(upgrade_request) 敲门，等对方显式授权（grant_l1）才看得见名片。' +
    '无在线状态、无推荐、无排序——一切分拣在本地（哑管道）。',
  inputSchema: {
    server: z.string().optional().describe('服务端地址（如 http://localhost:8787）；缺省用已配置实例'),
    cursor: z.string().optional().describe('分页游标（上次返回的 next_cursor）'),
    my_filters: z
      .record(z.unknown())
      .optional()
      .describe(
        '拉取条件圈（D8）覆盖：缺省按你的画像自动取 同城/年龄段/性别方向；' +
          '显式传 {city:"310000"} 之类可临时收窄或放宽；传 {} 表示不筛（看全量）',
      ),
    respect_visibility: z.boolean().optional().describe('是否尊重对方"只对同城/同年龄段可见"的声明（默认 true）'),
  },
  handler: async (
    args: { server?: string; cursor?: string; my_filters?: Record<string, unknown>; respect_visibility?: boolean },
    session: Session,
  ) => {
    const s = store();
    const resolved = resolveInstance(s, args.server);
    if (!resolved.ok) return text(resolved.error);
    const { instance } = resolved;
    if (args.server) persistInstance(session, instance);

    // 拉取条件圈：显式传入即生效并记住；未传则用记住的声明；都没有 = 不筛（看全量）。
    // 刻意**不**从画像自动派生——月老不能替主人决定"只看同城"，
    // 那会让两个没声明的人互相看不见，是最坏的产品事故。
    let myFilters: DeclaredFilters | undefined;
    if (args.my_filters !== undefined) {
      if (Object.keys(args.my_filters).length === 0) {
        session.updateSettings({ plaza_circle: undefined }); // {} = 明确要求"看全量"，清掉旧声明
        myFilters = undefined;
      } else {
        const derived = deriveDeclaredFilters(s, args.my_filters);
        if (!derived.ok) return text(derived.error);
        myFilters = derived.filters;
        session.updateSettings({ plaza_circle: derived.filters });
      }
    } else {
      myFilters = session.settings().plaza_circle;
    }

    const res = await browsePlaza(instance, args.cursor);
    if (!res.ok) return text(`广场拉取失败：${res.error}\n\n（服务端地址对吗？自托管实例先用 docker compose up 起起来。）`);
    const page = res.data;

    const filtered = filterPlazaPool(page.items, {
      my_opaque_id: session.unlocked ? session.keyIdB64 : undefined,
      blocked_opaque_ids: blockedOpaqueIds(s),
      seen_card_ids: loadHistory(s, SEEN_CARDS_PATH),
      my_filters: myFilters,
      respect_visibility: args.respect_visibility ?? true,
    });
    // 存证：通过过滤的广场卡落盘——grant_l1 只送钥匙，解密 L1 需要这张密文
    for (const card of filtered.passed) saveCachedPlazaCard(s, card);
    appendHistory(
      s,
      SEEN_CARDS_PATH,
      filtered.passed.map((c) => c.meta.card_id),
    );

    const payload = {
      instance,
      my_filters: myFilters ?? null,
      outlines: filtered.outlines,
      next_cursor: page.next_cursor,
      filtered_out: filtered.rejected.length,
      filter_stats: filtered.stats,
      hint:
        '轮廓即全部——名片内容需对方显式授权（grant_l1）。敲门：send_via_server(msg_type="upgrade_request", target_card_id=<轮廓 card_id>)。',
    };
    const head =
      filtered.outlines.length > 0
        ? `广场这一页有 ${filtered.outlines.length} 个可见轮廓（${filtered.rejected.length} 个被本地过滤）：\n\n`
        : `这一页没有新的可见轮廓（${filtered.rejected.length} 个被本地过滤）。\n\n`;
    const circleNote = myFilters
      ? `你的拉取条件圈：${describeDeclared(myFilters, true).split('\n').join(' · ')}\n` +
        `（圈层过滤全在你本机算——服务端不筛、不排、不推。）\n\n`
      : `你还没声明拉取条件圈，所以看的是**全量**（不做同城/年龄/方向筛选）。\n` +
        `想收窄范围：下次调用带 my_filters（如 {city:"310000", seeking:"male"}），我会记住。\n\n`;
    return text(
      head +
        circleNote +
        `过滤明细：圈层可见性 ${filtered.stats.visibility} 个、条件圈 ${filtered.stats.circle} 个、其他 ${filtered.stats.other} 个。\n\n` +
        '```json\n' +
        JSON.stringify(payload, null, 2) +
        '\n```',
    );
  },
};

// ---------- plaza_publish（贴卡 / 撤卡 / 状态） ----------

export const plazaPublishTool = {
  name: 'plaza_publish',
  description:
    '管理本方广场卡：publish（把匹配卡派生为广场卡变体贴上服务端——自动剥离 key_l1，零知识军规）/' +
    'withdraw（撤卡）/ status（查看注册与贴卡状态）。贴卡即同意"陌生人能看见你在（仅轮廓）"。',
  inputSchema: {
    action: z.enum(['publish', 'withdraw', 'status']).default('publish'),
    server: z.string().optional().describe('服务端地址；缺省用已配置实例'),
    my_card_id: z.string().optional().describe('publish 的本方匹配卡 ID（缺省最新一张）'),
    fingerprint: z.string().optional().describe('withdraw 的卡指纹（缺省撤最新一张）'),
    declared_filters: z
      .record(z.unknown())
      .optional()
      .describe(
        '圈层声明（D8，明文公开、被签名）：gender/seeking/city(6 位国标码)/age_band/visible_to(all|same_city|same_age_band)。' +
          '缺省按画像自动派生同城 + 年龄段 + 性别方向；显式传入即覆盖',
      ),
  },
  handler: async (
    args: {
      action: 'publish' | 'withdraw' | 'status';
      server?: string;
      my_card_id?: string;
      fingerprint?: string;
      declared_filters?: Record<string, unknown>;
    },
    session: Session,
  ) => {
    const s = store();
    const resolved = resolveInstance(s, args.server);
    if (!resolved.ok) return text(resolved.error);
    const { instance } = resolved;
    if (args.server) persistInstance(session, instance);

    if (args.action === 'status') {
      const reg = loadRegistration(s);
      const mine = listOwnPlazaCards(s);
      const sameInstance = reg?.instance === instance;
      return text(
        '本方平台状态：\n\n```json\n' +
          JSON.stringify(
            {
              instance,
              registered: sameInstance,
              opaque_id: sameInstance ? reg?.opaque_id : undefined,
              published_cards: mine.map((c) => ({
                card_id: c.meta.card_id,
                fingerprint: cardFingerprint(c),
                expires_at: c.meta.expires_at,
              })),
              note: mine.length ? '撤卡后广场上立即不可见（已存证的他人不受影响）。' : '尚未贴卡。',
            },
            null,
            2,
          ) +
          '\n```',
      );
    }

    const regRes = await ensureRegistered(instance, session);
    if (!regRes.ok) return text(`服务端注册失败：${regRes.error}`);
    if (args.action === 'withdraw') {
      const mine = listOwnPlazaCards(s);
      const target = args.fingerprint ? mine.find((c) => cardFingerprint(c) === args.fingerprint) : mine[mine.length - 1];
      if (!target) return text('没有可撤的广场卡（或指纹不匹配）。');
      const fp = cardFingerprint(target);
      const res = await withdrawPlazaCard(instance, fp, session);
      if (!res.ok) return text(`撤卡失败：${res.error}`);
      s.remove(`${PLAZA_MINE_DIR}/${target.meta.card_id}.json`);
      return text(`已撤回广场卡（指纹 ${fp.slice(0, 8)}…）。从这一刻起，广场上不再有你的轮廓。`);
    }

    // publish：匹配卡 → 广场卡变体（无 key_l1）
    const mine = s.list('cards/mine').filter((f) => f.endsWith('.json'));
    if (mine.length === 0) return text('你还没有签发匹配卡（sign_card）——先签卡，再贴广场。');
    const card = s.read<MatchCardEnvelope>(`cards/mine/${args.my_card_id ? `${args.my_card_id}.json` : mine[mine.length - 1]!}`);
    if (!card) return text('找不到本方匹配卡。');
    // 圈层声明（D8 / v0.5）：明文公开、被签名、贴卡前逐项给主人看一遍
    const declared = deriveDeclaredFilters(s, args.declared_filters);
    if (!declared.ok) return text(declared.error);
    const declaredFilters = declared.filters;
    const plaza = toPlazaCard(card, session.keyProvider(), undefined, declaredFilters);
    // 本地闸门：贴上前再验一次零知识硬规则（防未来回归——§10.5）
    if (plaza.key_l1 !== undefined) {
      return text('内部错误：广场卡变体携带了 key_l1，已阻止上传（零知识军规 §10.5）。这不该发生——请报告。');
    }
    const res = await publishPlazaCard(instance, plaza, session);
    if (!res.ok) return text(`贴卡失败：${res.error}`);
    saveOwnPlazaCard(s, plaza);
    void reportMetric(session.settings().opt_in_counter, 'plaza_published', 'none');
    return text(
      `广场卡已贴上（指纹 ${res.data.fingerprint}，有效期至 ${plaza.meta.expires_at.slice(0, 10)}）。\n\n` +
        `陌生人现在能看到"你在"——但看不到任何内容：没有昵称、没有职业、没有照片。\n\n` +
        `**这次公开了这些检索条件**（明文，任何人可读，且已被签名锁死、改不了）：\n` +
        describeDeclared(declaredFilters, true) +
        `\n\n只公开这几个粗字段：它们是"你想被谁找到"的声明，不是画像内容。\n` +
        `不想公开某一项？撤卡后用 declared_filters 显式覆盖或留空再贴一次。\n\n` +
        `他们敲门（upgrade_request），你开门（grant_l1）——一阶名片的解锁从此是显式授权动作。`,
    );
  },
};

// ---------- send_via_server（经服务端定向投递） ----------

export const sendViaServerTool = {
  name: 'send_via_server',
  description:
    '经服务端投递一封结构化信封给广场上的人（V9：无已读回执、无在线状态——确认只到"已入信箱"）。' +
    '收件人用 target_card_id（plaza_browse 存证的卡）或 target_address（opaque_id[@instance]）指定；' +
    'upgrade_request 的 requester_kx_public、grant_l1 的密封钥匙均由工具自动派生。',
  inputSchema: {
    msg_type: z.enum(ENVELOPE_TYPES),
    target_address: z.string().optional().describe('对方地址 opaque_id[@instance]（应答 grant_l1 时用）'),
    target_card_id: z.string().optional().describe('对方广场卡 ID（plaza_browse 轮廓里的 card_id）'),
    body: z.record(z.unknown()).describe('消息体（各类型字段见协议 schema）'),
    server: z.string().optional().describe('服务端地址；缺省用已配置实例'),
  },
  handler: async (
    args: {
      msg_type: EnvelopeMsgType;
      target_address?: string;
      target_card_id?: string;
      body: Record<string, unknown>;
      server?: string;
    },
    session: Session,
  ) => {
    const s = store();
    if (!args.target_address && !args.target_card_id) {
      return text('请提供 target_card_id（广场卡）或 target_address（opaque_id 地址）二选一。');
    }
    const resolved = resolveInstance(s, args.server);
    if (!resolved.ok) return text(resolved.error);
    const { instance } = resolved;
    if (args.server) persistInstance(session, instance);

    // 收件人解析：广场卡存证优先，联系人卡回退（L1 已解锁导入 / 对方撤卡后中段续投）；
    // 裸地址仅 grant_l1 可行（协商公钥在收到的消息体里派生）
    let address: string;
    let theirKx: Uint8Array | undefined;
    if (args.target_card_id) {
      const card = findCachedPlazaCardById(s, args.target_card_id) ?? findContactCardById(s, args.target_card_id);
      if (!card) {
        return text(
          `找不到卡片 ${args.target_card_id} 的本地存证——哑管道不提供单卡查询，请先 plaza_browse 把这一页存下来。`,
        );
      }
      address = card.meta.owner_key_id;
      theirKx = fromBase64(card.meta.kx_public);
    } else {
      const parsed = parseAddress(args.target_address!);
      if (!parsed) return text('地址非法：应为 opaque_id 或 opaque_id@instance（协议 §7）。');
      if (parsed.instance && parsed.instance !== instanceHost(instance)) {
        return text(`跨实例投递未开放（v2.1）——你连着的实例域名是 ${instanceHost(instance)}。`);
      }
      address = parsed.opaque_id;
    }

    // 消息体补全 + 校验（与 send_envelope 同一套实现；层密钥封装由工具完成）
    const completed = completeMessageBody(args.msg_type, args.body, session, s, { recipientKx: theirKx });
    if (!completed.ok) return text(completed.error);
    const bodyError = validateBody(args.msg_type, completed.body);
    if (bodyError) {
      return text(`消息体不合法（${args.msg_type}）：${bodyError}。\n\n请按协议 schema 修正后重发；不要删改协议字段。`);
    }
    // 出站泄露面审查（D15⑦）：与服务端流同一口径
    const leakWarning = checkOutboundLeak(args.msg_type, completed.body, s);
    if (leakWarning) return text(leakWarning);
    // D9 代访预算帽：与服务端流同一口径（两条信道一套纪律）
    let budgetTokens = 0;
    if (args.msg_type === 'topic_pack') {
      const guard = guardTopicBudget(completed.body, session, s, address);
      if (!guard.ok) return text(guard.text);
      budgetTokens = guard.tokens;
    }
    const recipientKx = completed.recipientKx ?? theirKx;
    if (!recipientKx) {
      return text('缺少收件人协商公钥：请改用 target_card_id 指定收件人（广场卡自带公钥）。');
    }

    const myCard = (() => {
      const files = s.list('cards/mine').filter((f) => f.endsWith('.json'));
      return files.length ? s.read<MatchCardEnvelope>(`cards/mine/${files[files.length - 1]!}`) : null;
    })();
    const depth = myCard?.meta.depth ?? {
      interview_rounds: 0,
      completeness: 0,
      model_tier: session.settings().model_tier,
    };
    const env = buildSignedEnvelope(
      args.msg_type,
      completed.body,
      { targetCardId: args.target_card_id, depth, recipientKx },
      session,
    );

    const regRes = await ensureRegistered(instance, session);
    if (!regRes.ok) return text(`服务端注册失败：${regRes.error}`);
    const res = await deliverEnvelope(instance, address, env, session);
    if (!res.ok) return text(`投递失败：${res.error}`);
    noteSentEnvelope(s, address, args.msg_type, budgetTokens);
    void reportMetric(session.settings().opt_in_counter, 'exchange_initiated', 'none');
    return text(
      `已入信箱（收件人 ${address.slice(0, 8)}…，实例 ${instanceHost(instance)}）。\n\n` +
        `这是你能知道的全部——对方读没读、想没想，服务端不呈报、我也不假装知道（V9）。`,
    );
  },
};

// ---------- report_abuse（举报 / 我的举报汇总 / 实例匿名聚合） ----------

export const reportAbuseTool = {
  name: 'report_abuse',
  description:
    '举报一个广场上的人（行为信号，不上传任何信件内容——服务端读不到你的信，也无从审核证据，只能数独立举报人）。' +
    'action=file 举报（需 target_card_id 或 target_opaque_id + reason_code）/' +
    'mine 查看自己被举报的汇总（只有本人能查）/' +
    'stats 看本实例的匿名聚合（身份数/贴卡数/信封数，无个体数据）。' +
    '举报不等于裁决：真正保护你自己的开关是本地拉黑（ledger action=block）。',
  inputSchema: {
    action: z.enum(['file', 'mine', 'stats']).default('file'),
    server: z.string().optional().describe('服务端地址；缺省用已配置实例'),
    target_card_id: z.string().optional().describe('被举报对象的广场卡 ID（用本地存证解析地址）'),
    target_opaque_id: z.string().optional().describe('被举报对象的 opaque_id（与 target_card_id 二选一）'),
    reason_code: z
      .enum(REPORT_REASONS)
      .optional()
      .describe('举报事由（受控枚举）：harassment 骚扰 / spam 群发 / fraud_suspicion 疑似诈骗 / impersonation 冒名 / other'),
  },
  handler: async (
    args: {
      action: 'file' | 'mine' | 'stats';
      server?: string;
      target_card_id?: string;
      target_opaque_id?: string;
      reason_code?: (typeof REPORT_REASONS)[number];
    },
    session: Session,
  ) => {
    const s = store();
    const resolved = resolveInstance(s, args.server);
    if (!resolved.ok) return text(resolved.error);
    const { instance } = resolved;
    if (args.server) persistInstance(session, instance);

    if (args.action === 'stats') {
      const res = await fetchInstanceStats(instance);
      if (!res.ok) return text(`取实例聚合失败：${res.error}`);
      const d = res.data;
      return text(
        `实例 ${d.instance ?? instanceHost(instance)} 的匿名聚合（无任何个体数据）：\n\n` +
          '```json\n' +
          JSON.stringify(d, null, 2) +
          '\n```\n\n' +
          `口径：身份数 / 广场贴卡数 / 信箱内信封数 / 被举报目标数（含越阈值数）。` +
          `不含任何 opaque ID、不含任何内容、不公告活跃度明细。`,
      );
    }

    const regRes = await ensureRegistered(instance, session);
    if (!regRes.ok) return text(`服务端注册失败：${regRes.error}`);

    if (args.action === 'mine') {
      const res = await fetchReportSummary(instance, regRes.data.opaque_id, session);
      if (!res.ok) return text(`查询失败：${res.error}`);
      const d = res.data.summary;
      return text(
        d.reports === 0
          ? '你在这个实例上没有收到任何举报。\n\n（只有你能查这一项——别人查不到你的，你也查不到别人的。）'
          : `你在这个实例上收到 ${d.reports} 条举报，来自 ${d.distinct} 个独立的人。` +
              (d.flagged
                ? '\n\n这已越过实例的标记阈值——运营者可能据此限速或封禁。若有异议，联邦制下你可以换实例、身份不变。'
                : '\n\n未越过标记阈值（阈值按独立举报人数计，刷不出效果）。'),
      );
    }

    // file：解析被举报对象
    let target = args.target_opaque_id;
    if (!target && args.target_card_id) {
      const card = findCachedPlazaCardById(s, args.target_card_id) ?? findContactCardById(s, args.target_card_id);
      if (!card) {
        return text(
          `找不到卡片 ${args.target_card_id} 的本地存证——哑管道不提供单卡查询，请先 plaza_browse 把这一页存下来（或用 target_opaque_id）。`,
        );
      }
      target = card.meta.owner_key_id;
    }
    if (!target) return text('请提供 target_card_id 或 target_opaque_id。');
    if (!args.reason_code) {
      return text(`请指定 reason_code（受控枚举）：${REPORT_REASONS.join(' / ')}。\n\n不收自由文本——举报一旦能写字，就变成了内容审查通道。`);
    }

    const res = await reportAbuse(instance, target, args.reason_code, session);
    if (!res.ok) return text(`举报失败：${res.error}`);

    // 本地联动：举报之后仍建议拉黑（举报作用于实例，拉黑作用于你自己）
    const lineDir = dirNameFromKeyId(target);
    const line = s.read<FateLine>(`${LINES_DIR}/${lineDir}/state.json`);
    const blockHint = line
      ? `想让这个人从此不再出现在你眼前？那是你本地的开关，不用等平台：ledger(action="block", line_id="${line.line_id}")。`
      : `想让这个人从此不再出现在你眼前？等你和他之间建了姻缘线，就能用 ledger(action="block") 本地拉黑。`;

    return text(
      `已记录对 ${target.slice(0, 8)}… 的举报（${args.reason_code}）：当前 ${res.data.summary.reports} 条、` +
        `${res.data.summary.distinct} 个独立举报人。\n\n` +
        `说清楚边界：\n` +
        `· 服务端读不到你们的信件，所以**无法审核证据**——它只能数"多少个不同的人独立举报了同一个 ID"；\n` +
        `· 这份回执只告诉你汇总数字，不告诉你是谁举报的（也许其中一个就是你）；\n` +
        `· 越过阈值（${REPORT_FLAG_THRESHOLD} 个独立举报人）也只是"值得运营者看一眼"，不是平台裁决。\n\n` +
        blockHint,
    );
  },
};

// ---------- mailbox_pull（POP3 式拉取） ----------

export const mailboxPullTool = {
  name: 'mailbox_pull',
  description:
    '拉取本方信箱：验签 → 路由 → 本地处理 → 从服务端删除（POP3 式——服务端少一分持有少一分责任）。' +
    '无推送、无已读回执：你想知道有没有信，只能自己来问；拉取本身对方也无从知晓。',
  inputSchema: {
    server: z.string().optional().describe('服务端地址；缺省用已配置实例'),
    keep_on_server: z.boolean().optional().describe('true = 拉取后不删除（仅调试用；默认删除）'),
  },
  handler: async (args: { server?: string; keep_on_server?: boolean }, session: Session) => {
    const s = store();
    const resolved = resolveInstance(s, args.server);
    if (!resolved.ok) return text(resolved.error);
    const { instance } = resolved;
    if (args.server) persistInstance(session, instance);

    const regRes = await ensureRegistered(instance, session);
    if (!regRes.ok) return text(`服务端注册失败：${regRes.error}`);
    const address = regRes.data.opaque_id;

    // 全量拉取（信箱 30 天 TTL + 20 封/日限速，量级小——循环分页取尽，防呆上限 20 页）
    const items: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const res = await pullMailbox(instance, address, session, cursor);
      if (!res.ok) return text(`信箱拉取失败：${res.error}`);
      items.push(...res.data.items);
      cursor = res.data.next_cursor;
      if (!cursor) break;
    }
    if (items.length === 0) {
      return text('信箱是空的——没有新信件。\n\n（拉取无推送：没有"叮"的一声，你想知道有没有信，只能自己来问。）');
    }

    const seen = new Set(loadHistory(s, PULLED_PATH));
    const results: string[] = [];
    const freshIds: string[] = [];
    for (const raw of items) {
      const check = MsgEnvelope.safeParse(raw);
      if (!check.success) {
        results.push('（一封结构不合法的信——已忽略，不删除，留给服务端 TTL 清扫）');
        continue;
      }
      const env = check.data;
      if (seen.has(env.meta.card_id)) {
        results.push(`（重复的信 ${env.meta.card_id.slice(0, 8)}…——本地已处理过，跳过）`);
        // 已处理过的信也要删：否则它每轮都回来、直到服务端 30 天 TTL 清扫才消失
        if (!args.keep_on_server) await deleteMailboxItem(instance, address, env.meta.card_id, session);
        continue;
      }
      const sigOk = verifyDetached(
        fromBase64(env.signature),
        canonicalBytes({ meta: env.meta, payload: env.payload }),
        fromBase64(env.meta.sig_public),
      );
      if (!sigOk) {
        results.push('（一封验签失败的信——可能被伪造或篡改，已拒绝处理）');
        continue;
      }
      const routed = routeEnvelope(env, session);
      results.push(routed.content[0]!.text);
      freshIds.push(env.meta.card_id);
      if (!args.keep_on_server) {
        // 本地处理成功后才删——失败保留，下次拉取还能重来
        const del = await deleteMailboxItem(instance, address, env.meta.card_id, session);
        if (!del.ok) results.push(`（服务端删除失败：${del.error}——这封信下次还会拉到你眼前）`);
      }
    }
    appendHistory(s, PULLED_PATH, freshIds);
    const tail = args.keep_on_server
      ? '\n\n（keep_on_server：信件仍留在服务端——仅调试用。）'
      : '\n\n（已处理的信已从服务端删除——服务端不再持有你的任何信。）';
    return text(`拉到 ${items.length} 封（新处理 ${freshIds.length} 封）：\n\n` + results.join('\n\n---\n\n') + tail);
  },
};
