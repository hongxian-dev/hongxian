# 红线产品介绍网站（apps/web）

> 交付物对应《产品网站与透明统计v1设计初稿》七区信息架构与《v1产品清单与验收标准》第 2 节（落地页 W1–W5）。
> 纯静态手写 HTML/CSS/JS——**零构建、零依赖、零追踪**：无 Cookie、无统计 SDK、无字体 CDN。
> 「网站自己就是隐私声明」既是承诺，也是验收项。

## 目录

```
apps/web/
├── index.html              # 单页七区：Hero / 工作原理 / Demo / 信任清单 / 生态数据 / FAQ / 页脚赞助
├── 404.html                # 品牌 404 页
├── gen_og_cover.py         # og 分享卡片图生成脚本（PIL，品牌规范硬编码）
├── verify.js               # 回归验证脚本（playwright：七区渲染 + Demo 全流程 + 外链审计）
├── assets/
│   ├── css/style.css       # 品牌样式（禁渐变禁投影、浅色主题、响应式、prefers-reduced-motion）
│   ├── js/main.js          # 交互（Demo 预设脚本、透明数据拉取与降级、导航、显现动画）
│   └── img/                # logo/final 交付包复制 + og-cover.png
└── README.md
```

## 视觉改版 v2（2026-10-15）

改版目标：解决 v1「通篇纸白 + 白卡 + 1px 灰边、七区同节奏」的朴素感，同时**严守品牌宪法**。

**关键判断**：《定位声明》§11 的「禁渐变、禁投影」被 v1 误读成了「只能靠留白建立层次」。但《logo 交付包》规则 4 明确「墨底/深灰底用提亮红 #E8556A」——**深色版面本就是品牌允许的**。v2 因此改用「明暗版面交替」替代「光影装饰」制造视觉层次。

| 手法 | 说明 |
|---|---|
| 明暗节奏 | Demo 区、生态数据区、页脚改为墨底 `#141B25`；主色换提亮红 `#E8556A`（logo 规则 4）；亮底/墨底交替形成段落呼吸 |
| Hero 信号汇聚构图 | 加权心络从「装饰 logo」升格为叙事主角：四路加权信号（画像/意向/偏好/边界）汇入心形，粗细深浅即注意力权重；橙色仍严格限于结点与流动信号 |
| 编辑感版式 | 标题升至 clamp(64px)，承诺带改为细线分隔行（替掉胶囊标签），区块加「0N / 标题」编号 eyebrow |
| 工作原理横向卡 | 三张竖排卡改为「左文右图」横向叙事卡，插画加编号 01–03 |
| 信任清单 stepper | 卡片堆叠改为竖向连通节点（节点间连线 + 等宽数字序号） |
| FAQ 双栏 | 单栏改为左 sticky 标题 + 右细线列表的编辑版式 |

**未改动**：七区信息架构、全部文案措辞（措辞纪律=法律文件）、`main.js` 全部交互钩子、无 Cookie/无 SDK/无字体 CDN、`prefers-reduced-motion`、OG meta。

**验收**：`verify.js` 17/18 通过（唯一未通过项为计数器域名未注册导致的 DNS 失败，与改版无关）。

## 本地预览

```bash
cd apps/web
python -m http.server 8000        # 或 npx serve .
# 打开 http://localhost:8000
```

## 部署（v1 双轨）

### 境外主站（先行，免 ICP 备案）

```bash
# GitHub Pages：repo 设为 hongxian-dev/site，Settings → Pages → 选 main 分支根目录
# 或 Vercel：vercel --prod（框架选 Other，输出目录即本目录）
```

域名绑定 `hongxian.dev` 后：

1. 在仓库根放置 `CNAME` 文件，内容一行 `hongxian.dev`（**须在 DNS 已指向托管方之后**，否则 github.io 默认域名会失效）
2. 托管方开启 HTTPS（Pages/Vercel 自动签发；.dev 强制 HTTPS）
3. `index.html` 的 `og:image` 可改为绝对地址 `https://hongxian.dev/assets/img/og-cover.png`

### 境内镜像（并行走 ICP 备案）

- 备案通过后，用 Caddy/Nginx 把本目录静态托管到 `hongxian.cn`（与 GitHub Pages 同源双轨）
- 备案通过前境内站**不得开放访问**（合规链条见《技术详设》v1.5）
- 备案号位置：`index.html` 页脚 `footer-bottom` 内已留 HTML 注释占位

## 验收对照（《v1产品清单》第 2 节）

| 验收项 | 状态 |
|---|---|
| 静态单文件可部署 Pages/Vercel | ✅ 纯静态，无构建 |
| Demo 区不发起任何真实网络请求 | ✅ 纯前端预设脚本，main.js 内无 fetch 调用 |
| 透明数据区数字与上报聚合一致 + 明示匿名聚合/opt-in | ✅ 拉取 `count.hongxian.dev/stats`，失败降级「等待第一个用户」；页面已明示 |
| 赞助区无婚介措辞、与产品功能区物理隔离 | ✅ 独立 aside 区块 + 明示「不收取任何与婚介相关的费用」 |
| 移动端可用 / 浅色主题 / 品牌色 | ✅ 响应式 + #C8102E / #1F2937 / #F08200 |
| 页面无 Cookie、无统计 SDK | ✅ 零外部请求（可抓包验证） |

## 待接入（不阻塞）

- [ ] GitHub org `hongxian-dev` 与 repo（`site` / `yuelao-skill` / `hongxian-protocol`）创建后，替换页脚链接为真实地址
- [ ] 域名注册后绑定 + CNAME
- [ ] 计数器 Worker 部署后，透明数据区自动亮起（见 `apps/counter/README.md`）
- [ ] 爱发电 / GitHub Sponsors 账号就绪后替换页脚赞助链接与二维码
- [ ] 协议规范 v0 草案公开后，页脚资源列补链接
