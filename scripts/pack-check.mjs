#!/usr/bin/env node
/**
 * 发布前体检：把每个包真的打一次 tarball（不上传），逐个文件核对。
 *
 * 用途：本地跑 `npm run pack:check`，在推 tag 之前把「包里少了 README」「src 漏进去」
 * 这类问题发现出来。CI 里也在发布前跑一遍。
 *
 * 顺序只在这里定义一次——release.yml 和本地都走 scripts/publish-all.mjs，
 * 不各自维护一份列表，否则改版时必然漂移。
 */
import { execSync } from 'node:child_process';
import { PACKAGES, PUBLISH_ORDER, NOT_YET } from './packages.mjs';

const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts'];
const FORBIDDEN = [/^src\//, /^test\//, /^e2e\//, /^data\//, /\.env$/, /^node_modules\//, /\.ts$/];

function packOne(pkg) {
  const raw = execSync(`npm pack --dry-run --json -w ${pkg}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const info = JSON.parse(raw)[0];
  const paths = info.files.map((f) => f.path.replace(/\\/g, '/'));
  return { info, paths };
}

let failed = 0;
const rows = [];

for (const pkg of PUBLISH_ORDER) {
  const { info, paths } = packOne(pkg);
  const missing = REQUIRED.filter((f) => !paths.includes(f));
  // .d.ts 是合法的 .ts 结尾，别被 FORBIDDEN 的 /\.ts$/ 误伤
  const stray = paths.filter((p) => FORBIDDEN.some((re) => re.test(p)) && !p.endsWith('.d.ts'));

  const problems = [];
  if (missing.length) problems.push(`缺 ${missing.join(', ')}`);
  if (stray.length) problems.push(`不该发 ${stray.slice(0, 4).join(', ')}`);
  // 每个包都应该自带 LICENSE，缺了等于没随包分发授权文本
  if (!paths.includes('LICENSE')) problems.push('LICENSE 不在 tarball 里');

  rows.push({
    pkg,
    version: info.version,
    files: paths.length,
    size: `${(info.size / 1024).toFixed(1)} kB`,
    state: problems.length ? `✗ ${problems.join('；')}` : '✓',
  });
  if (problems.length) failed += 1;
}

const w = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0)));
console.log(`\n${w('包', 22)}${w('版本', 8)}${w('文件', 6)}${w('压缩后', 12)}结果`);
console.log('─'.repeat(78));
for (const r of rows) console.log(w(r.pkg, 22) + w(r.version, 8) + w(r.files, 6) + w(r.size, 12) + r.state);

if (NOT_YET.length) {
  console.log(`\n· 本次不发布（配置已就绪，等拍板）：${NOT_YET.map((p) => p.name).join(', ')}`);
}

console.log('');
if (failed) {
  console.error(`✗ ${failed} 个包不达标，先修好再发`);
  process.exit(1);
}
console.log(`✓ ${PUBLISH_ORDER.length} 个包 tarball 全部合格`);
