/**
 * 防护一的本地确认记录（D7 / C2①）
 *
 * 只存两个字段：文案版本号 + 确认时间。**不含任何身份信息，不上报、不联网。**
 * 平台连"多少人看过这份提示"都不该知道——除非用户显式 opt-in 计数。
 */

import { SAFETY_NOTICE_VERSION, safetyAckSatisfied } from '@hongxian/core';
import type { FsStore } from './store-fs.js';

const ACK_PATH = 'safety-ack.json';

export interface SafetyAckRecord {
  version: string;
  acked_at: string;
}

export function readSafetyAck(store: FsStore): SafetyAckRecord | null {
  return store.read<SafetyAckRecord>(ACK_PATH);
}

export function writeSafetyAck(store: FsStore): SafetyAckRecord {
  const record: SafetyAckRecord = {
    version: SAFETY_NOTICE_VERSION,
    acked_at: new Date().toISOString(),
  };
  store.write(ACK_PATH, record);
  return record;
}

/** 是否还需要展示风险提示（版本号不一致就要重看） */
export function needsSafetyAck(store: FsStore): boolean {
  return !safetyAckSatisfied(readSafetyAck(store)?.version);
}
