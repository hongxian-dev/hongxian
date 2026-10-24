/**
 * 发布清单——顺序与范围的唯一来源。
 *
 * 顺序不能乱：`@hongxian/core` 依赖 `@hongxian/schema`（精确版本），
 * 被依赖的必须先进 registry，否则先发出去的那个装不上。
 */

export const PACKAGES = [
  { name: '@hongxian/schema', dir: 'packages/schema' },
  { name: '@hongxian/crypto', dir: 'packages/crypto' },
  { name: '@hongxian/core', dir: 'packages/core' },
  { name: '@hongxian/mcp', dir: 'packages/mcp' },
];

export const PUBLISH_ORDER = PACKAGES.map((p) => p.name);

/**
 * 配置已就绪但首发不发。
 * `@hongxian/server` 是 AGPL 自托管服务，走 docker 更自然；且 AGPL 的署名主体还没定。
 * 要发的时候把它移进 PACKAGES 末尾即可——元数据、LICENSE、守卫都已备好。
 */
export const NOT_YET = [{ name: '@hongxian/server', dir: 'packages/server' }];
