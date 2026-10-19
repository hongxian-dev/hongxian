/**
 * MCP Tools · 生命周期：backup / restore / wipe（D15③ 备份恢复 + S3 一键删除）
 *
 * backup：加密档案 = 恢复短语 seed 加密的画像/手账快照（可放用户自有云盘——数据主权军规第 3 条）。
 * restore：档案导入 + 短语重解锁（换设备场景，D15③）。
 * wipe：一键删除全部本地数据（验收：磁盘零残留，含缓存与临时文件）；
 *   远程侧收尾（M1.3）：连过服务端的，先尽力注销服务端身份（级联删服务端密文）。
 */

import { z } from 'zod';
import { canonicalBytes } from '@hongxian/schema';
import { openKeyFile, sealKeyFile } from '@hongxian/crypto';
import { wipeHome } from './store-fs.js';
import { store } from './context.js';
import { loadRegistration, deleteServerIdentity } from './server-client.js';
import { PLAZA_CACHE_DIR, PLAZA_MINE_DIR } from './plaza-store.js';
import type { Session } from './session.js';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

/** 档案结构：画像 + 手账 + 广场状态 + 设置的加密快照（不含密钥文件——密钥即身份，走恢复短语） */
interface ArchivePayload {
  profile_state: unknown;
  cards_mine: Record<string, unknown>;
  cards_contacts: Record<string, unknown>;
  cards_plaza_mine: Record<string, unknown>;
  cards_plaza: Record<string, Record<string, unknown>>;
  server_state: Record<string, unknown>;
  lines: Record<string, unknown>;
  settings: unknown;
  created_at: string;
}

export const backupTool = {
  name: 'backup',
  description:
    '导出加密档案（用当前恢复短语加密的画像/卡片/手账快照，可放入你自己的云盘）。' +
    '注意：已解锁交给对方的明文无法远程撤回（D15②）；档案本身不含密钥——密钥即身份。',
  inputSchema: {},
  handler: async (_args: Record<string, never>, session: Session) => {
    const s = store();
    const payload: ArchivePayload = {
      profile_state: s.read('profile/interview-state.json'),
      cards_mine: readDirEntries(s, 'cards/mine'),
      cards_contacts: readContacts(s),
      cards_plaza_mine: readDirEntries(s, PLAZA_MINE_DIR),
      cards_plaza: readPlazaCache(s),
      server_state: {
        registration: s.read('server/registration.json'),
        plaza_seen: s.read('server/plaza-seen.json'),
        pulled: s.read('server/pulled.json'),
      },
      lines: readLines(s),
      settings: s.read('settings.json'),
      created_at: new Date().toISOString(),
    };
    const sealed = await sealKeyFile(canonicalBytes(payload), session.seedBytes());
    return text(
      `加密档案已生成。保存为 hongxian-backup.json 并放入你自己的云盘：\n\n` +
        '```json\n' + JSON.stringify(sealed, null, 2) + '\n```\n\n' +
        `在新设备上：装好月老 → restore(archive=档案内容, mnemonic=恢复短语)。\n` +
        `提醒：档案与恢复短语分开保管；任何一方泄露都不足以单独还原你的数据。`,
    );
  },
};

export const restoreTool = {
  name: 'restore',
  description: '从加密档案恢复（换设备场景）：导入档案 + 恢复短语重解锁。密钥文件由短语重建。',
  inputSchema: {
    archive: z.string().describe('backup 导出的档案 JSON 全文'),
    mnemonic: z.string().describe('24 词中文恢复短语'),
  },
  handler: async (args: { archive: string; mnemonic: string }, session: Session) => {
    const s = store();
    let sealed: Parameters<typeof openKeyFile>[0];
    try {
      sealed = JSON.parse(args.archive);
    } catch {
      return text('档案不是合法 JSON。');
    }
    // 短语重建身份（新设备：恢复短语即身份——D15③）
    const ok = await session.unlockOrDerive(args.mnemonic);
    if (!ok) return text('恢复短语无效：必须是 24 个中文词且校验和正确。');
    const bytes = await openKeyFile(sealed, session.seedBytes());
    if (!bytes) return text('档案解密失败：短语与档案不匹配（或档案被篡改）。');
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as ArchivePayload;
    if (payload.profile_state) s.write('profile/interview-state.json', payload.profile_state);
    for (const [name, data] of Object.entries(payload.cards_mine ?? {})) {
      s.write(`cards/mine/${name}`, data);
    }
    for (const [owner, entries] of Object.entries(payload.cards_contacts ?? {})) {
      for (const [name, data] of Object.entries(entries as Record<string, unknown>)) {
        s.write(`cards/contacts/${owner}/${name}`, data);
      }
    }
    for (const [name, data] of Object.entries(payload.cards_plaza_mine ?? {})) {
      s.write(`${PLAZA_MINE_DIR}/${name}`, data);
    }
    for (const [owner, entries] of Object.entries(payload.cards_plaza ?? {})) {
      for (const [name, data] of Object.entries(entries as Record<string, unknown>)) {
        s.write(`${PLAZA_CACHE_DIR}/${owner}/${name}`, data);
      }
    }
    const serverState = payload.server_state ?? {};
    if (serverState.registration) s.write('server/registration.json', serverState.registration);
    if (serverState.plaza_seen) s.write('server/plaza-seen.json', serverState.plaza_seen);
    if (serverState.pulled) s.write('server/pulled.json', serverState.pulled);
    for (const [owner, data] of Object.entries(payload.lines ?? {})) {
      s.write(`lines/${owner}/state.json`, data);
    }
    if (payload.settings) s.write('settings.json', payload.settings);
    return text('档案恢复完成：画像、卡片、手账、广场状态、设置已写回本机。密钥由恢复短语重建（换设备不掉线）。');
  },
};

export const wipeTool = {
  name: 'wipe',
  description:
    '一键删除全部本地数据（画像/卡片/手账/密钥/设置——整个数据目录）。删除后不可恢复；' +
    '身份随密钥一同消失，对方持有的已解锁明文无法撤回（D15②）。' +
    '连过服务端的会尽力一并注销服务端身份（需持钥签名——在锁定前执行）。',
  inputSchema: {
    confirm: z.literal(true).describe('必须传 true 确认删除'),
  },
  handler: async (args: { confirm: true }, session: Session) => {
    if (args.confirm !== true) return text('删除是不可逆操作，请传 confirm=true 确认。');
    // 远程侧收尾（M1.3）：注销需要持钥签名，故在 lock() 之前执行；失败不阻塞本地删除
    let remoteNote = '';
    const reg = loadRegistration(store());
    if (reg && session.unlocked) {
      const res = await deleteServerIdentity(reg.instance, session);
      remoteNote = res.ok
        ? `\n\n服务端身份已注销（${reg.instance}，级联删除 ${res.data.removed} 条密文记录）。`
        : `\n\n服务端注销失败（${res.error}）——本地已删；服务端密文会按 TTL 自动清扫，也可重新解锁后再次 wipe 重试注销。`;
    } else if (reg) {
      remoteNote = `\n\n检测到服务端注册记录（${reg.instance}），但会话未解锁、无法签名注销——服务端密文会按 TTL 自动清扫。`;
    }
    session.lock();
    const { removed } = wipeHome();
    return text(
      `已删除全部本地数据（${removed.length} 个文件/目录条目），磁盘无残留。${remoteNote}\n\n` +
        `如果之后想重新开始：interview(action="start")。\n` +
        `（提醒：已经解锁给对方的明文，我无法替你收回——这是开始就说清的。）`,
    );
  },
};

// ---------- 辅助 ----------

function readDirEntries(s: ReturnType<typeof store>, dir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of s.list(dir)) {
    out[f] = s.read(`${dir}/${f}`);
  }
  return out;
}

function readContacts(s: ReturnType<typeof store>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const owner of s.list('cards/contacts')) {
    out[owner] = readDirEntries(s, `cards/contacts/${owner}`);
  }
  return out;
}

function readPlazaCache(s: ReturnType<typeof store>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const owner of s.list(PLAZA_CACHE_DIR)) {
    out[owner] = readDirEntries(s, `${PLAZA_CACHE_DIR}/${owner}`);
  }
  return out;
}

function readLines(s: ReturnType<typeof store>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const dir of s.list('lines')) {
    const state = s.read(`lines/${dir}/state.json`);
    if (state) out[dir] = state;
  }
  return out;
}
