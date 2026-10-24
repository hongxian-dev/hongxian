#!/usr/bin/env node
/**
 * 按依赖顺序发布。发布顺序与「本次发/暂不发」清单只在 pack-check.mjs 里定义一次。
 *
 * 用法：
 *   node scripts/publish-all.mjs            # 真发（CI 里跑，需要 NODE_AUTH_TOKEN）
 *   node scripts/publish-all.mjs --dry-run  # 只演练，不传任何字节
 *
 * 为什么要防重复：同一个版本号第二次 publish 会被 registry 拒（409），
 * 但如果前一个包已发成功、后一个失败，重跑整个流程就会卡在已发的那个上。
 * 所以先查 registry，已存在的直接跳过并如实报告。
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PACKAGES } from './packages.mjs';

const dryRun = process.argv.includes('--dry-run');

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

  const args = ['publish', '-w', pkg, '--access', 'public', '--provenance'];
  if (dryRun) args.push('--dry-run');
  console.log(`→ ${pkg}@${version} 发布中…`);

  const r = trySh(`npm ${args.join(' ')}`);
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
