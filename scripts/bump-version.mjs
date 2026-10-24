#!/usr/bin/env node
/**
 * 版本升级：五个包 + 相互依赖 + 根 package.json 一次改对。
 *
 * 为什么需要脚本：`@hongxian/core` 依赖 `@hongxian/schema` 用的是**精确版本**。
 * 手工改漏一处，发出去的包就会指向一个不存在的版本，装的人直接失败。
 *
 * 用法：
 *   node scripts/bump-version.mjs patch      # 0.1.0 → 0.1.1
 *   node scripts/bump-version.mjs minor      # 0.1.1 → 0.2.0
 *   node scripts/bump-version.mjs 1.0.0      # 指定版本
 *   node scripts/bump-version.mjs patch --dry-run
 *
 * 不改 git、不提交、不发布——只改文件，剩下的交给人看 diff。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PACKAGES, NOT_YET } from './packages.mjs';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!target) {
  console.error('用法：node scripts/bump-version.mjs <major|minor|patch|X.Y.Z> [--dry-run]');
  process.exit(1);
}

function bump(cur, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(cur);
  if (!m) throw new Error(`当前版本无法解析：${cur}`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${min + 1}.0.0`;
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  if (!/^\d+\.\d+\.\d+/.test(kind)) throw new Error(`不是合法版本号：${kind}`);
  return kind;
}

const all = [...PACKAGES, ...NOT_YET];
const names = new Set(all.map((p) => p.name));

const rootPkgPath = 'package.json';
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
const from = JSON.parse(readFileSync(`${all[0].dir}/package.json`, 'utf8')).version;
const to = bump(from, target);

if (to === from) {
  console.error(`新版本与当前版本相同（${from}），什么都没做`);
  process.exit(1);
}

console.log(`\n${from} → ${to}${dryRun ? '  （演练，不写文件）' : ''}\n`);

for (const { name, dir } of all) {
  const p = `${dir}/package.json`;
  const pkg = JSON.parse(readFileSync(p, 'utf8'));
  const changes = [`version ${pkg.version} → ${to}`];
  pkg.version = to;

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const [dep, ver] of Object.entries(pkg[field] ?? {})) {
      if (!names.has(dep)) continue;
      if (ver === from) {
        pkg[field][dep] = to;
        changes.push(`${field}.${dep} ${ver} → ${to}`);
      } else {
        console.log(`! ${name} 的 ${field}.${dep} 是 "${ver}"，与当前版本 ${from} 不一致，未改动——请人工确认`);
      }
    }
  }

  if (!dryRun) writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`✓ ${name}`);
  for (const c of changes) console.log(`    ${c}`);
}

if (rootPkg.version !== to) {
  const rootFrom = rootPkg.version;
  if (!dryRun) {
    rootPkg.version = to;
    writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n');
  }
  console.log(`✓ root package.json`);
  console.log(`    version ${rootFrom} → ${to}`);
}

console.log(`
下一步（别跳）：
  1. npm install --package-lock-only      # 让 lock 与新的包版本对齐，否则 CI 的 npm ci 会拒跑
  2. npm run build && npm run verify       # 全量回归
  3. npm run pack:check                    # tarball 内容体检
  4. npm run release:dry                   # 演练发布（不上传）
  5. git add -A && git commit -m "chore: release v${to}"
  6. git tag v${to} && git push origin main --tags
  7. tag 推上去后 release.yml 自动发布；npm view @hongxian/mcp version 核对
`);
