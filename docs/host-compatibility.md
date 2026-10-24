# 宿主兼容性矩阵（Host Compatibility Matrix）

> 状态图例：✅ 已验证 · 🟡 协议层已验证、宿主级待回归 · ❌ 不支持
> 本矩阵由 README 常驻维护（技术详设 §8 / W7）。v1.0 发布前以真实回归结果更新状态列。

## 0. 先说清楚"验证"到底验的是什么

月老是一个标准 MCP server（STDIO 传输）。兼容性分两层：

| 层 | 内容 | 现状 |
|---|---|---|
| **协议层** | initialize 握手、tools/list、tools/call、prompts、stdio 帧 | ✅ 已验证——E2E 套件（`packages/mcp/e2e/run-e2e.mjs`）以真实子进程跑完 16 工具 + 4 prompts 全流程（含 M1.3 广场流：真实服务端子进程 + 双客户端 + 零知识审计），75/75 通过，连续 3 轮稳定 |
| **宿主层** | 具体 GUI/CLI 宿主里能否加连接器、能否调起、异常路径表现 | 🟡 逐家回归中（见各宿主条目） |

**协议层 ✅ 意味着**：任何正确实现 MCP 的宿主都能驱动月老。宿主层 🟡 只影响"体验细节"（连接器菜单位置、重启时机、错误提示文案），不影响功能与安全。

## 1. 接入方式速查

| 宿主 | 接入方式 | 状态 | 备注 |
|---|---|---|---|
| WorkBuddy | 自定义 MCP 连接器 | 🟡 P0 | 本仓库开发环境；协议层已验证 |
| Claude Desktop / Claude Code | `mcpServers` 配置 | 🟡 P0 | 见下方配置示例 |
| Codex CLI | `codex mcp add` | 🟡 P0 | 见下方命令 |
| 豆包桌面版 | 技能 → 连接器 → 自定义 MCP | 🟡 P1 | |
| 千问 | 技能 → 连接器 → 自定义 MCP | 🟡 P1 | |
| Cursor | 标准 MCP（Settings → MCP） | 🟡 P1 | |
| Cline | 标准 MCP（MCP Servers 面板） | 🟡 P1 | |
| Cherry Studio | 标准 MCP（设置 → MCP 服务器） | 🟡 P1 | |
| 手机 App 端 | — | ❌ | D14 决策：App 无本地文件系统、不开放自装 MCP，v1 明确不追 |

## 2. 各宿主接入步骤

> **当前统一用「node + 绝对路径」接入**：`@hongxian/mcp` 尚未发布到 npm，`npx` 与全局安装暂不可用。
> 先按 [安装与信任指南](install-and-trust.md) §2 方式 A 从源码构建，记下 `packages/mcp/dist/index.js` 的绝对路径。
>
> ```
> command: node
> args:    /绝对路径/hongxian/packages/mcp/dist/index.js
> ```
>
> 下面各宿主讲的只是"这条命令填到哪个入口"的差异。包发布后再统一换成 `npx -y @hongxian/mcp`。

### 2.1 Claude Desktop / Claude Code

编辑配置文件（macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`；Windows：`%APPDATA%\Claude\claude_desktop_config.json`）：

```jsonc
{
  "mcpServers": {
    "yuelao": {
      "command": "node",
      "args": ["/绝对路径/hongxian/packages/mcp/dist/index.js"]
    }
  }
}
```

保存后**完全退出并重启** Claude Desktop（不是关窗口，是退出进程）。

### 2.2 Codex CLI

```bash
codex mcp add yuelao -- node /绝对路径/hongxian/packages/mcp/dist/index.js
```

验证：`codex mcp list` 应列出 `yuelao`。

### 2.3 WorkBuddy

连接器管理 → 自定义 MCP → 新增，命令 `node`，参数 `/绝对路径/hongxian/packages/mcp/dist/index.js`。

### 2.4 豆包桌面版 / 千问 / Cursor / Cline / Cherry Studio

均走"自定义 MCP / 标准 MCP"入口，命令统一为：

```
command: node
args:    /绝对路径/hongxian/packages/mcp/dist/index.js
```

差异只在入口路径（见 §1 表）。若宿主要求填"服务器 URL"而不支持命令型 MCP，该宿主当前不兼容——请换 P0/P1 列表内的宿主。

## 3. 通用排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 宿主里看不到工具 | 配置未生效 / 未重启 | 保存后退出宿主进程重开；确认 JSON 无注释错位（`jsonc` 仅供人看，正式配置去掉注释） |
| `spawn node ENOENT` | Node 不在 PATH | 用 node 的绝对路径：`command` 填 `which node` / `where node` 的输出，如 `C:\\Program Files\\nodejs\\node.exe` |
| 首次调用超时 | 首次加载或宿主探测期偏短 | 先在终端手动跑一次 `node /绝对路径/hongxian/packages/mcp/dist/index.js`，确认能启动（Ctrl+C 退出），再交给宿主 |
| 工具报"未初始化" | 月老要求先完成知情同意与解锁 | 对 Agent 说"打开月老"，走完 consent → 恢复短语 → unlock（见 [安装与信任指南](install-and-trust.md)） |
| 提示词不显示人格 | 宿主不支持 MCP prompts | 已做降级：人格与流程指引会以工具返回文本形式给出（技术详设 §9 风险对策） |
| Windows 中文路径异常 | 用户名含非 ASCII 字符 | 已知并在 v1 处理范围内（数据目录 `%USERPROFILE%\.hongxian`，全程 path API + NFC 归一化）；若仍复现请提 issue 并附 `echo %USERPROFILE%` 输出 |

## 4. 回归方法与提交你的结果

每家宿管的回归跑同一套冒烟脚本（协议层已验证，宿主层只需确认"能连上、能调通、异常不崩"）：

```bash
# 1. 按 §2 配好宿主
# 2. 对宿主 Agent 说：
打开月老
# 3. 依次确认：
#    - 出现知情同意页（consent 工具被调起）
#    - 列出 16 个工具、4 个提示词（问宿主"列出月老的工具"）
#    - 说"删除我的全部数据"能触发 wipe 并无残留
```

发现不兼容？欢迎带上报错信息提 issue，标注宿主名与版本。矩阵随回归滚动更新——**这也是我们不锁死任何宿主、只锁标准 MCP 插座的原因（D14）**。

---

*v1.0 发布时，本表状态列将以真实回归结果刷新；在那之前，协议层已验证、宿主层逐家确认。*
