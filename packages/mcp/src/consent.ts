/**
 * 知情同意与年龄承诺（S1 / D15⑤ / D15②）
 *
 * 首次启动强制一页说明：收集什么、存哪里、可随时删除、云端 LLM 数据流披露、
 * "解锁即无法撤回"（删除不对称性的诚实补丁——丑话自己先说）、≥18 周岁声明。
 * 未确认前，任何涉及画像的工具不得执行。
 */

import type { FsStore } from './store-fs.js';

const CONSENT_PATH = 'consent.json';

export interface ConsentRecord {
  version: 1;
  age_attested: true; // ≥18 周岁（法律硬要求，D15⑤）
  understood: {
    local_storage: true; // 一切数据只存本设备
    llm_data_flow: true; // 对话内容会经过用户配置的模型（云端路径如实披露）
    irreversible_unlock: true; // 已解锁交给对方的明文无法远程撤回（D15②）
    deletable: true; // 可随时一键删除全部数据
  };
  consented_at: string;
}

/** 知情同意书全文（月老口吻，D2 温暖克制；措辞诚实不煽情） */
export const CONSENT_TEXT = `在开始之前，有几句要紧的话，月老要对你说清楚：

一、我是什么。我是住在你设备里的一个工具，帮你把相亲里那些重复的、难为情的、耗时间的过程变得轻省。我不会替你心动，也不会替你做主。

二、你的数据存在哪。你的画像、你签发的每一张卡、往来的一切记录，全部只存在你这台设备上（~/.hongxian/ 目录）。我们没有服务器，也不登录任何账号。你可以随时让我把这一切删得干干净净。

三、对话会经过什么。我和你聊天时，这些话会经过你在这台设备上配置的模型来处理。如果你配置的是云端模型，这些内容会发送给对应的服务商——这是你需要知道的，我不会说"只有我知道"这种便宜话。

四、有一件事无法回头。当你和某人互相解锁到见面层（联系方式、真实姓名），交给对方的明文，我没有办法远程收回——这是点对点的架构决定的。所以每一阶的解锁，都请你自己确认。

五、年龄。使用本工具需要你已年满 18 周岁。

你确认以上都清楚了、并且已年满 18 周岁，我们就开始。`;

export function readConsent(store: FsStore): ConsentRecord | null {
  return store.read<ConsentRecord>(CONSENT_PATH);
}

export function writeConsent(store: FsStore): ConsentRecord {
  const record: ConsentRecord = {
    version: 1,
    age_attested: true,
    understood: {
      local_storage: true,
      llm_data_flow: true,
      irreversible_unlock: true,
      deletable: true,
    },
    consented_at: new Date().toISOString(),
  };
  store.write(CONSENT_PATH, record);
  return record;
}

/** 是否需要走知情同意 */
export function needsConsent(store: FsStore): boolean {
  return readConsent(store) === null;
}
