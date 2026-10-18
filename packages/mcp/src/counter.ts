/**
 * opt-in 匿名计数（E7 / S7）
 *
 * 纪律：
 * - 默认关闭（settings.opt_in_counter = false）——关闭时**零出网**（验收：抓包为空）
 * - 开启后仅 POST 预定义指标白名单，4 秒超时、失败静默、不重试、不写日志
 * - 无任何用户 ID：bucket 仅限受控词表（性别段/年龄段/事件类型）
 */

const COUNTER_ENDPOINT = 'https://count.hongxian.dev/bump';

/** 指标白名单（超出即拒绝上报——防止意外字段外泄） */
export const METRIC_WHITELIST = [
  'card_signed', // 签发名片（bucket = gender）
  'card_imported', // 导入名片（bucket = gender）
  'exchange_initiated', // 发起交换（bucket = none）
] as const;

export type Metric = (typeof METRIC_WHITELIST)[number];

/** bucket 白名单（受控词表，无任何身份信息） */
const BUCKET_WHITELIST = ['female', 'male', 'none', '18_25', '26_30', '31_35', '36_40', '41_45', '46_50', 'over_50'];

export interface ReportResult {
  reported: boolean;
  reason?: string;
}

/** 上报一个指标。opt_in 关闭 / 指标越界 / 网络失败 → 静默不报 */
export async function reportMetric(
  optIn: boolean,
  metric: string,
  bucket: string,
): Promise<ReportResult> {
  if (!optIn) return { reported: false, reason: 'opt-in 未开启（零出网）' };
  if (!(METRIC_WHITELIST as readonly string[]).includes(metric)) {
    return { reported: false, reason: '指标不在白名单' };
  }
  if (!BUCKET_WHITELIST.includes(bucket)) {
    return { reported: false, reason: 'bucket 不在白名单' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    await fetch(COUNTER_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metric, bucket }),
      signal: controller.signal,
    });
    return { reported: true };
  } catch {
    // 失败静默：计数是锦上添花，绝不打扰用户、绝不重试
    return { reported: false, reason: '网络不可达（静默）' };
  } finally {
    clearTimeout(timer);
  }
}
