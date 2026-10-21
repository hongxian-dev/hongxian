#!/usr/bin/env node
/**
 * PRD → 单文件 HTML（可离线双击打开）
 *
 * 为什么需要它：markdown 版 PRD 的 14 张 SVG 配图在多数编辑器里不渲染，
 * 阅读体验差。本脚本把 markdown 编译成一份**零外部请求**的 HTML：
 * 图片以 data URI 内嵌、样式与脚本内联，发给谁都能打开。
 *
 * 用法：
 *   node docs/build-prd-html.mjs            # 从仓库根执行
 *   npm run prd
 *
 * 约定：真源永远是 .md，HTML 是产物——不要手改 HTML。
 *
 * 设计纪律（对齐《定位声明》§11 与网站 DESIGN-NOTES）：
 *   零渐变、零投影、零毛玻璃、零 webfont；层次靠明暗版面交替 + 1px 线面。
 *   色板：#C8102E 主 / #A60F26 深线 / #EF8A97 浅玫瑰 / #F08200 结点橙 / #1F2937 墨 / #FDFBF7 纸白
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SRC = join(HERE, '00-定位与PRD', '红线开源工具PRD.md');
const OUT = join(HERE, '00-定位与PRD', '红线开源工具PRD.html');

// ───────────────────────────── 工具函数 ─────────────────────────────

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

/** 段内元素：code → strong → em → link（code 先占位，避免被后续规则改写） */
function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const ext = /^https?:/.test(href);
    return `<a href="${href}"${ext ? ' target="_blank" rel="noopener"' : ''}>${label}</a>`;
  });
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  return s;
}

/** 图片 → data URI（文档迁入子目录后相对路径会断，这里按 md 目录 → 仓库根 依次回退） */
const imgCache = new Map();
function imageDataUri(src) {
  if (imgCache.has(src)) return imgCache.get(src);
  const candidates = [resolve(dirname(SRC), src), resolve(dirname(SRC), '..', src), resolve(REPO, src)];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) {
    console.warn(`  ! 找不到配图：${src}`);
    imgCache.set(src, null);
    return null;
  }
  const buf = readFileSync(hit);
  const ext = hit.split('.').pop().toLowerCase();
  const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : `image/${ext}`;
  const uri = `data:${mime};base64,${buf.toString('base64')}`;
  imgCache.set(src, uri);
  return uri;
}

// ───────────────────────────── Markdown 解析 ─────────────────────────────
//
// 只实现本文档用到的子集：h1/h2/h3、段落、表格、围栏代码、引用、有序/无序列表、
// 分隔线、独立图片。刻意不引第三方依赖——文档形态稳定，少一个供应链。

function parse(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  const flushParagraph = (buf) => {
    if (!buf.length) return;
    const text = buf.reduce((acc, line, idx) => {
      if (idx === 0) return line;
      const prev = acc.slice(-1);
      return acc + (CJK.test(prev) || CJK.test(line[0]) ? '' : ' ') + line;
    }, '');
    const img = text.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) {
      blocks.push({ type: 'figure', alt: img[1], src: img[2] });
      return;
    }
    const wholeBold = text.match(/^\*\*([^*]+)\*\*$/);
    if (wholeBold) {
      blocks.push({ type: 'creed', text: wholeBold[1] });
      return;
    }
    blocks.push({ type: 'p', text });
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 空行
    if (!trimmed) {
      i++;
      continue;
    }

    // 围栏代码
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', lang, body: body.join('\n') });
      continue;
    }

    // 标题
    const h = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      blocks.push({ type: `h${h[1].length}`, text: h[2].trim() });
      i++;
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // 引用（连续 > 行合并）
    if (trimmed.startsWith('>')) {
      const body = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        body.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', lines: body.filter((l) => l !== '') });
      continue;
    }

    // 表格
    if (trimmed.startsWith('|') && /^\|[\s:|-]+\|$/.test((lines[i + 1] || '').trim())) {
      const cells = (row) =>
        row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(lines[i]);
      const align = cells(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''
      );
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      blocks.push({ type: 'table', head, align, rows });
      continue;
    }

    // 列表
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        const m = cur.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (m) {
          items.push({ indent: m[1].length, text: m[3] });
          i++;
          continue;
        }
        // 列表项的续行（非空且不是其他块）
        if (cur.trim() && !/^(#{1,3}\s|>|\||```)/.test(cur.trim()) && items.length) {
          items[items.length - 1].text += cur.trim();
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // 段落
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3}\s|>|\||```|-{3,}$)/.test(lines[i].trim()) &&
      !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i])
    ) {
      buf.push(lines[i].trim());
      i++;
    }
    flushParagraph(buf);
  }

  return blocks;
}

// ───────────────────────────── 渲染 ─────────────────────────────

function render(blocks) {
  const toc = [];
  const body = [];
  let h2n = 0;
  let headingId = 0;
  let figN = 0;
  let frontmatterPending = false;
  const stats = { figures: 0, tables: 0, sections: 0, subsections: 0, codes: 0 };

  // 跳过原 markdown 的手写目录（由侧边栏接管）
  let skipping = false;

  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];

    if (b.type === 'h2' && /^目录$/.test(b.text)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      // 目录之后的第一个 hr 结束跳过区间
      if (b.type === 'hr') skipping = false;
      continue;
    }

    if (b.type === 'h1') {
      // 标题由 Hero 承担；正文里的 h1 只用来定位「文档说明」块
      frontmatterPending = true;
      continue;
    }

    if (b.type === 'h2') {
      h2n++;
      const id = `s${h2n}`;
      stats.sections++;
      const label = b.text.replace(/^\d+\.\s*/, '');
      toc.push({ id, label: b.text, num: String(h2n).padStart(2, '0'), level: 2, children: [] });
      body.push(
        `<h2 id="${id}"><span class="h2-num">${String(h2n).padStart(2, '0')}</span><span class="h2-text">${inline(
          label
        )}</span></h2>`
      );
      continue;
    }

    if (b.type === 'h3') {
      headingId++;
      const id = `h${headingId}`;
      stats.subsections++;
      const parent = toc[toc.length - 1];
      if (parent) parent.children.push({ id, label: b.text, level: 3 });
      body.push(`<h3 id="${id}">${inline(b.text)}</h3>`);
      continue;
    }

    if (b.type === 'p') {
      body.push(`<p>${inline(b.text)}</p>`);
      continue;
    }

    if (b.type === 'creed') {
      body.push(`<p class="creed">「${inline(b.text)}」</p>`);
      continue;
    }

    if (b.type === 'quote') {
      if (frontmatterPending) {
        frontmatterPending = false;
        body.push(
          `<aside class="frontmatter"><b class="fm-label">文档说明</b>${b.lines
            .map((l) => `<p>${inline(l)}</p>`)
            .join('')}</aside>`
        );
        continue;
      }
      body.push(
        `<blockquote>${b.lines.map((l) => `<p>${inline(l)}</p>`).join('')}</blockquote>`
      );
      continue;
    }

    if (b.type === 'code') {
      stats.codes++;
      body.push(
        `<pre class="code"${b.lang ? ` data-lang="${esc(b.lang)}"` : ''}><code>${esc(
          b.body
        )}</code></pre>`
      );
      continue;
    }

    if (b.type === 'hr') {
      body.push('<hr />');
      continue;
    }

    if (b.type === 'figure') {
      const uri = imageDataUri(b.src);
      const m = b.alt.match(/^(图\s*[\d-]+)\s*(.*)$/);
      const no = m ? m[1] : '';
      const cap = m ? m[2] : b.alt;
      if (uri) {
        stats.figures++;
        figN++;
        body.push(
          `<figure class="fig"><img src="${uri}" alt="${esc(b.alt)}" loading="lazy" />` +
            `<figcaption>${no ? `<span class="fig-no">${esc(no)}</span>` : ''}${
              cap ? esc(cap) : `配图 ${figN}`
            }</figcaption></figure>`
        );
      } else {
        body.push(`<p class="fig-missing">〔配图缺失：${esc(b.src)}〕</p>`);
      }
      continue;
    }

    if (b.type === 'table') {
      stats.tables++;
      const al = (i) => (b.align[i] ? ` style="text-align:${b.align[i]}"` : '');
      // 短单元格禁止折行：CJK 可在任意字符间断行，否则「可选」「段」「2026-10-20」会被压成竖排
      const nw = (raw) => (raw.length <= 14 && !/\s/.test(raw) ? ' class="nw"' : '');
      const head = b.head.map((c, i) => `<th${al(i)}>${inline(c)}</th>`).join('');
      const rows = b.rows
        .map(
          (r) =>
            `<tr>${r.map((c, i) => `<td${nw(c)}${al(i)}>${inline(c)}</td>`).join('')}</tr>`
        )
        .join('');
      body.push(
        `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
      );
      continue;
    }

    if (b.type === 'list') {
      const tag = b.ordered ? 'ol' : 'ul';
      const baseIndent = Math.min(...b.items.map((it) => it.indent));
      let html = `<${tag}${b.ordered ? ' class="steps"' : ''}>`;
      let open = false;
      for (const it of b.items) {
        const nested = it.indent > baseIndent;
        if (nested && !open) {
          html += '<ul class="sub">';
          open = true;
        } else if (!nested && open) {
          html += '</ul>';
          open = false;
        }
        html += `<li>${inline(it.text)}</li>`;
      }
      if (open) html += '</ul>';
      html += `</${tag}>`;
      body.push(html);
    }
  }

  return { html: body.join('\n'), toc, stats };
}

// ───────────────────────────── 模板 ─────────────────────────────

function page({ html, toc, stats, meta }) {
  const nav = toc
    .map(
      (s) => `<li class="lvl2">
  <a href="#${s.id}"><span class="n">${s.num}</span><span class="t">${esc(
        s.label
      )}</span></a>
  ${
    s.children.length
      ? `<ul class="subs">${s.children
          .map((c) => `<li><a href="#${c.id}">${esc(c.label)}</a></li>`)
          .join('')}</ul>`
      : ''
  }
</li>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>红线开源工具 · 产品需求文档（PRD）v${meta.version}</title>
<meta name="description" content="红线开源工具 PRD：开源、免费的 AI Agent 婚恋匹配基础设施——客户端月老 Skill + 服务端红线平台 + 红线协议。" />
<meta name="color-scheme" content="light" />
<link rel="icon" href="${meta.icon}" />
<style>
/* ── 纸信 · 红线 ────────────────────────────────────────────
   零渐变 / 零投影 / 零毛玻璃 / 零 webfont：层次靠明暗版面与 1px 线面
   ────────────────────────────────────────────────────────── */
:root{
  --paper:#FDFBF7; --paper-2:#F7F2E8; --paper-3:#F1EADC; --paper-4:#EAE1CF;
  --ink:#1F2937; --ink-2:#48525F; --ink-3:#78828F;
  --red:#C8102E; --deep:#A60F26; --rose:#EF8A97; --orange:#F08200;
  --line:#E6DDCD; --line-2:#D6C8B1;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif;
  --mono:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace;
  --serif:Georgia,"Times New Roman","Songti SC","SimSun",serif;
  --nav:288px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;background:var(--paper);color:var(--ink);
  font-family:var(--sans);font-size:15.5px;line-height:1.82;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
}
::selection{background:#F8D9DE;color:var(--deep)}

/* ── 进度条 ── */
.progress{position:fixed;inset:0 auto auto 0;height:2px;width:100%;z-index:60;background:transparent}
.progress i{display:block;height:2px;width:0;background:var(--red);transition:width .12s linear}

/* ── 侧边导航 ── */
.nav{
  position:fixed;top:0;left:0;bottom:0;width:var(--nav);z-index:50;
  background:var(--paper-2);border-right:1px solid var(--line);
  display:flex;flex-direction:column;
}
.nav-head{padding:22px 20px 16px;border-bottom:1px solid var(--line)}
.nav-mark{display:flex;align-items:center;gap:9px;font-weight:800;font-size:14.5px;letter-spacing:.02em}
.nav-mark .dot{width:9px;height:9px;border-radius:50%;background:var(--red);flex:none}
.nav-mark .en{font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;color:var(--ink-3);text-transform:uppercase;font-weight:600}
.nav-sub{margin:7px 0 0;font-size:11.5px;color:var(--ink-3);letter-spacing:.02em}
.nav-scroll{overflow-y:auto;padding:12px 0 40px;flex:1;scrollbar-width:thin}
.nav ol,.nav ul{list-style:none;margin:0;padding:0}
.nav .lvl2>a{
  display:flex;gap:9px;align-items:baseline;
  padding:7px 20px;border-left:2px solid transparent;
  color:var(--ink-2);text-decoration:none;font-size:13px;line-height:1.5;
}
.nav .lvl2>a:hover{background:var(--paper-3);color:var(--ink)}
.nav .lvl2>a .n{font-family:var(--mono);font-style:normal;font-size:10px;color:var(--rose);flex:none;min-width:16px;letter-spacing:.06em;padding-top:2px}
.nav .lvl2>a .t{display:block}
.nav .lvl2.active>a{border-left-color:var(--red);background:#FBF1EE;color:var(--deep);font-weight:700}
.nav .lvl2.active>a .n{color:var(--red)}
.nav .subs{margin:2px 0 6px}
.nav .subs a{
  display:block;padding:4px 20px 4px 44px;font-size:12px;line-height:1.5;
  color:var(--ink-3);text-decoration:none;border-left:2px solid transparent;
}
.nav .subs a:hover{color:var(--ink);background:var(--paper-3)}
.nav .subs a.active{color:var(--deep);background:#FBF1EE;border-left-color:var(--rose);font-weight:600}
.nav-foot{padding:14px 20px;border-top:1px solid var(--line);font-size:11px;color:var(--ink-3);line-height:1.7}
.nav-foot b{color:var(--ink-2);font-weight:600}

/* ── 主体 ── */
.main{margin-left:var(--nav);min-height:100vh}
.wrap{max-width:840px;margin:0 auto;padding:0 40px 40px}

/* Hero */
.hero{padding:64px 0 0;border-bottom:1px solid var(--line);margin-bottom:8px}
.eyebrow{
  font-family:var(--mono);font-size:10.5px;letter-spacing:.22em;text-transform:uppercase;
  color:var(--rose);font-weight:700;display:flex;align-items:center;gap:10px;
}
.eyebrow::after{content:"";flex:1;height:1px;background:var(--line-2)}
h1{font-size:40px;line-height:1.22;font-weight:900;letter-spacing:-.02em;margin:18px 0 0}
h1 .thin{color:var(--ink-3);font-weight:300}
.hero-lede{margin:16px 0 0;font-size:16px;color:var(--ink-2);max-width:46em}
.hero-lede strong{color:var(--deep);font-weight:700}
.meta{
  display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
  gap:0;margin:30px 0 0;border-top:1px solid var(--line);
}
.meta div{padding:14px 16px 14px 0;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--ink-2)}
.meta dt{font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);margin-bottom:4px}
.meta dd{margin:0;font-size:13px;color:var(--ink);font-weight:600}
.stats{display:flex;flex-wrap:wrap;gap:0;margin:0 0 4px;border-bottom:1px solid var(--line)}
.stats span{padding:12px 22px 12px 0;font-size:12px;color:var(--ink-3);letter-spacing:.02em}
.stats b{font-family:var(--serif);font-style:italic;font-size:17px;color:var(--red);font-weight:400;margin-right:5px}

/* 正文排版 */
.doc{padding-top:26px}
.doc h2{
  position:relative;margin:64px 0 20px;padding-top:22px;border-top:1px solid var(--line-2);
  font-size:26px;line-height:1.35;font-weight:800;letter-spacing:-.01em;
  display:flex;gap:14px;align-items:baseline;scroll-margin-top:20px;
}
.doc h2 .h2-num{
  font-family:var(--mono);font-style:normal;font-weight:600;font-size:11.5px;
  color:var(--red);letter-spacing:.1em;flex:none;padding-top:2px;
}
.doc h2 .h2-text{display:block}
.doc h3{
  margin:36px 0 12px;font-size:18.5px;line-height:1.5;font-weight:750;letter-spacing:-.005em;
  color:var(--ink);scroll-margin-top:20px;
}
.doc h3::before{
  content:"";display:inline-block;width:7px;height:7px;background:var(--red);
  margin-right:10px;vertical-align:2px;
}
.doc p{margin:0 0 14px}
.doc strong{font-weight:700;color:#141B26}
.doc em{font-style:italic;color:var(--ink-2)}
.doc a{color:var(--red);text-decoration:none;border-bottom:1px solid rgba(200,16,46,.32)}
.doc a:hover{border-bottom-color:var(--red);background:#FDF1F2}
.doc code{
  font-family:var(--mono);font-size:.875em;background:var(--paper-3);
  border:1px solid var(--line);border-radius:2px;padding:1px 5px;color:var(--deep);
  white-space:nowrap;
}
.doc ul,.doc ol{margin:0 0 16px;padding-left:22px}
.doc li{margin:0 0 8px}
.doc li::marker{color:var(--red)}
.doc ol.steps{counter-reset:step;list-style:none;padding-left:0}
.doc ol.steps>li{counter-increment:step;position:relative;padding-left:30px}
.doc ol.steps>li::before{
  content:counter(step);position:absolute;left:0;top:3px;
  width:19px;height:19px;border:1px solid var(--red);border-radius:50%;
  font-family:var(--mono);font-size:10.5px;line-height:17px;text-align:center;color:var(--red);
}
.doc ul.sub{margin:8px 0 8px;padding-left:18px}
.doc ul.sub li::marker{color:var(--rose)}
.doc hr{border:0;border-top:1px solid var(--line);margin:36px 0}

/* 引用 / 定位句 */
.doc blockquote{
  margin:20px 0;padding:2px 0 2px 18px;border-left:2px solid var(--red);
  color:var(--ink-2);font-size:14.5px;
}
.doc blockquote p{margin:0 0 8px}
.doc blockquote p:last-child{margin:0}
.doc .creed{
  margin:26px 0 28px;padding:18px 20px;background:var(--paper-2);
  border-left:3px solid var(--red);border-right:1px solid var(--line);
  border-top:1px solid var(--line);border-bottom:1px solid var(--line);
  font-size:17px;font-weight:700;line-height:1.65;color:var(--deep);letter-spacing:.01em;
}

/* 文档说明（markdown 开头那段 blockquote） */
.frontmatter{
  margin:0 0 34px;padding:18px 20px 8px;background:var(--paper-2);
  border:1px solid var(--line-2);border-top:2px solid var(--red);
  font-size:13.5px;line-height:1.8;color:var(--ink-2);
}
.frontmatter .fm-label{
  display:block;font-family:var(--mono);font-size:9.5px;letter-spacing:.18em;
  text-transform:uppercase;color:var(--ink-3);font-weight:700;margin-bottom:10px;
}
.frontmatter p{margin:0 0 9px}
.frontmatter strong{color:var(--deep);font-weight:700}

/* 表格 */
.table-wrap{margin:20px 0 26px;overflow-x:auto;border:1px solid var(--line-2);background:#fff}
.doc table{border-collapse:collapse;width:100%;font-size:13.5px;line-height:1.65}
.doc th,.doc td{
  border-bottom:1px solid var(--line);border-right:1px solid var(--line);
  padding:10px 13px;vertical-align:top;text-align:left;
  min-width:4.2em; /* 防两字词（可选/代筛/段）被压成竖排 */
}
.doc th:last-child,.doc td:last-child{border-right:0}
.doc thead th{
  background:var(--paper-3);font-weight:700;color:var(--ink);
  font-size:12.5px;letter-spacing:.02em;white-space:nowrap;
}
.doc tbody tr:last-child td{border-bottom:0}
.doc td.nw{white-space:nowrap}
.doc tbody tr:hover{background:#FCF8F0}
.doc td code{white-space:normal}

/* 代码 */
pre.code{
  margin:18px 0 24px;padding:16px 18px;overflow-x:auto;
  background:var(--paper-2);border:1px solid var(--line-2);border-left:3px solid var(--ink-3);
  font-family:var(--mono);font-size:12.8px;line-height:1.85;color:#2B3542;
}
pre.code code{background:none;border:0;padding:0;color:inherit;white-space:pre;font-size:inherit}

/* 配图 */
.fig{margin:26px 0 30px}
.fig img{display:block;width:100%;height:auto;border:1px solid var(--line-2);background:var(--paper)}
.fig figcaption{
  margin-top:9px;font-size:12px;color:var(--ink-3);text-align:center;letter-spacing:.02em;
}
.fig .fig-no{
  font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--rose);
  margin-right:7px;text-transform:uppercase;
}
.fig-missing{
  padding:14px 16px;border:1px dashed var(--line-2);color:var(--ink-3);font-size:13px;background:var(--paper-2);
}

/* 页脚 */
.doc-foot{
  margin-top:70px;padding:24px 0 60px;border-top:1px solid var(--line-2);
  font-size:12px;color:var(--ink-3);line-height:1.9;
}
.doc-foot b{color:var(--ink-2);font-weight:600}
.doc-foot code{font-size:11.5px}

/* 回到顶部 / 移动端目录 */
.totop,.toc-toggle{
  position:fixed;right:22px;z-index:55;border:1px solid var(--line-2);background:var(--paper);
  color:var(--ink-2);cursor:pointer;font-family:var(--sans);font-size:12px;
  padding:9px 13px;letter-spacing:.02em;
}
.totop{bottom:22px;opacity:0;pointer-events:none;transition:opacity .16s}
.totop.on{opacity:1;pointer-events:auto}
.totop:hover,.toc-toggle:hover{border-color:var(--red);color:var(--red)}
.toc-toggle{display:none;bottom:22px;left:22px;right:auto;font-weight:700}

@media (max-width:1080px){
  :root{--nav:0px}
  .nav{transform:translateX(-100%);transition:transform .2s ease;width:288px;border-right:1px solid var(--line-2)}
  .nav.open{transform:none}
  .main{margin-left:0}
  .wrap{padding:0 22px 30px}
  h1{font-size:30px}
  .doc h2{font-size:21.5px}
  .doc{padding-top:14px}
  .toc-toggle{display:block}
  .hero{padding-top:44px}
}
@media (prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  .nav,.totop{transition:none}
}
@media print{
  .nav,.progress,.totop,.toc-toggle{display:none!important}
  .main{margin:0}
  .wrap{max-width:none;padding:0}
  body{font-size:10.5pt;background:#fff}
  .doc h2{break-after:avoid;page-break-after:avoid}
  .doc h3{break-after:avoid}
  table,figure,pre.code{break-inside:avoid;page-break-inside:avoid}
  .fig img{border:1px solid #ccc}
  a{color:inherit;text-decoration:none}
}
</style>
</head>
<body>
<div class="progress"><i id="bar"></i></div>

<aside class="nav" id="nav">
  <div class="nav-head">
    <div class="nav-mark"><span class="dot"></span>红线开源工具<span class="en">PRD</span></div>
    <p class="nav-sub">产品需求文档 v${meta.version} · ${meta.date}</p>
  </div>
  <nav class="nav-scroll" id="navScroll"><ol>${nav}</ol></nav>
  <div class="nav-foot"><b>${stats.sections} 章 · ${stats.figures} 图 · ${stats.tables} 表</b><br />由 markdown 生成，改文档请改 .md</div>
</aside>

<button class="toc-toggle" id="tocToggle" aria-label="打开目录">目录</button>
<button class="totop" id="totop" aria-label="回到顶部">↑ 顶部</button>

<div class="main">
  <div class="wrap">
    <header class="hero">
      <div class="eyebrow">Product Requirements Document</div>
      <h1>红线开源工具<span class="thin"> · </span>产品需求文档</h1>
      <p class="hero-lede">${meta.lede}</p>
      <div class="stats">
        <span><b>${stats.sections}</b>章</span>
        <span><b>${stats.figures}</b>张配图</span>
        <span><b>${stats.tables}</b>张表</span>
        <span><b>${stats.subsections}</b>个小节</span>
      </div>
      <dl class="meta">${meta.items
        .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`)
        .join('')}</dl>
    </header>
    <article class="doc">
${html}
      <div class="doc-foot">
        <b>红线开源工具 · PRD v${meta.version}</b> · ${meta.date} · 孙超 × 产品合伙人<br />
        本文件由 <code>docs/build-prd-html.mjs</code> 从 <code>docs/00-定位与PRD/红线开源工具PRD.md</code> 生成，
        请勿直接编辑；改文档后执行 <code>npm run prd</code> 重新生成。配图源文件在 <code>diagrams/</code>。
      </div>
    </article>
  </div>
</div>

<script>
(function(){
  var nav = document.getElementById('nav'),
      bar = document.getElementById('bar'),
      totop = document.getElementById('totop'),
      toggle = document.getElementById('tocToggle'),
      scroller = document.getElementById('navScroll');

  // 目录项的锚点索引（h2 / h3 共用）
  var links = [].slice.call(document.querySelectorAll('.nav a[href^="#"]'));
  var targets = links.map(function(a){
    var el = document.getElementById(a.getAttribute('href').slice(1));
    return el ? { el: el, a: a, li: a.closest('.lvl2') } : null;
  }).filter(Boolean);

  var ticking = false;
  function update(){
    ticking = false;
    var y = window.scrollY || document.documentElement.scrollTop;
    var h = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = (h > 0 ? Math.min(100, (y / h) * 100) : 0) + '%';
    totop.classList.toggle('on', y > 700);

    // 当前小节：最后一个越过视口上三分之一的标题
    var mark = y + window.innerHeight * 0.3, cur = null;
    for (var i = 0; i < targets.length; i++){
      if (targets[i].el.getBoundingClientRect().top + y <= mark) cur = targets[i];
    }
    targets.forEach(function(t){ t.a.classList.remove('active'); });
    if (cur){
      cur.a.classList.add('active');
      // 高亮所属一级章节
      var all = document.querySelectorAll('.nav .lvl2');
      for (var j = 0; j < all.length; j++) all[j].classList.remove('active');
      if (cur.li) cur.li.classList.add('active');
      // 让当前项留在可视区
      var r = cur.a.getBoundingClientRect(), s = scroller.getBoundingClientRect();
      if (r.top < s.top + 40 || r.bottom > s.bottom - 40){
        scroller.scrollTop += r.top - s.top - s.height * 0.35;
      }
    }
  }
  function onScroll(){ if (!ticking){ ticking = true; requestAnimationFrame(update); } }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  update();

  totop.addEventListener('click', function(){ window.scrollTo({ top: 0, behavior: 'smooth' }); });
  toggle.addEventListener('click', function(){ nav.classList.toggle('open'); });
  links.forEach(function(a){ a.addEventListener('click', function(){ nav.classList.remove('open'); }); });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') nav.classList.remove('open'); });
})();
</script>
</body>
</html>
`;
}

// ───────────────────────────── 主流程 ─────────────────────────────

const md = readFileSync(SRC, 'utf-8');
const blocks = parse(md);
const { html, toc, stats } = render(blocks);

// Hero 文案：从文档自身取第一段定义 + 核心定位句，避免另写一份会漂移的摘要
const titleLine = blocks.find((b) => b.type === 'h1')?.text ?? '产品需求文档';
const creed = blocks.find((b) => b.type === 'creed')?.text ?? '';
const versionMatch = md.match(/\*\*状态\*\*：v([\d.]+)（(\d{4}-\d{2}-\d{2})/);
const version = versionMatch ? versionMatch[1] : '1.0';
const date = versionMatch ? versionMatch[2] : '';

const lede = creed
  ? `开源、免费的 AI Agent 婚恋匹配基础设施。客户端<b>月老 Skill</b> 建画像、本地比对；服务端<b>红线平台</b> 只做两件事——帮月老之间通信、收集统计必要信息做运营分析。<br /><strong>${inline(
      creed
    )}</strong>`
  : inline(titleLine);

const iconSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#FDFBF7"/>' +
  '<circle cx="16" cy="16" r="8.5" fill="none" stroke="#C8102E" stroke-width="2.4"/>' +
  '<circle cx="16" cy="7.5" r="2.6" fill="#C8102E"/></svg>';
const icon = `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString('base64')}`;

const out = page({
  html,
  toc,
  stats,
  meta: {
    version,
    date,
    icon,
    lede,
    items: [
      ['版本', `v${version}`],
      ['日期', date],
      ['真源', '红线开源工具PRD.md'],
      ['阅读', '单文件 HTML · 零外部请求 · 可离线'],
    ],
  },
});

writeFileSync(OUT, out, 'utf-8');

const kb = (Buffer.byteLength(out, 'utf-8') / 1024).toFixed(0);
console.log(`✓ ${OUT.replace(REPO + '/', '')}`);
console.log(
  `  ${stats.sections} 章 / ${stats.subsections} 小节 / ${stats.figures} 图 / ${stats.tables} 表 / ${stats.codes} 代码块 · ${kb} KB · 零外部请求`
);
if (stats.figures < 14) console.warn(`  ! 配图只内嵌了 ${stats.figures} 张（源文档声明 14 张），检查 diagrams/ 路径`);
