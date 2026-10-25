# WorkBuddy 连接器包 · 提审物料

这个目录是提交到 **WorkBuddy 连接器市场**的完整物料（`open.workbuddy.cn` 规范）。
提交后用户在连接器市场点「连接」就能用——**不需要写 JSON、不需要装 Node**。

## 目录

| 文件 | 作用 | 改不改 |
|---|---|---|
| `connector-meta.json` | 市场展示：名称、中英描述、示例话术、版本、最低客户端版本 | **每次发版改 `version`** |
| `mcp.json` | 启动方式：`npx` + 托管 Node 20 + 国内镜像 | **每次发版同时改 `args` 里的版本号** |
| `icon.svg` | 市场图标（M1「线球小月老」，透明底，240×240 viewBox） | 品牌改版才动 |
| `skills/yuelao/SKILL.md` | 教宿主 AI 怎么用这 21 个工具 | 工具表面或交互规则变了才动 |

## 为什么这样配（三个不是随手写的决定）

**① 锁定版本：`@hongxian/mcp@0.1.2`，不用 `latest`。**
用 `latest` 意味着我们每次 `npm publish` 都会立刻推给所有市场用户，**绕过 WorkBuddy 的审核**。月老处理的是婚恋画像和私钥，未经审核的自动更新不可接受。代价是修 bug 也要走一次提交（更新审核 10–15 分钟），这个代价我们接受。

**② `runtime: {type: "node", version: "20"}` —— 这是上架最要紧的一个字段。**
它让 WorkBuddy 自己准备 Node 并注入环境，**用户电脑上不需要装 Node**。国内用户真正的墙不是不会改 JSON，是机器上根本没有 Node，`npx` 跑不起来。这一个字段把墙推倒了。因为 `runtime` 自 **5.0.0** 起支持，所以 `connector-meta.json` 必须声明 `minWorkbuddyVersion: "5.0.0"`——漏了会让低版本客户端拉到不兼容配置，又变成「装了用不了」。

**③ `npmRegistries` 用数组而不是单个 `npmRegistry`。**
先走 `registry.npmmirror.com`（国内快），失败自动回退 `registry.npmjs.org`（权威源）。刚发布的版本在镜像里可能还没同步，数组形式能兜住。

## 发新版时必须同步改两处

```diff
  // connector-meta.json
- "version": "0.1.2",
+ "version": "0.1.3",

  // mcp.json
- "args": ["-y", "@hongxian/mcp@0.1.2"],
+ "args": ["-y", "@hongxian/mcp@0.1.3"],
```

两处不一致的后果：市场显示 0.1.3，实际跑的是 0.1.2——用户看到的版本号和自己装的东西对不上。**这正是 0.1.1 发版时踩过的坑**（`serverInfo.version` 写死报 0.1.0），别再来一次。

改完在仓库根验证：

```bash
node -e "JSON.parse(require('fs').readFileSync('connector/connector-meta.json','utf8'))" &&
node -e "JSON.parse(require('fs').readFileSync('connector/mcp.json','utf8'))" &&
grep -o 'mcp@[0-9.]*' connector/mcp.json &&
grep -o '"version": "[0-9.]*"' connector/connector-meta.json
```

## 提交步骤（需要你的开发者账号，我代不了）

1. 打包：`cd connector && zip -r ../hongxian-connector.zip .`（或直接上传目录）
2. 登录 `open.workbuddy.cn`，创建连接器，选 MCP + Skill 方案
3. 上传上表四个文件，确认 `source: hongxian` 未被占用（若被占，改成 `hongxian-yuelao` 并同步 README）
4. 提交审核，首次约 **7 个工作日**；通过后更新一般 10–15 分钟同步

## 审核沟通要点（三条要守住的线）

**① 类目：选「效率工具 / 生活助手」，不选「婚恋交友」。**
月老是工具，不是婚介。如果被归进婚恋交友，等于平台替我们背书了一个我们不承认的身份。若审核员要求改类目，这条要先沟通——描述第一句已经写明"工具"，不是"服务"。

**② 免费：主动写清，别等审核来问。**
生态在鼓励定价，一个"永久免费且声明不换取对价"的项目容易被当成"免费引流到付费"的可疑对象。描述里"开源、免费"是差异化加分项，不是需要藏着的事。

**③ 数据不出本机：这是最硬的一条，要主动说。**
没有账号体系、没有服务端存储、画像和私钥都在 `~/.hongxian/`。平台侧只转交密文（且只在用户主动使用广场功能时）。`auth_mode` 因此省略——我们没有可认证的账号。审核若问"涉及用户数据如何鉴权"，答案就是：数据不存在我们这边。

## 更新后的回归

```bash
npx -y @hongxian/mcp@<新版本> --print-config panel   # 版本号对不对
npx -y @hongxian/mcp@<新版本> --version             # 与 connector-meta 一致
```

再跑一次工具清单核对：宿主里问「你有哪些月老工具」，应看到 **21 个工具、8 条指引**。
（工具名可能带 `mcp__hongxian__` 前缀，核总数不核名字。）
