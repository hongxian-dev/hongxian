/**
 * MCP Tools · 见面与复盘（D3③④ / D13）
 *
 *   meeting_kit  → 见面锦囊：话题 / 场合 / 安全 / 反诈终检 / 对称性回顾
 *   debrief      → 见面复盘：记录真实感受 + 给出"可以重新想一想"的校准点（不自动改画像）
 *   view_l3      → 看对方交付的联系方式（只解得出被授权的字段——逐字段密钥）
 *
 * v1.0 这三件事只有一句内联提示（毕业邀请的成功文案里提了一句"安全提示"），
 * 没有一个可调用的入口——用户真正要用的时候，工具面是空的。
 */

import { z } from 'zod';
import {
  buildCalibrationHints,
  buildMeetingKit,
  decryptLayer,
  l3FieldNamesIn,
  openL3Field,
  renderDebrief,
  renderMeetingKit,
  type DebriefRecord,
} from '@hongxian/core';
import { fromBase64 } from '@hongxian/schema';
import { store } from './context.js';
import { findContactCard, loadMyProfile, loadTheirProfile } from './profile-view.js';
import { findLine } from './rounds-store.js';
import type { Session } from './session.js';

const LINES_DIR = 'lines';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

// ---------- meeting_kit（D3④） ----------

export const meetingKitTool = {
  name: 'meeting_kit',
  description:
    '见面锦囊：基于双方画像给破冰话题（共鸣点/可聊差异）+ 场合与节奏建议 + 安全清单 + 反诈终检 + 对称性回顾。' +
    '不含任何"让对方喜欢你"的话术——只教怎么好好认识一个人（D9/D12 伦理边界）。',
  inputSchema: {
    card_id: z.string().describe('对端卡片 ID'),
  },
  handler: async (args: { card_id: string }, _session: Session) => {
    const s = store();
    const mine = loadMyProfile(s);
    if (!mine) return text('你的画像还没完成——见面锦囊需要双方画像才能给出具体话题（先走完三次访谈）。');
    const them = loadTheirProfile(s, args.card_id);
    if (!them) return text(`找不到对方卡片 ${args.card_id}（需先 import_card 或经广场解锁）。`);
    if (!them.unlocked.includes('L1')) {
      return text('对方一阶名片还没解锁——现在只能给通用清单，但没有具体话题可聊。先把一阶解锁了再来。');
    }
    const grantedFields = Object.keys(them.layerKeys)
      .filter((k) => k.startsWith('l3_') && k !== 'l3_container')
      .map((k) => k.slice(3));
    const kit = buildMeetingKit({
      mine,
      theirs: them.view,
      unlocked: them.unlocked,
      grantedFields,
    });
    return text(renderMeetingKit(kit));
  },
};

// ---------- debrief（D3③） ----------

export const debriefTool = {
  name: 'debrief',
  description:
    '见面复盘：记录真实感受（再次见面意愿 / 对上什么 / 哪里别扭）→ 只存本机，并给出「可以重新想一想」的画像校准点。' +
    '月老不自动改画像、不偷偷调权重——校准的决定权永远在主人手里。',
  inputSchema: {
    card_id: z.string().describe('对端卡片 ID'),
    feeling: z.enum(['again', 'unsure', 'no']).describe('再见一面 / 说不好 / 不想再见（你的自评，不是评分）'),
    matches: z.array(z.string().max(80)).max(5).optional().describe('哪里对上了（具体的事，不是评价）'),
    surprises: z.array(z.string().max(80)).max(5).optional().describe('哪里别扭或意外'),
    next_time: z.string().max(200).optional().describe('下次想怎么调整'),
  },
  handler: async (
    args: { card_id: string; feeling: 'again' | 'unsure' | 'no'; matches?: string[]; surprises?: string[]; next_time?: string },
    _session: Session,
  ) => {
    const s = store();
    const found = findLine(s, args.card_id);
    if (!found) return text(`找不到这条姻缘线（${args.card_id}）——先换过名片再复盘。`);
    const record: DebriefRecord = {
      card_id: args.card_id,
      feeling: args.feeling,
      matches: args.matches ?? [],
      surprises: args.surprises ?? [],
      next_time: args.next_time,
      created_at: new Date().toISOString(),
    };
    const state = s.read<{
      confirmed?: { preferences?: { dealbreakers?: { dimension: string; note: string }[]; values_tags?: { tag: string; weight: number }[] } };
    }>('profile/interview-state.json');
    const hints = buildCalibrationHints(record, {
      dealbreakers: state?.confirmed?.preferences?.dealbreakers,
      values_tags: state?.confirmed?.preferences?.values_tags,
    });

    const name = `${record.created_at.replace(/[:.]/g, '')}.json`;
    s.write(`${LINES_DIR}/${found.dir}/debriefs/${name}`, record);
    s.write(`${LINES_DIR}/${found.dir}/state.json`, {
      ...found.line,
      notes: [
        ...found.line.notes,
        `${record.created_at.slice(0, 10)} 复盘：${record.feeling === 'again' ? '想再见' : record.feeling === 'no' ? '不想再见' : '说不好'}` +
          `${record.matches.length ? `；对上：${record.matches.join('、')}` : ''}` +
          `${record.surprises.length ? `；别扭：${record.surprises.join('、')}` : ''}`,
      ],
      last_activity: record.created_at,
    });

    return text(
      renderDebrief(record, hints) +
        `\n\n（复盘已存本机：${LINES_DIR}/${found.dir}/debriefs/${name}）`,
    );
  },
};

// ---------- view_l3（D13 逐字段解锁的读取口） ----------

export const viewL3Tool = {
  name: 'view_l3',
  description:
    '查看对方交付的见面层信息（联系方式等）。只解得出被逐项授权的字段——未授权字段仍是密文，解不开（D13）。' +
    '这是"解锁之后怎么看"的唯一入口：grant_l3 只落密钥，明文在这里读。',
  inputSchema: {
    card_id: z.string().describe('对端卡片 ID'),
  },
  handler: async (args: { card_id: string }, _session: Session) => {
    const s = store();
    const them = loadTheirProfile(s, args.card_id);
    if (!them) return text(`找不到对方卡片 ${args.card_id}。`);
    const card = findContactCard(s, args.card_id)!;
    const granted = Object.keys(them.layerKeys)
      .filter((k) => k.startsWith('l3_') && k !== 'l3_container')
      .map((k) => k.slice(3));
    if (granted.length === 0) {
      return text('对方还没有交付任何见面层字段。毕业轮（graduation_invite → grant_l3）之后才会有。');
    }
    const containerKey = them.layerKeys.l3_container;
    let opened: { ok: true; payload: unknown } | { ok: false; error: string };
    if (containerKey) {
      opened = decryptLayer(card as never, 'L3', fromBase64(containerKey));
    } else {
      // v1.0 卡片：payload_L3 用 L3 层密钥加密，而 v1.0 的 grant_l3 并未真正交出它。
      return text(
        '这张卡片是旧版本签发的（见面层是单块加密，没有逐字段密钥）——对方需要重签一版卡片，' +
          '才能按字段交付。旧卡的"解锁"在密码学上无法只给一个字段。',
      );
    }
    if (!opened.ok) return text(`见面层解不开：${opened.error}`);

    const labels: Record<string, string> = {
      contact_wechat: '微信号',
      contact_phone: '手机号',
      real_name: '真实姓名',
      employer_category: '工作单位大类',
      hangout_areas: '常去区域',
      photo_refs: '照片引用（哈希+密钥）',
    };
    const allFields = l3FieldNamesIn(opened.payload);
    const lines: string[] = [];
    for (const field of allFields) {
      const label = labels[field] ?? field;
      if (!granted.includes(field)) {
        lines.push(`- ${label}：未授权（密文在，钥匙没给——解不开）`);
        continue;
      }
      const r = openL3Field(opened.payload, field, fromBase64(them.layerKeys[`l3_${field}`]!));
      if (!r.ok) {
        lines.push(`- ${label}：解不开（${r.error}）`);
        continue;
      }
      const value = Array.isArray(r.value) ? (r.value as unknown[]).join('、') : String(r.value);
      lines.push(`- ${label}：${value}`);
    }
    return text(
      `**对方交付的见面层**（逐字段授权，未授权的不显示明文）：\n\n${lines.join('\n')}\n\n` +
        `红线已经交到你们手里了。第一次见面：公共场所、自己往返、把行踪告诉一位朋友。\n` +
        `任何涉及金钱的请求，立即警惕。`,
    );
  },
};
