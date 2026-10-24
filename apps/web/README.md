# 红线产品介绍网站（apps/web）

> 交付物对应 PRD §8（产品网站与透明统计）与《v1产品清单与验收标准》第 2 节（落地页 W1–W5）。
> 纯静态——**零构建、零依赖、零追踪**：无 Cookie、无统计 SDK、无字体 CDN。
> 唯一外部资源是页脚赞赏码 `sponsor-qr.png`（扫码质量要求真图，不内联 base64）。
> 「网站自己就是隐私声明」既是承诺，也是验收项。

## 目录

```
apps/web/                     # 部署产物（nginx 直接托管，境外机）
├── index.html                # 单文件整站：HTML + 内联 CSS + 内联 JS + 内联 SVG
├── og-cover.png              # 1200×630 分享封面（og:image / twitter:image）
├── sponsor-qr.png            # 微信赞赏码（480×480，28KB，页脚赞助区）
├── 404.html                  # 自包含 404 页（同规范、无外部依赖）
├── verify.mjs                # 静态验收（零依赖：node verify.mjs）
└── README.md
```

**唯一真源**：本目录。`index.html` 是单文件整站（HTML + 内联 CSS + 内联 JS + 内联 SVG），改版直接改这里——不再有上游设计源目录，避免"改设计稿忘记同步"的两份真相。品牌资产见 [`brand/`](../../brand)，配色与禁用项见 [brand/README.md](../../brand/README.md)。

## 版本沿革

| 版本 | 日期 | 要点 |
|---|---|---|
| v1 | 2026-10-15 | 七区信息架构首版；手写 CSS/JS，assets/ 分离 |
| v2 | 2026-10-15 | 明暗版面交替、Hero 信号汇聚构图、编辑感版式（`style.css` 时代） |
| **v3** | **2026-10-21** | **「纸信 · 红线」编辑科技风重塑，单文件化**；品牌换代落地（M4 线团之心 + M1 徽样）；宪法纪律回归（去渐变去投影）；内容补强（陌生人安全 / 密钥即身份 / 五档报告样例 / v1·v2 路线） |
| **v3.1** | **2026-10-21** | 五档报告样例改可切换 tab；**Hero 主图重做**（横向四节点链 + 三段错峰信号流 + 信封只在月老间往返 + 握手涟漪 + reduced-motion 显式暂停）；页脚赞助区改双栏 + **微信赞赏码卡片**（点击放大） |

### v3 改了什么（相对 v2）

- **品牌落地**：nav/页脚/favicon/404 全部换成 M4 线团之心；Hero 月老节点与 Demo 头像改用 M1 线团小月老徽样（额印星芒 + 缠线两笔），旧「加权心络」杂交版退场。
- **宪法纪律回归**：v2 引入的径向光晕、CTA 红渐变、对话区线性渐变、全站 box-shadow、nav 毛玻璃全部移除——层次改由「明暗版面交替 + 1px 线面 + 留白」承担（`verify.mjs` 静态拦截）。
- **色板纪律**：#E8445C 只用于墨底（页脚/深色带）；亮底信号线与编号回归 #C8102E。
- **内容补强**：FAQ 6 → 8（补防骚扰、密钥即身份）；Demo 区补五档报告样例卡（PRD §8 要求）；工作原理下补 v1/v2/v3 路线条；hero 明确「v1 全程本地 / v2 可选加密信箱」。
- **分享与 SEO**：补 og:image（1200×630）+ twitter:card + canonical + theme-color。
- **健壮性**：Demo 开场白改为静态 HTML（无 JS 也可见）；SMIL `mpath` 补 `xlink:href`（Safari 兼容）。
- **验收脚本换代**：playwright 渲染回归 → `verify.mjs` 静态契约检查（现 56 项）。

### v3.1 改了什么

- **Hero 主图**：原「W 形曲线 + 一体式信号流动 + 信封跑全程」有三处硬伤——标签压在连线上、握手线只有 24px 看不清、信封会跑到主人一侧（语义错误：加密信封只在两位月老之间传递）。重做为**横向四节点链**（主人甲 — 月老甲 ⇄ 月老乙 — 主人乙），`viewBox 0 92 560 296`：三段线路语义分明（主—月老用细灰实线 + 红色流动点表示日常对话，月老之间用品牌红密虚线表示结构化握手），信号流两段错峰（0s / 1.6s），信封用 `keyPoints="0;1;0"` 在握手区间往返、不越界，握手瞬间两球各扩散一圈淡出细环。
- **动效降级**：SMIL 动画不受 CSS `transition-duration` 约束——新增 `svg.pauseAnimations()`，`prefers-reduced-motion: reduce` 时整图静止（此前是漏洞）。
- **赞助区**：双栏（左：用途 + 三条纪律；右：白底卡片内嵌微信赞赏码 164px + 「感谢支持本项目」）。点击赞赏码弹出原生 `<dialog>` 放大到 320px（手机可长按识别），`::backdrop` 纯色半透明、无模糊。爱发电通道保留占位。

## 本地预览

```bash
cd apps/web
python -m http.server 8000        # 或 npx serve .
# 打开 http://localhost:8000
node verify.mjs                   # 静态验收（36 项）
```

## 部署

### 境外主站（已上线，免 ICP 备案）

**2026-10-24 起由 GitHub Pages 迁至自有服务器**（首尔，nginx 静态托管 + Let's Encrypt 证书），
`hongxian.dev` / `www.hongxian.dev` 均在证书内，HTTP 一律 301 到 HTTPS。
迁移目的是国内加载提速（Pages 1–3 秒 → 数百毫秒）。

更新流程：把 `index.html` / `og-cover.png` / `sponsor-qr.png` / `404.html` 四个文件
打包上传到服务器 `/var/www/hongxian/`（无需构建）。完整命令与坑见
[部署与运维手册](../../docs/20-技术设计/部署与运维.md) §3。

> 只发这 4 个文件：`README.md` 与 `verify.mjs` 是开发文件，不上线。

GitHub Pages 仓库（`hongxian-dev/hongxian-dev.github.io`）保留未动，作为回滚路径：
把 apex 的 A 记录改回四条 Pages IP 即可（详见手册 §5）。

### 境内镜像（待 ICP 备案通过）

- 备案通过后用 Nginx/Caddy 直接托管同一目录；`og:image` 与 canonical 已写死 `https://hongxian.dev`，镜像站无需改动
- 备案通过前境内站**不得开放访问**（合规链条见《技术详设》v1.5）
- 页脚合规列现为「ICP 备案：准备中」纯文本，拿到备案号后替换为真实链接

## 验收对照（`node verify.mjs`，56 项全绿）

| 类别 | 断言 |
|---|---|
| 零请求 | 无外部样式表/脚本、无 webfont、无 `url(http)` 引用 |
| 视觉纪律 | 无渐变、无 box-shadow/text-shadow、无 backdrop-filter |
| 分享/SEO | description、canonical、theme-color、og:image + 尺寸、twitter:card |
| 内容完整 | 七区锚点齐、FAQ 八问、防骚扰问答、密钥即身份问答、五档报告样例、v1/v2 路线 |
| 数据契约 | 四键 `cards/active/env/plaza` 与 Worker `site` 块一一对应；兼容 `site`/`counters` 两代结构 |
| 外链白名单 | 仅 `hongxian.dev` / `github.com` / `count.hongxian.dev` / `afdian.com`（+ SVG 命名空间） |
| 品牌资产 | 无旧标文件引用；内嵌 M4 符号与 M1 额印星芒 |
| 赞助合规 | 页脚赞助区隔离、赞赏码为本地图片且 <60KB、有可读 alt、可放大、无个人收款码、无「礼金/谢媒礼/彩礼/介绍费」措辞、对价声明齐、标注「自愿、无对价」、爱发电占位保留 |
| Hero 动效 | 内联 SVG、两段信号流、信封 `keyPoints="0;1;0"` 往返不越界、握手密虚线、`pauseAnimations` 降级、无渐变无滤镜 |
| 体积 | 首页 < 80KB（当前 65.3KB）+ 赞赏码 27.2KB |

## 待接入（不阻塞）

- [ ] **GitHub 源码仓库公开**——当前 org 仅有 Pages 仓库，信任清单「读源码 / 自托管」链接暂指 org 页；`schema`/`core`/`mcp`/`server` 与协议规范需在官网上线前推上去
- [x] ~~计数器 Worker 部署（`count.hongxian.dev`）~~ —— **2026-10-21 已上线**，`/stats` 实测 200，透明数据区已接真实端点（无数据时自动降级「等待第一个用户」）
- [ ] 爱发电账号（afdian.com）创作者主页审核通过后：① 把页脚赞助区的 `<span class="sp-alt">爱发电通道筹备中…</span>` 换成 `<a class="sp-alt" href="https://afdian.com/a/<你的ID>" rel="noopener">也可通过爱发电赞助 →</a>`，移除 `<!-- TODO(sponsor) -->` 注释；② 同步根目录 `.github/FUNDING.yml` 的 custom 链接（现整行注释）；③ 跑 `node verify.mjs`（第 9 组断言要求 TODO 标记存在，届时改写为「已接入真实链接」）
- [x] ~~微信赞赏码上站~~ —— **2026-10-21 已上线**（原图裁掉多余留白 + 12% 静区，480×480 调色板 PNG 27.2KB；点击弹 dialog 放大）
- [ ] 备案号下发后替换页脚「ICP 备案：准备中」
