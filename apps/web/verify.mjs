/**
 * 红线产品网站 · 静态验收（零依赖，node verify.mjs）
 *
 * 替换了旧版 playwright 回归：新站是单文件零请求（唯一外部资源 = 页脚赞赏码
 * sponsor-qr.png，扫码质量要求真图，不能内联 base64 到 HTML），验收重点从"渲染"
 * 转为"纪律可静态证明"——外链白名单、禁渐变禁投影、SEO/分享元信息、内容完整性、
 * 赞助合规、Hero 动效降级。
 *
 * 退出码：0 全通过 / 1 有失败项
 */

import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
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
/* FAQ 的折叠块单独数：全页 <details> 计数会被别处的折叠块带偏（安装区「复制前先看一眼」也是 details）。
   断言的本意是「FAQ 恰好八问」，所以只数 FAQ 区间内的。 */
const faqStart = html.indexOf('id="faq"');
const faqEnd = html.indexOf('</section>', faqStart);
const faqHtml = faqStart >= 0 && faqEnd > faqStart ? html.slice(faqStart, faqEnd) : '';
const details = (html.match(/<details/g) || []).length;
const faqCount = (faqHtml.match(/<details/g) || []).length;
ok('FAQ 八问', faqCount === 8, `实际 ${faqCount}（全页 details 共 ${details}）`);
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
ok(
  '含三条边界（不反向追踪 / 不打分 / 不留存）',
  ['不反向追踪', '不打分', '不留存'].every((t) => html.includes(t)),
);

/* ---------- 5. 透明数据区：键名与 Worker 契约一致 ---------- */
const keys = [...html.matchAll(/data-k="([a-z_]+)"/g)].map((m) => m[1]);
ok(
  '四个计数器键 = cards/imports/env/plaza',
  keys.length === 4 && ['cards', 'imports', 'env', 'plaza'].every((k) => keys.includes(k)),
  keys.join(','),
);
ok('兼容 Worker 的 site / counters 两代返回结构', /\(d&&d\.site\)/.test(html) && /\(d&&d\.counters\)/.test(html));
ok('计数器取不到时标注「数据源暂不可达」，不静默', /数据源暂不可达/.test(html));
ok('透明数据区不写死示例值（防假数据回潮）', !/SAMPLE=/.test(html));

/* ---------- 6. 外链白名单 ---------- */
const hosts = new Set([...html.matchAll(/https?:\/\/([^/"'\s]+)/g)].map((m) => m[1]));
// www.w3.org 是 SVG 命名空间标识符（xmlns:xlink），不是网络请求
const allowed = new Set(['hongxian.dev', 'github.com', 'count.hongxian.dev', 'www.w3.org', 'afdian.com']);
const illegal = [...hosts].filter((h) => !allowed.has(h));
ok('外链仅 hongxian.dev / github.com / count.hongxian.dev / afdian.com', illegal.length === 0, illegal.join(','));

/* ---------- 7. 品牌资产：不引用已退役的旧标文件 ---------- */
ok('无旧标资源引用（assets/img/、hongxian-mark）', !/assets\/img\/|hongxian-mark/.test(html));
ok('内嵌吉祥物符号（M4 线团之心路径存在）', html.includes('M120 200C70 164 36 128 36 92'));
ok('内嵌 M1 额印星芒（#F08200 五角星路径）', /#F08200/.test(html));

/* ---------- 8. 404 页同规范 ---------- */
ok('404 页自包含（无外部样式/脚本）', !/rel=["']stylesheet|<script[^>]+src=/.test(notFound));
ok('404 页无渐变无投影', !/(linear|radial)-gradient|box-shadow/.test(notFound));

/* ---------- 9. 赞助区合规（2026-10-21 定稿：爱发电为主 + 微信赞赏码为辅） ----------
 * 背景：央行 259 号文禁止个人静态收款码用于远程非面对面收款；GitHub Sponsors 大陆区
 * 不可收款；「礼金/谢媒礼」措辞与宪法 §12 不收费婚介费用的承诺冲突。
 * 孙超拍板：主通道爱发电（待开通），同时展示微信官方「赞赏码」收自愿打赏。
 * 赞赏码 ≠ 收款码：微信官方个人非商业性赞赏工具，规则禁止用于商业交易与代收款，
 * 单笔上限 200 元。一旦出现"付费换服务/优先匹配"即为越界，故对价声明为硬断言。 */
const spStart = html.indexOf('id="sponsor"');
const spEnd = html.indexOf('class="wrap foot-in"');
const sp = spStart > -1 && spEnd > spStart ? html.slice(spStart, spEnd) : '';
ok('赞助区存在且位于页脚（物理隔离于产品区）', sp.length > 300, `${sp.length} 字符`);
ok('赞赏码为站内本地图片（唯一外部资源）', /<img src="sponsor-qr\.png"/.test(sp));
ok('赞赏码图片文件存在且 < 60KB', statSync(join(here, 'sponsor-qr.png')).size < 60 * 1024, `${(statSync(join(here, 'sponsor-qr.png')).size / 1024).toFixed(1)}KB`);
ok('赞赏码有可读 alt（无障碍 / 长按识别）', /alt="微信赞赏码[^"]*"/.test(sp));
ok('赞赏码可放大（dialog + showModal）', html.includes('id="qrDlg"') && html.includes('showModal'));
ok('无个人收款码 / 付款码（赞赏码为官方非商业性工具）', !/收款码图片|付款码|收钱码|二维码收款/.test(html));
ok('全站无婚介收款措辞（礼金 / 谢媒礼 / 彩礼 / 介绍费）', !/礼金|谢媒礼|彩礼|介绍费/.test(html));
ok('赞助明示不换取对价', sp.includes('不换取任何服务、优先权或匹配机会'));
ok('赞赏通道标注「自愿、无对价」', sp.includes('自愿、无对价'));
ok('爱发电通道保留（GitHub Sponsors 大陆不可收款，已移除）', sp.includes('爱发电') && !/GitHub Sponsors/.test(html));
ok('爱发电入口带 TODO 标记（开通后替换 href）', sp.includes('TODO(sponsor)'));

/* ---------- 10. Hero 主图：结构与动效降级 ---------- */
const hero = (html.match(/<svg viewBox="0 92 560 296"[\s\S]*?<\/svg>/) || [''])[0];
ok('Hero 图存在且为内联 SVG', hero.length > 1500, `${hero.length} 字符`);
ok('信号流两段（主—月老双向流动）', (hero.match(/attributeName="stroke-dashoffset"/g) || []).length === 2);
ok('信封只在月老之间往返（animateMotion + mpath）', hero.includes('<animateMotion') && hero.includes('mpath'));
ok('信封不越界到主人一侧（keyPoints 往返而非单程）', /keyPoints="0;1;0"/.test(hero));
ok('握手区用品牌红密虚线', /stroke="#C8102E" stroke-width="3" stroke-dasharray="6 3\.5"/.test(hero));
ok('prefers-reduced-motion 显式暂停 SMIL（CSS 无法接管）', html.includes('pauseAnimations'));
ok('Hero 无渐变无投影', !/(linear|radial)-gradient|filter=|drop-shadow|feGaussianBlur/.test(hero));

/* ---------- 11. 发布验证页（C17：广场贴卡的发布确认） ----------
 * 这一页是"平台唯一接收明文个人信息"的入口，验收重点不是好看，是**把话说清**：
 * 明确不是实名认证、明确拒绝也能用产品、明确收不到信怎么办。
 * 说少了会造成两种误解：以为要实名（吓走人）、或以为已验证身份（虚假安全感）。
 */
const pvPath = join(here, 'publish-verify', 'index.html');
let pv = '';
try {
  pv = readFileSync(pvPath, 'utf8');
} catch {
  pv = '';
}
ok('发布验证页存在', pv.length > 1500, pv ? `${pv.length} 字符` : '缺失');
ok('发布验证页自包含（无外部样式/脚本/字体）', !/rel=["']stylesheet|<script[^>]+src=|@font-face/.test(pv));
ok('发布验证页无渐变无投影无毛玻璃', !/(linear|radial)-gradient|box-shadow|text-shadow|backdrop-filter/.test(pv));
ok('发布验证页不被搜索引擎收录', /<meta name="robots" content="noindex">/.test(pv));
ok('发布验证页明示「不是实名认证」', pv.includes('不是实名认证'));
ok('发布验证页明示「不想验证也完全可以」', pv.includes('不想验证') && pv.includes('完全可以'));
ok('发布验证页给出垃圾箱与换 Gmail 的建议', pv.includes('垃圾箱') && pv.includes('Gmail'));
ok('发布验证页提示许可码无 0/O/1/I/L（抄错的主因）', pv.includes('没有 0、O、1、I、L'));
ok('发布验证页三步齐全（邮箱 → 验证码 → 许可码）', pv.includes('/v2/publish/otp') && pv.includes('/v2/publish/verify') && pv.includes('action=claim'));
ok('发布验证页失败不静默（逐状态码给人话）', pv.includes('humanError') && pv.includes('429'));
ok('发布验证页链接不完整时给出重来路径', pv.includes('这个链接不完整') && pv.includes('action=verify'));

/* 防护三（C2③）：披露声明必须在这一页可读——不装工具、不跑 JS 也能读完。
 * 判据是"那段边界有没有写"：不写就等于隐含承诺"绝对不可关联"，
 * 出事那天这句话会被原文引用为虚假宣传。 */
ok('发布验证页含披露声明全文（不装工具也能读）', pv.includes('贴到广场，会多出一条连接') && pv.includes('先说清楚'));
ok('发布验证页写明「存的是哈希、不可逆」', pv.includes('单向、不可逆'));
ok('发布验证页写明平台不知道你是谁', pv.includes('不验证你是谁') && pv.includes('不声称做到了'));
ok(
  '发布验证页写出边界（承认理论上可关联，不做绝对承诺）',
  pv.includes('边界在哪') && pv.includes('不是"绝对不可能"') && pv.includes('哈希防的是'),
);
ok('发布验证页给出「不贴广场」这条替代路径', pv.includes('只在认识的人之间换卡') && pv.includes('什么都不会多出来'));
ok(
  '发布验证页有勾选行且默认未勾',
  /<input type="checkbox" id="ackbox">/.test(pv) && !/id="ackbox"[^>]*\schecked/.test(pv),
);
ok('发布验证页未勾选前不发验证码（sendBtn.disabled）', pv.includes("sendBtn.disabled = true"));

/* ---------- 12. 体积 ---------- */
// 80KB → 100KB（2026-10-25 v2 改版）→ 110KB（安装区改「复制提示词」）：
// 页面已有 8 屏 + 17 处自绘 SVG，raw 98KB。真正被下载的是 gzip 后 29KB，
// 所以运输体积另立一条 gzip 断言（这才是用户实际付的流量）；
// raw 上限只防「往单文件里塞库或大段 base64」，不承担性能判断。
const rawBuf = readFileSync(join(here, 'index.html'));
const kb = rawBuf.length / 1024;
ok('首页 raw < 110KB（单文件 + 一张赞赏码）', kb < 110, `${kb.toFixed(1)}KB`);
const gzKb = gzipSync(rawBuf, { level: 9 }).length / 1024;
ok('首页 gzip < 40KB（实际传输体积）', gzKb < 40, `${gzKb.toFixed(1)}KB`);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
