#!/usr/bin/env node
/**
 * 按依赖顺序发布。发布顺序与「本次发/暂不发」清单只在 pack-check.mjs 里定义一次。
 *
 * 用法：
 *   node scripts/publish-all.mjs                     # 真发（CI 里跑，读 NODE_AUTH_TOKEN）
 *   node scripts/publish-all.mjs --dry-run           # 只演练，不传任何字节
 *   node scripts/publish-all.mjs --no-provenance     # 本地真发（本地生成不了 provenance）
 *
 * 为什么要有 --no-provenance：npm 的 provenance 只能在**受支持的云 CI** 里生成
 * （GitHub Actions / GitLab CI 的 OIDC 身份），本地 `npm publish --provenance` 直接报错。
 * 但 package.json 里写了 `publishConfig.provenance: true`，所以本地发必须显式关掉，
 * 否则连包都传不上去。代价是这一批没有构建出处证明——日报里要如实说明，
 * 下一版走 release.yml 补上。CI 里**永远不要**加这个参数。
 *
 * 为什么要防重复：同一个版本号第二次 publish 会被 registry 拒（409），
 * 但如果前一个包已发成功、后一个失败，重跑整个流程就会卡在已发的那个上。
 * 所以先查 registry，已存在的直接跳过并如实报告。
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PACKAGES } from './packages.mjs';

const dryRun = process.argv.includes('--dry-run');
const noProvenance = process.argv.includes('--no-provenance');

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function trySh(cmd) {
  try {
    return { ok: true, out: sh(cmd) };
  } catch (e) {
    return { ok: false, out: (e.stderr ?? e.message ?? '').toString().trim() };
  }
}

console.log(dryRun ? '■ 演练模式：不会上传任何内容\n' : '■ 发布模式\n');
if (noProvenance) {
  console.log('⚠ 本次不带 provenance（本地发布生成不了构建出处证明）。');
  console.log('  这是首发的一次性妥协，下一版请走 release.yml 补上。\n');
}
if (!process.env.NODE_AUTH_TOKEN) {
  console.log('· 未提供 NODE_AUTH_TOKEN，将使用当前 npm 登录态\n');
}

const published = [];
const skipped = [];
const failures = [];

for (const { name: pkg, dir } of PACKAGES) {
  const version = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).version;

  // registry 上已有这个版本 → 跳过（支持「发一半失败后重跑」）
  const exists = trySh(`npm view ${pkg}@${version} version --registry=https://registry.npmjs.org`);
  if (exists.ok && exists.out.includes(version)) {
    console.log(`→ ${pkg}@${version} 已存在，跳过`);
    skipped.push(pkg);
    continue;
  }

  const args = ['publish', '-w', pkg, '--access', 'public'];
  if (!noProvenance) args.push('--provenance');
  if (dryRun) args.push('--dry-run');

  // 凭据只从环境变量来，只进进程参数，**永不落盘**（不写 .npmrc）
  const auth = process.env.NODE_AUTH_TOKEN
    ? ` "--//registry.npmjs.org/:_authToken=${process.env.NODE_AUTH_TOKEN}"`
    : '';

  console.log(`→ ${pkg}@${version} 发布中…`);

  const r = trySh(`npm ${args.join(' ')}${auth}`);
  if (!r.ok) {
    failures.push({ pkg, why: r.out.slice(0, 600) });
    console.error(`✗ ${pkg} 失败，后续包不再发（避免把依赖不全的包放上去）`);
    break;
  }
  console.log(`✓ ${pkg}@${version}`);
  published.push(`${pkg}@${version}`);
}

console.log('\n──────── 结果 ────────');
if (published.length) console.log(`${dryRun ? '演练通过（未上传）' : '已发'}：${published.join(', ')}`);
if (skipped.length) console.log(`跳过（已存在）：${skipped.join(', ')}`);
if (failures.length) {
  for (const f of failures) console.error(`失败：${f.pkg}\n${f.why}\n`);
  process.exit(1);
}
console.log('全部完成。');
