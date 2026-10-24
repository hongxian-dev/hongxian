/**
 * @hongxian/schema —— 红线协议 v0.4 的机器可读形态
 *
 * 独立 npm 发布（技术详设原则 5：schema 即契约——协议即产品的实现载体）。
 * 上位文档：《匹配卡Schema规范》v0.3 + v0.4 增量（平台服务：广场卡无 key_l1 /
 * grant_l1 密封交付 / opaque 寻址 / 信箱语义）。
 */

export * from './vocab.js';
export * from './canonical.js';
export * from './card.js';
export * from './messages.js';
export * from './address.js';
export * from './publish.js';
