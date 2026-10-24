/**
 * @hongxian/core —— 红线领域核心（纯函数，零 IO）
 *
 * 分层（技术详设原则 4）：MCP 层只做协议适配，领域逻辑全部在此。
 * IO 与密钥经 Store / KeyProvider 接口注入——换载体时 core 零改动。
 */

export * from './types.js';
export * from './profile/interview.js';
export * from './card/envelope.js';
export * from './card/l3.js';
export * from './plaza.js';
export * from './match/screen.js';
export * from './rounds/machine.js';
export * from './ledger/lines.js';
export * from './filter/outbound.js';
export * from './guard/injection.js';
export * from './guard/safety.js';
export * from './guide/meeting-kit.js';
export * from './guide/debrief.js';
