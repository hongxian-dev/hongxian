#!/usr/bin/env node
/**
 * 发包前最后一道闸（prepublishOnly 自动触发）。
 *
 * 为什么需要它：npm 允许发布一个只有 package.json 的空包，而版本号一旦
 * 发出去 72 小时后就永久占用、删不掉。空包比报错难看得多。
 *
 * 这个脚本只做「能不能发」的判断，不做构建——构建由 release.yml 或
 * 本地 `npm run build` 负责，避免在 prepublishOnly 里重复跑 tsc 造成顺序混乱。
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const cwd = process.cwd();
const errors = [];
const notes = [];

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const pkg = readJson(join(cwd, 'package.json'));
if (!pkg) {
  console.error('✗ 当前目录没有可解析的 package.json');
  process.exit(1);
}

const name = pkg.name ?? '(未命名)';

// 1. 身份与版本
if (!name.startsWith('@hongxian/')) errors.push(`包名不合规：${name}（应为 @hongxian/*）`);
if (!/^\d+\.\d+\.\d+/.test(pkg.version ?? '')) errors.push(`version 不合法：${pkg.version}`);
if (pkg.version === '0.0.0') errors.push('version 仍是 0.0.0，先跑 npm run bump');
if (pkg.private === true) errors.push('package.json 标了 private:true，发不出去');

// 2. provenance 的三个前置条件（缺任何一个，CI 里都会在发布那一刻报错）
if (!pkg.repository?.url) errors.push('缺 repository 字段——provenance 要求它指向公开仓库');
if (!pkg.repository?.directory) notes.push('repository.directory 未填（monorepo 建议填）');
if (pkg.publishConfig?.access !== 'public') {
  errors.push('publishConfig.access 不是 public——scoped 包默认按私有发布，会被当成收费团队包拒掉');
}

// 3. 产物必须真的存在
const dist = join(cwd, 'dist');
if (!existsSync(dist)) {
  errors.push('dist/ 不存在，先跑 npm run build');
} else if (readdirSync(dist).length === 0) {
  errors.push('dist/ 是空的');
} else {
  if (!existsSync(join(dist, 'index.js'))) errors.push('dist/index.js 不存在');
  if (!existsSync(join(dist, 'index.d.ts'))) errors.push('dist/index.d.ts 不存在（缺类型声明）');

  // 构建不完整时 typetsc 会静默跳过——检查有没有源文件漏编译成 .js
  const stray = readdirSync(dist, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  if (stray.length) errors.push(`dist/ 里有未编译的 .ts：${stray.slice(0, 3).join(', ')}`);
}

// 4. bin 必须有 shebang，否则 npx 装上直接报语法错
if (pkg.bin) {
  for (const [binName, target] of Object.entries(pkg.bin)) {
    const f = join(cwd, target);
    if (!existsSync(f)) {
      errors.push(`bin "${binName}" 指向的 ${target} 不存在`);
      continue;
    }
    const first = readFileSync(f, 'utf8').split('\n', 1)[0] ?? '';
    if (!first.startsWith('#!')) errors.push(`bin "${binName}" 的 ${target} 首行没有 shebang`);
    if (!statSync(f).isFile()) errors.push(`bin "${binName}" 指向的不是文件`);
  }
}

// 5. npm 页面与法律文本：两者缺一个，装包的人就看不到
if (!existsSync(join(cwd, 'README.md'))) errors.push('缺 README.md——npm 页面会是一片空白');
if (!pkg.license) errors.push('缺 license 字段');
else if (!/^(Apache|AGPL|MIT|BSD)/.test(pkg.license)) notes.push(`license 值不常见：${pkg.license}`);
if (!existsSync(join(cwd, 'LICENSE'))) {
  errors.push('缺 LICENSE 文件——npm 不会从仓库根目录继承，必须每个包自带一份');
}

// 6. 别把不该发的东西带出去
const files = pkg.files;
if (!Array.isArray(files) || !files.includes('dist')) {
  errors.push('files 字段必须显式包含 dist，否则会按 .gitignore 反向推断，容易漏或带多');
}
for (const bad of ['src', 'test', 'e2e', '.env', 'data']) {
  if (files?.some((f) => f === bad || f.startsWith(`${bad}/`))) errors.push(`files 里出现了不该发布的目录：${bad}`);
}
if (existsSync(join(cwd, '.env'))) errors.push('包目录里有 .env，先确认它不会被打包（检查 .npmignore / files）');

// 7. 依赖不能指向工作区别名
for (const [dep, ver] of Object.entries(pkg.dependencies ?? {})) {
  if (String(ver).startsWith('workspace:')) errors.push(`依赖 ${dep} 用了 workspace: 协议，npm 不认`);
  if (String(ver).startsWith('file:')) errors.push(`依赖 ${dep} 用了 file: 协议，发出去装不上`);
}

if (notes.length) for (const n of notes) console.log(`· ${n}`);

if (errors.length) {
  console.error(`\n✗ ${name} 不能发布，${errors.length} 个问题：`);
  for (const e of errors) console.error(`   - ${e}`);
  console.error('');
  process.exit(1);
}

console.log(`✓ ${name}@${pkg.version} 通过发布前检查`);
