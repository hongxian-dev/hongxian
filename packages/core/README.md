# @hongxian/core

红线领域核心。纯函数，**零 IO**——不读文件、不发请求、不看时间（时间由调用方传入）。

这一层的存在理由是：所有「该不该」「算不算」「行不行」的判断都在这里，
可以脱离网络和存储单独测试。MCP 层只做协议适配，服务端只做存储。

## 里面是什么

| 模块 | 职责 |
|---|---|
| `interview` | 画像状态机：三次会话、复述确认、修订（续访） |
| `card` | 匹配卡工厂与签名/验签包装 |
| `filter` | 粗筛：声明式圈层、硬条件、静默排除 |
| `round` | 一轮对话 = 1 个主题 + 追问不超过 2 次 |
| `journal` | 手账与复盘 |
| `guard/injection` | 出站过滤：防止画像里的文本变成对 Agent 的指令 |
| `guard/safety` | 安全提示文案与版本号（风险提示、96110、边界声明） |

## 用法

```ts
import { nextInterviewStep, buildMatchCard, screenCards } from '@hongxian/core';
```

## 两条硬约束

- **不给分数**。任何评分函数都不该出现在这一层。报告只有文字与原话引用。
- **文案带版本号**。安全提示改了字必须升版本，否则看过旧版的用户不会再看新版。

## 许可

Apache-2.0。

- 源码：https://github.com/hongxian-dev/hongxian/tree/main/packages/core
- 官网：https://hongxian.dev
