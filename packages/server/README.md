# 红线平台服务 · 参考实现（@hongxian/server）

> 哑管道广场 + 加密信箱。零知识：本服务只存取转发密文，不出网、不追踪。
> 许可：AGPL-3.0（自托管衍生必须同许可开源——联邦制的信任地基）。
> 协议全文见 [protocol-v1-spec.md](../spec/protocol-v1-spec.md)；《平台服务v2工程执行设计》属内部文档，不随仓库分发。

## 一分钟自托管

```bash
# 在仓库根目录（monorepo）
docker compose -f packages/server/docker-compose.yml up -d
curl http://127.0.0.1:8787/healthz
# → {"ok":true,"service":"hongxian-plaza","instance":"localhost"}
```

数据全部在 `packages/server/data/`（密文 + opaque ID + 公钥）。**删卷即删库**。
默认只监听容器网络；公网暴露请自行加反代与 TLS——那一刻起，你就是运营者
（法律义务见《v2 产品设计初稿》§8；官方实例的部署以书面法律意见为硬闸门）。

## 本地开发运行（不打包 docker）

```bash
npm run build
HONGXIAN_SERVER_DATA=./tmp-data PORT=8787 node packages/server/dist/index.js
```

## API v1（十二端点 + 发布许可五端点）

| 端点 | 认证 | 说明 |
|---|---|---|
| `GET /healthz` | 无 | 健康检查 + 实例策略（是否要求发布许可、验证页地址） |
| `POST /v2/identity/register` | 持钥证明 | `{opaque_id, sig_public, kx_public}`；opaque_id 必须 = SHA-256(sig_public) 指纹（协议 §7） |
| `GET /v2/identity/:opaqueId` | 无 | 存在性 200/404 |
| `DELETE /v2/identity` | 签名认证 | 注销：级联删全部密文（含发布许可） |
| `POST /v2/cards` | 卡自带签名 | 贴广场卡（只收 plaza_card 变体；**携 key_l1 一律拒收**，协议 §10.5）。要求发布许可的实例上，未验证返回 403 `publish_requires_verification` |
| `GET /v2/cards?cursor=&limit=` | 无 | 哑管道全量池 + cursor 分页（零过滤零排序） |
| `DELETE /v2/cards/:fingerprint` | 签名认证 | 撤卡（持钥人） |
| `POST /v2/mailbox/:address` | 信封自带签名 | 定向投递（限速 20 封/日；收件人须已注册）。**被阻断的一方投递一律沉底**，响应与成功投递逐字段一致 |
| `GET /v2/mailbox/:address?cursor=&limit=` | 签名认证 | 拉取自己的信箱 |
| `DELETE /v2/mailbox/:address/:envId` | 签名认证 | 删单封信 |
| `POST /v2/reports` | 签名认证 | 举报（受控理由码；加盐假名，独立人数 ≥3 → flagged）。**举报立即生效**：双向切断投递（见下） |
| `GET /v2/reports/:opaqueId` | 签名认证 | 查自己的举报汇总（仅本人） |
| `GET /v2/stats` | 无 | 匿名聚合（只有总和） |
| `GET /v2/publish/disclosure` | 无 | 贴卡前披露声明全文 + 版本号（公开可读，改措辞不必发客户端） |
| `POST /v2/publish/otp` | 无（浏览器） | 发验证码；载体只存 HMAC。未配发信通道 → 503 |
| `POST /v2/publish/verify` | 无（浏览器） | 验证码换 8 位一次性许可码（5 分钟 / 5 次试错） |
| `PUT /v2/publish/credential` | 签名认证 | 许可码换发布许可（**归属在此步建立**） |
| `GET /v2/publish/credential` | 签名认证 | 只回答"有没有"，不回答"用哪个邮箱" |
| `DELETE /v2/publish/credential` | 签名认证 | 解绑（历史卡不追溯） |

**URL 编码规则**：地址含 base64 字符（`+ / =`），路径中必须百分号编码
（`encodeURIComponent`）；认证 action 字符串用未编码地址。

**签名认证头**：`X-Hongxian-Auth: <opaque_id>:<unix_ts>:<sig_b64>`
签名对象 = `canonical({opaque_id, ts, action})`，action = `METHOD /路径`（未编码地址），
时间窗 ±300s。参考实现见 `src/auth.ts` 的 `buildAuthHeader`。

**没有任何端点**：搜索、排序、推荐、匹配、在线状态、已读回执——不是没做，是协议不允许。

## 两处显式例外（都写进了协议，都不是"平台开始管内容"）

| 例外 | 做什么 | 不做什么 |
|---|---|---|
| **发布许可**（`/v2/publish/*`） | 贴卡进公开列表前要求一次载体可达性确认 | 不验证身份、不进登录链路、不展示、不参与排序 |
| **举报即断**（`POST /v2/reports`） | 举报**立即**切断这一对的双向投递；`blocks/` 里只存加盐标记 | 不通知被举报方、不改广场列表、不封禁、不裁决 |

举报即断的命门是**对发件人完全不可见**：被阻断的投递返回与成功投递完全相同的结构
（同状态码、同 `id`、同 `entered_mailbox`、配额照扣、不加延时）。任何可观测差异都会告诉
被举报方"有人举报了你"，并帮他反推是谁——那样这条防护就从保护变成了加害。

## 零知识是怎么保证的

1. **构造性**：上传即验签 + `plaza_card` 携 `key_l1` 在 schema 层拒收；L1 钥匙只经
   `grant_l1` 信封密封交付（协议 §5 广场流）。
2. **可证伪**：`npm test` 的零知识审计套件对源码做断言——不得 import
   `@hongxian/crypto`、不得出现解密原语、数据目录 grep 不到 `key_l1` 与 L1 明文字段；
   **出网只有一个点**：`src/mailer.ts`，且只允许打 `api.resend.com`，且该文件不得引用
   任何身份/载体/信封字段（它只认识"地址 + 6 位数字"）。除此之外全仓不得出现 URL、不得调用 `fetch`。
3. **可自托管**：本镜像就是全部；你跑的你验。

## 测试

```bash
npm test                                    # 单测（store/api/审计，31 项）
node packages/server/e2e/run-e2e.mjs        # 双客户端 E2E（21 项，需先 build）
```

E2E 覆盖：注册持钥证明 → 贴卡 → 拉池 → 敲门 → grant_l1 应答 → 乙方解密 L1 →
数据目录零知识审计 → 注销级联清零。

## 路线图

- v2.0（本实现）：单实例哑管道 + 信箱；`@instance` 寻址后缀已预留
- v2.1：实例间联邦转发（收件人 ID 带实例域，类 Email）
- 规模需要时：`declared_filters` 粗粒度分拣（Schema v0.5，宪法 §3 的允许极限）
