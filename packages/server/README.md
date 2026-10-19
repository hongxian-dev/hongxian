# 红线平台服务 · 参考实现（@hongxian/server）

> 哑管道广场 + 加密信箱。零知识：本服务只存取转发密文，不出网、不追踪。
> 许可：AGPL-3.0（自托管衍生必须同许可开源——联邦制的信任地基）。
> 设计文档：《平台服务v2工程执行设计》《docs/protocol-v1-spec.md》。

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

## API v1（八端点）

| 端点 | 认证 | 说明 |
|---|---|---|
| `GET /healthz` | 无 | 健康检查（无计数、无追踪） |
| `POST /v2/identity/register` | 持钥证明 | `{opaque_id, sig_public, kx_public}`；opaque_id 必须 = SHA-256(sig_public) 指纹（协议 §7） |
| `GET /v2/identity/:opaqueId` | 无 | 存在性 200/404 |
| `DELETE /v2/identity` | 签名认证 | 注销：级联删全部密文 |
| `POST /v2/cards` | 卡自带签名 | 贴广场卡（只收 plaza_card 变体；**携 key_l1 一律拒收**，协议 §10.5） |
| `GET /v2/cards?cursor=&limit=` | 无 | 哑管道全量池 + cursor 分页（零过滤零排序） |
| `DELETE /v2/cards/:fingerprint` | 签名认证 | 撤卡（持钥人） |
| `POST /v2/mailbox/:address` | 信封自带签名 | 定向投递（限速 20 封/日；收件人须已注册） |
| `GET /v2/mailbox/:address?cursor=&limit=` | 签名认证 | 拉取自己的信箱 |
| `DELETE /v2/mailbox/:address/:envId` | 签名认证 | 删单封信 |

**URL 编码规则**：地址含 base64 字符（`+ / =`），路径中必须百分号编码
（`encodeURIComponent`）；认证 action 字符串用未编码地址。

**签名认证头**：`X-Hongxian-Auth: <opaque_id>:<unix_ts>:<sig_b64>`
签名对象 = `canonical({opaque_id, ts, action})`，action = `METHOD /路径`（未编码地址），
时间窗 ±300s。参考实现见 `src/auth.ts` 的 `buildAuthHeader`。

**没有任何端点**：搜索、排序、推荐、匹配、在线状态、已读回执——不是没做，是协议不允许。

## 零知识是怎么保证的

1. **构造性**：上传即验签 + `plaza_card` 携 `key_l1` 在 schema 层拒收；L1 钥匙只经
   `grant_l1` 信封密封交付（协议 §5 广场流）。
2. **可证伪**：`npm test` 的零知识审计套件对源码做断言——不得 import
   `@hongxian/crypto`、不得出现解密原语、不得含任何 URL（零出网）、数据目录
   grep 不到 `key_l1` 与 L1 明文字段。
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
