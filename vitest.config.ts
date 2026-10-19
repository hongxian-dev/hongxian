import { defineConfig } from 'vitest/config';

/**
 * vitest 配置（2026-10-19，M1.1 期间固化）：
 *
 * pool = 'threads'——本机（Windows + WorkBuddy 宿主环境）使用默认 forks 池时，
 * vite-node 的 SSR 模块缓存并发写临时目录偶发 EPERM/EBUSY（实时文件防护/锁竞争），
 * 表现为个别测试文件收集失败、测试数漂移（假绿/假红风险，直接影响"可靠性"承诺）。
 * threads 池连续多轮 12 文件 / 138 测试零错误，且保留并行速度。
 *
 * 若未来迁移到 CI/Linux 环境，可评估切回 forks——届时删除本注释与 pool 行，
 * 并以连续 3 轮全绿为切换依据。
 */
export default defineConfig({
  test: {
    pool: 'threads',
  },
});
