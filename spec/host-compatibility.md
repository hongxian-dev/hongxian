# 宿主兼容性矩阵（Host Compatibility Matrix）

> 状态图例：✅ 已验证 · 🟡 协议层已验证、宿主级待回归 · ❌ 不支持
> 本矩阵由 README 常驻维护（技术详设 §8 / W7）。v1.0 发布前以真实回归结果更新状态列。

## 0. 先说清楚"验证"到底验的是什么

月老是一个标准 MCP server（STDIO 传输）。兼容性分两层：

| 层 | 内容 | 现状 |
|---|---|---|
| **协议层** | initialize 握手、tools/list、tools/call、prompts、stdio 帧 | ✅ 已验证——E2E 套件（`packages/mcp/e2e/run-e2e.mjs`）以真实子进程跑完 21 工具 + 8 prompts 全流程（含 M1.3 广场流：真实服务端子进程 + 双客户端 + 零知识审计），**125/125 通过**（2026-10-25 实测） |
| **宿主层** | 具体 GUI/CLI 宿主里能否加连接器、能否调起、异常路径表现 | 🟡 逐家回归中（见各宿主条目） |

**协议层 ✅ 意味着**：任何正确实现 MCP 的宿主都能驱动月老。宿主层 🟡 只影响"体验细节"（连接器菜单位置、重启时机、错误提示文案），不影响功能与安全。

## 1. 只有四种配置载体

宿主很多，**配置方式只有四种**。按载体找，别按宿主名找。

| 载体 | 谁在用 | 要给的东西 | 宿主层状态 |
|---|---|---|---|
| **A · 界面表单** | 豆包桌面版、千问办公、WorkBuddy、ChatGPT、DeepSeek Harness（另装 dsh-mcp-servers 后） | 三个字段：名称 `hongxian`／命令 `npx`／参数 `-y @hongxian/mcp` | 🟡 P0（豆包、千问、WorkBuddy）· 🟡 P1（ChatGPT） |
| **B · mcpServers JSON** | Claude Desktop、Cursor、Cline、Cherry Studio、**OpenClaw** | 一段 JSON；OpenClaw 必须多一个 `transport` 字段 | 🟡 P0（Claude Desktop）· 🟡 P1（其余） |
| **C · CLI 命令** | Claude Code、Codex、OpenClaw | 一行 `xxx mcp add` | 🟡 P0 |
| **D · YAML patch** | DeepSeek Harness（原生，非 mcpServers 格式） | 一段 `insert` 片段 | 🟡 P1 |
| — | 手机 App 端、网页版 AI、云端电脑 | ❌ 不兼容 | ❌ D14：无本地文件系统、不开放自装 MCP，v1 明确不追 |

> **为什么不按宿主列**：按宿主写，每来一个客户端就要加一套说明，文档线性膨胀且互相矛盾。2026-10-25 已经发生过——同一段"在 mcpServers 下加入这段"的说明，在豆包工作云桌面和自己本机的豆包客户端上**连续两次**把 AI 引向"去找配置文件"，然后失败。按载体写，新增宿主只是加一行别名。

### 取物料：让工具输出，别抄文档

> 需要 0.1.2 及以上。0.1.1 只支持不带参数的 `--print-config`（输出标准 JSON），传目标会被当作未知参数拒绝。

```bash
npx -y @hongxian/mcp --print-config claude     # B 载体标准 JSON
npx -y @hongxian/mcp --print-config openclaw   # B 载体 + transport
npx -y @hongxian/mcp --print-config panel      # A 载体字段表（含各家入口）
npx -y @hongxian/mcp --print-config code       # C 载体三行命令
npx -y @hongxian/mcp --print-config dsh        # D 载体 YAML patch
npx -y @hongxian/mcp --print-config list       # 列出全部目标
```

不带目标时输出标准 JSON（等价 `claude`），保持旧脚本可用；提示走 stderr，所以 `--print-config > mcp.json` 拿到的仍是干净 JSON。

## 2. 各载体接入步骤

> 所有载体最终都是同一个东西：`command: npx`、`args: ["-y", "@hongxian/mcp"]`。
> 不想跑一个自己没编译过的二进制，就按 [安装与信任指南](install-and-trust.md) §2 方式 C 从源码构建，改成 `command: node` + `args: [该文件绝对路径]`。两条路产物相同。

### 2.1 A · 界面表单

这类客户端把配置存在自己的数据库里（有的是二进制 leveldb），**没有可手改的 JSON 文件**——去找文件会浪费一轮。

统一填法：新建「自定义连接器」→ 传输类型选 **STDIO** → 三个字段。

| 宿主 | 入口 |
|---|---|
| 豆包桌面版 | 左侧「插件·技能·伙伴」→ **连接器** → 右上角「+ 新建」→ **新建自定义连接器**。注意是"连接器"不是"插件" |
| 千问办公 | 扩展 → 连接器 →「+ 添加」→ 粘贴 JSON |
| WorkBuddy | 连接器管理 → 自定义 MCP → 新增 |
| ChatGPT | Settings → Connected apps → Add MCP server（走 OAuth） |

保存后**完全退出宿主进程**再重开（关窗口不算），再开新会话才会加载。若提示连接器启动失败，先到连接器列表点一次「重新启动」——首次启动常是没初始化完。

> **别搞混的两个「豆包」**：上表指**豆包桌面版客户端**。「豆包工作」/云桌面是另一类产品——一台跑任务的云端电脑，**不是 MCP 宿主，没有 MCP 入口**，在里面装月老对你本机没有任何用。2026-10-25 用云端和本机各做一次新用户模拟，两次都撞在这个歧义上。

### 2.2 B · mcpServers JSON

| 宿主 | 配置文件 |
|---|---|
| Claude Desktop（Windows） | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Desktop（macOS） | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | 设置里的 MCP / MCP Servers 面板 → 新增 → 粘贴 JSON |
| Cline | MCP Servers 面板 |
| Cherry Studio | 设置 → MCP 服务器 |
| **OpenClaw** | `~/.openclaw/openclaw.json`，**必须加 `"transport": "stdio"`**，漏了不生效 |

```jsonc
{
  "mcpServers": {
    "hongxian": {
      "command": "npx",
      "args": ["-y", "@hongxian/mcp"]
      // OpenClaw 额外要这一行：
      // "transport": "stdio"
    }
  }
}
```

保存后**完全退出并重启**（不是关窗口，是退出进程）。OpenClaw 多数改动热重载，但新增服务器或改传输类型需要 `openclaw gateway restart`。

### 2.3 C · CLI 命令

```bash
claude mcp add --transport stdio hongxian npx -y @hongxian/mcp
codex  mcp add hongxian -- npx -y @hongxian/mcp
openclaw mcp add --transport stdio hongxian npx -y @hongxian/mcp
```

验证：`claude mcp list` / `codex mcp list` / `openclaw mcp list` 里应出现 `hongxian`。

### 2.4 D · DeepSeek Harness

它不是 mcpServers 格式，走 patch 文件：`~/.dsh/profiles/<profile>/cordis.patch.yml` 追加

```yaml
- insert:
  - id: hongxian
    name: "@deepseek-ai/dsh-mcp-client"
    config:
      serverName: hongxian
      transport: stdio
      command: npx
      args: ["-y", "@hongxian/mcp"]
```

`serverName` 决定工具前缀，模型侧看到的是 `mcp__hongxian__interview` 这类名字。嫌改 YAML 麻烦可装社区插件 `dsh-mcp-servers`，换成「Settings → MCP Servers → 添加 → Test → Save」的图形界面。

## 3. 通用排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 宿主里看不到工具 | 配置未生效 / 未重启 | 保存后退出宿主进程重开；确认 JSON 无注释错位（`jsonc` 仅供人看，正式配置去掉注释） |
| `spawn node ENOENT` | Node 不在 PATH | 用 node 的绝对路径：`command` 填 `which node` / `where node` 的输出，如 `C:\\Program Files\\nodejs\\node.exe` |
| 首次调用超时 | 首次加载或宿主探测期偏短 | 先在终端手动跑一次 `node /绝对路径/hongxian/packages/mcp/dist/index.js`，确认能启动（Ctrl+C 退出），再交给宿主 |
| 工具报"未初始化" | 月老要求先完成知情同意与解锁 | 对 Agent 说"打开月老"，走完 consent → 恢复短语 → unlock（见 [安装与信任指南](install-and-trust.md)） |
| 提示词不显示人格 | 宿主不支持 MCP prompts | 已做降级：人格与流程指引会以工具返回文本形式给出（技术详设 §9 风险对策） |
| Windows 中文路径异常 | 用户名含非 ASCII 字符 | 已知并在 v1 处理范围内（数据目录 `%USERPROFILE%\.hongxian`，全程 path API + NFC 归一化）；若仍复现请提 issue 并附 `echo %USERPROFILE%` 输出 |
| 工具名对不上（显示成 `mcp__hongxian__interview`） | Claude Code、DeepSeek Harness 等宿主会给工具加 `<serverName>` 前缀 | **正常现象**，不是装错。核对总数（21 工具 + 8 指引）即可，别核名字 |
| `404 Not Found` / 包拉不下来 | 包名被写成 `@//hongxian/mcp`（多一个斜杠），或聊天框把 `@` 当提及转义 | 正解只有 `@hongxian/mcp`。终端里自查：`npm view @hongxian/mcp version` 应返回版本号 |
| `npx: command not found` / 连接器启动即失败 | 这台机器没装 Node | 装 Node 20+ 再试；若宿主不继承系统 PATH，`command` 填 `npx` 的绝对路径（如 `C:\Program Files\nodejs\npx.cmd`）。**这是国内非技术用户最常见的墙** |
| `serverInfo` 报的版本比实际装的旧 | 0.1.1 及更早的包把 `serverInfo.version` 写死成 `0.1.0` | 已在 0.1.2 修复（改为读 package.json）。在 0.1.2 之前，以 `npm view @hongxian/mcp version` 为准 |

## 4. 回归方法与提交你的结果

每家宿主的回归跑同一套冒烟脚本（协议层已验证，宿主层只需确认"能连上、能调通、异常不崩"）：

```bash
# 1. 按 §2 对应载体配好宿主
# 2. 对宿主 Agent 说：
打开月老
# 3. 依次确认：
#    - 出现知情同意页（consent 工具被调起）
#    - 列出 21 个工具、8 个提示词（问宿主"列出月老的工具"）
#      注意：部分宿主会加前缀，如 mcp__hongxian__interview —— 核总数，不核名字
#    - 说"删除我的全部数据"能触发 wipe 并无残留
```

发现不兼容？欢迎带上报错信息提 issue，标注宿主名与版本。矩阵随回归滚动更新——**这也是我们不锁死任何宿主、只锁标准 MCP 插座的原因（D14）**。

---

*v1.0 发布时，本表状态列将以真实回归结果刷新；在那之前，协议层已验证、宿主层逐家确认。*
