/**
 * 红线产品网站 · 静态验收（零依赖，node verify.mjs）
 *
 * 替换了旧版 playwright 回归：新站是单文件零请求，验收重点从"渲染"转为
 * "纪律可静态证明"——外链白名单、禁渐变禁投影、SEO/分享元信息、内容完整性。
 *
 * 退出码：0 全通过 / 1 有失败项
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');
const notFound = readFileSync(join(here, '404.html'), 'utf8');

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

/* ---------- 1. 单文件零外部资源 ---------- */
ok('无外部样式表', !/<link[^>]+rel=["']stylesheet/.test(html));
ok('无外部脚本', !/<script[^>]+src=/.test(html));
ok('无 webfont（@font-face / fonts.googleapis）', !/@font-face|fonts\.googleapis/.test(html));
ok('无 CSS 外部资源引用（url(http）', !/url\(\s*['"]?https?:/.test(html));

/* ---------- 2. 视觉纪律：禁渐变禁投影（宪法 §11 落地） ---------- */
for (const [label, re] of [
  ['无渐变（linear/radial-gradient）', /(linear|radial|conic)-gradient/],
  ['无投影（box-shadow / text-shadow）', /box-shadow|text-shadow/],
  ['无毛玻璃（backdrop-filter）', /backdrop-filter/],
]) {
  ok(label, !re.test(html));
}

/* ---------- 3. SEO / 分享元信息 ---------- */
ok('有 description', /<meta name="description" content="[^"]{20,}"/.test(html));
ok('有 canonical', /<link rel="canonical" href="https:\/\/hongxian\.dev\/"/.test(html));
ok('有 theme-color', /<meta name="theme-color" content="#C8102E"/.test(html));
ok('有 og:image（1200×630 封面）', /property="og:image" content="https:\/\/hongxian\.dev\/og-cover\.png"/.test(html));
ok('有 og:image 尺寸声明', /og:image:width" content="1200"/.test(html));
ok('有 twitter:card', /name="twitter:card" content="summary_large_image"/.test(html));
ok('og-cover.png 文件存在且 >20KB', statSync(join(here, 'og-cover.png')).size > 20 * 1024);

/* ---------- 4. 内容完整性（PRD §8 七区） ---------- */
for (const a of ['#top', '#how', '#demo', '#trust', '#stats', '#faq', '#install']) {
  ok(`锚点存在 ${a}`, html.includes(`id="${a.slice(1)}"`));
}
const details = (html.match(/<details/g) || []).length;
ok('FAQ 八问', details === 8, `实际 ${details}`);
ok('含陌生人安全问答（防骚扰）', html.includes('怎么防骚扰'));
ok('含密钥即身份问答（无手机号）', html.includes('怎么证明'));
ok('含五档报告样例', html.includes('比对报告样例') && html.includes('值得认识'));
ok(
  '五档可交互：tablist + 5 个 tab 绑定同一面板',
  html.includes('class="tiers" role="tablist"') &&
    (html.match(/role="tab"/g) || []).length === 5 &&
    (html.match(/aria-controls="repGrid"/g) || []).length === 5 &&
    html.includes('id="repGrid" role="tabpanel"'),
);
ok('五档各有判据与三区样例（无 JS 时默认档可读）', (html.match(/\{why:'/g) || []).length === 5);
ok('含 v1/v2 路线区分', html.includes('v2 · 参考实现已完成'));

/* ---------- 5. 透明数据区：键名与 Worker 契约一致 ---------- */
const keys = [...html.matchAll(/data-k="([a-z_]+)"/g)].map((m) => m[1]);
ok(
  '四个计数器键 = cards/active/env/plaza',
  keys.length === 4 && ['cards', 'active', 'env', 'plaza'].every((k) => keys.includes(k)),
  keys.join(','),
);
ok('兼容 Worker 的 site / counters 两代返回结构', /d\.site\|\|d\.counters/.test(html));
ok('计数器失败静默（catch 空处理）', /\.catch\(function\(\)\{\}\)/.test(html));

/* ---------- 6. 外链白名单 ---------- */
const hosts = new Set([...html.matchAll(/https?:\/\/([^/"'\s]+)/g)].map((m) => m[1]));
// www.w3.org 是 SVG 命名空间标识符（xmlns:xlink），不是网络请求
const allowed = new Set(['hongxian.dev', 'github.com', 'count.hongxian.dev', 'www.w3.org']);
const illegal = [...hosts].filter((h) => !allowed.has(h));
ok('外链仅 hongxian.dev / github.com / count.hongxian.dev', illegal.length === 0, illegal.join(','));

/* ---------- 7. 品牌资产：不引用已退役的旧标文件 ---------- */
ok('无旧标资源引用（assets/img/、hongxian-mark）', !/assets\/img\/|hongxian-mark/.test(html));
ok('内嵌吉祥物符号（M4 线团之心路径存在）', html.includes('M120 200C70 164 36 128 36 92'));
ok('内嵌 M1 额印星芒（#F08200 五角星路径）', /#F08200/.test(html));

/* ---------- 8. 404 页同规范 ---------- */
ok('404 页自包含（无外部样式/脚本）', !/rel=["']stylesheet|<script[^>]+src=/.test(notFound));
ok('404 页无渐变无投影', !/(linear|radial)-gradient|box-shadow/.test(notFound));

/* ---------- 9. 体积 ---------- */
const kb = statSync(join(here, 'index.html')).size / 1024;
ok('首页 < 80KB（单文件零依赖）', kb < 80, `${kb.toFixed(1)}KB`);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
