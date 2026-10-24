# @hongxian/schema

红线协议的机器可读形态（Zod）。协议全文见 [protocol-v1-spec.md](https://github.com/hongxian-dev/hongxian/blob/main/spec/protocol-v1-spec.md)。

当前对应 **协议 v1.4 / Schema v0.5**。

## 里面是什么

- **三层匹配卡信封**：明文 meta + 三层独立加密 payload（AES-256-GCM）+ Ed25519 整体签名。验签失败整卡作废，不降级。
- **九类消息**：`match_card` / `card_renewal` / `upgrade_request` / `grant_l2` / `topic_pack` / `answer_card` / `graduation_invite` / `grant_l3` / `decline_silent`。
- **受控词表**：城市（国标码）、年龄段、关系阶段、举报理由码等。自由文本进不了需要机器判断的位置。
- **发布许可契约**：`normalizeCarrier`、许可码字母表与形状校验、错误码常量。**刻意不含任何哈希函数**——算得出载体指纹就等于拿到离线彩虹表素材，那部分只在服务端。

## 用法

```ts
import { MatchCardSchema, MESSAGE_TYPES } from '@hongxian/schema';

const card = MatchCardSchema.parse(input); // 形状不对直接抛，不做宽容修补
```

## 边界

这个包只做**结构与词表**。加解密在 `@hongxian/crypto`，业务判断在 `@hongxian/core`。

`declared_filters`（声明式圈层，含性别 / 意向 / 城市 / 年龄段 / 可见范围）属于明文 meta 且被签名覆盖，
`match_card` 消息里禁止携带——它描述的是「谁能拉到这张卡」，不是卡的内容。

## 许可

Apache-2.0。协议规范本身 CC-BY-SA 4.0。

- 源码：https://github.com/hongxian-dev/hongxian/tree/main/packages/schema
- 官网：https://hongxian.dev
