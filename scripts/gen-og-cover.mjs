#!/usr/bin/env node
/**
 * 重新生成 apps/web/og-cover.png（1200×630 社交分享卡片）。
 *
 * 做法：保留原图中的吉祥物像素（按原位放回），文字区按当前口径重绘。
 * 布局参数来自对原图的逐像素测量：纸白底 #FDFBF7、底部通栏红带 y=605..630、
 * 原文字块范围 x≈470..926。中文字体走 Microsoft YaHei，sharp 实测可正常渲染。
 *
 * 用法：
 *   node scripts/gen-og-cover.mjs                        # 生成到 .tmp-gh/og-cover-new.png（先看效果）
 *   node scripts/gen-og-cover.mjs --out apps/web/og-cover.png   # 满意后覆盖正式文件
 *
 * 必须从仓库根运行：sharp 对含中文的 Windows 绝对路径支持不稳（实测直接失败），
 * 因此本脚本一律使用相对路径，不要改成 path.join(__dirname, ...) 之类的绝对路径。
 *
 * 已知坑（改动前先读）：
 *   ① sharp 的 extract 与 trim 不能在同一 pipeline 串联，必须分离成两次 toBuffer()；
 *   ② trimOffset 返回值不可信（实测出现负值），吉祥物包围盒要自己逐像素算；
 *   ③ Windows 的 convert 是磁盘转换工具，不是 ImageMagick，别用它做图；
 *   ④ pip 安装 Pillow 会被沙箱 SIGTERM，不要走 Python 路线。
 */
import sharp from 'sharp';
import fs from 'node:fs';

const SRC = 'apps/web/og-cover.png';
const OUT_DIR = '.tmp-gh';

const RED = '#C8102E';
const INK = '#1F2937';
const MUTED = '#6B7280';
const PAPER = '#FDFBF7';
const ORANGE = '#F08200';

/* 解析 --out 参数 */
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 && process.argv[outIdx + 1]
  ? process.argv[outIdx + 1]
  : `${OUT_DIR}/og-cover-new.png`;

if (!fs.existsSync(SRC)) {
  console.error(`找不到 ${SRC}：请从仓库根运行本脚本（cd 到项目根目录）。`);
  process.exit(1);
}

(async () => {
  /* 1. 裁出吉祥物（避开底部红带与右侧文字） */
  const sliceBuf = await sharp(SRC)
    .extract({ left: 0, top: 90, width: 440, height: 505 })
    .png()
    .toBuffer();
  const r = await sharp(sliceBuf).raw().toBuffer({ resolveWithObject: true });
  const { data, info } = r;
  const W = info.width, H = info.height, ch = info.channels;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      if (data[i] + data[i + 1] + data[i + 2] < 735) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const mW = maxX - minX + 1, mH = maxY - minY + 1;
  const m = await sharp(sliceBuf).extract({ left: minX, top: minY, width: mW, height: mH }).toBuffer();
  const mLeft = minX;
  const mTop = 90 + minY;
  console.log('吉祥物', mW + 'x' + mH, '原位 left/top =', mLeft, mTop);

  /* 2. 文字层 */
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="${PAPER}"/>
  <rect x="0" y="605" width="1200" height="25" fill="${RED}"/>
  <line x1="470" y1="152" x2="508" y2="152" stroke="${RED}" stroke-width="3"/>
  <text x="520" y="159" font-family="Microsoft YaHei,PingFang SC,sans-serif" font-size="17"
        font-weight="700" letter-spacing="3" fill="${RED}">AI TOOL · 开源免费</text>
  <text x="470" y="232" font-family="Microsoft YaHei,PingFang SC,sans-serif" font-size="60"
        font-weight="700" fill="${INK}">把<tspan fill="${RED}">红线</tspan>交给 AI，</text>
  <text x="470" y="302" font-family="Microsoft YaHei,PingFang SC,sans-serif" font-size="60"
        font-weight="700" fill="${INK}">把心动留给<tspan fill="${RED}">你。</tspan></text>
  <text x="470" y="378" font-family="Microsoft YaHei,PingFang SC,sans-serif" font-size="26"
        fill="${MUTED}">开源、免费的 AI Agent 婚恋匹配工具，</text>
  <text x="470" y="418" font-family="Microsoft YaHei,PingFang SC,sans-serif" font-size="26"
        fill="${MUTED}">用最新的 AI 帮你找到对的人。</text>
  <circle cx="478" cy="470" r="5" fill="${ORANGE}"/>
  <text x="494" y="477" font-family="Microsoft YaHei,PingFang SC,sans-serif" font-size="19"
        font-weight="700" fill="${INK}">红线开源工具</text>
  <text x="660" y="477" font-family="Georgia,serif" font-style="italic" font-size="19"
        fill="${MUTED}">hongxian.dev</text>
</svg>`;

  const textLayer = await sharp(Buffer.from(svg)).png().toBuffer();

  /* 3. 按原位置合成吉祥物 */
  const final = await sharp(textLayer)
    .composite([{ input: m, left: mLeft, top: mTop }])
    .png()
    .toBuffer();

  const outDir = OUT.split('/').slice(0, -1).join('/');
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT, final);
  console.log('新封面 →', OUT, (final.length / 1024).toFixed(1) + 'KB');
  if (OUT !== SRC) console.log('确认效果后执行：node scripts/gen-og-cover.mjs --out ' + SRC);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
