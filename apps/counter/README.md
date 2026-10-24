# 红线计数器（hongxian-counter）

> 独立于月老 Skill 与红线协议的**纯计数器**（Cloudflare Worker + KV）。
> 法律性质 ≈ 网站访问计数器：不存储任何用户数据、不参与任何匹配流程、不认识任何用户。
> 这是它能进 v1（客户端零服务端依赖军规）的原因。

对应设计文档：PRD §8（透明统计口径）、《技术详设》第 7 节部署物三。

## 端点

| 端点 | 方法 | 调用方 | 说明 |
|---|---|---|---|
| `/bump` | POST | 月老 Skill（opt-in，默认关闭） | 上报一条匿名计数 |
| `/stats` | GET | 产品网站透明数据区 | 公开只读聚合数据 |

### POST /bump

```json
{ "metric": "card_signed", "bucket": "female", "salt": "…", "nonce": "…" }
```

- **`metric` 用事件名**（与 `packages/mcp/src/counter.ts` 的 `METRIC_WHITELIST` 同一套词表），服务端经 `EVENT_ALIASES` 映射到计数家族；也兼容旧口径（`metric` = 家族名 + `bucket`）
- **工作量证明**：客户端需找到 `nonce`，使 `sha256(salt|metric|bucket|nonce)` 的十六进制前导 `POW_DIFFICULTY`（默认 4）位全为 0——防刷数字。Skill 侧已内置求解（`solvePow`，Node `crypto` 同步循环，约 65k 次/条）
- **限速**：同一 IP 哈希每天 120 次（KV 只存 IP 哈希 + 服务端盐，不存 IP 本身）
- **当日去重**：`cards/active`（当日活跃）按 IP 哈希每天只计一次
- 无日志：不记录 IP、时间戳与任何请求内容

| 事件名（Skill 上报） | 累计为 | 备注 |
|---|---|---|
| `card_signed` | `cards_total`（+ `gender_female`/`gender_male`，当 bucket ∈ female/male） | 建卡同时做性别聚合 |
| `card_imported` | `imports_total` | 不对外展示 |
| `exchange_initiated` / `envelope_sent` | `envelopes_total` | 握手发起 ≈ 一封加密信封 |
| `plaza_published` | `plaza_total` | 红线广场贴卡 |

旧口径（继续兼容）：`cards`×`total`/`active`、`gender`×`female`/`male`、`age_band`×年龄段、`exchanges`×`total`。

### 契约测试（自动化代替手工 curl）

```bash
npx vitest run apps/counter/test/worker.test.ts   # 6 项：事件名映射 / PoW 403 / 词表 400 / site 块
npx vitest run packages/mcp/test/counter.test.ts  # 3 项：零出网 / 词表拒绝 / PoW 可验证
```

这两条链必须在同一轮改动里同时绿——两端词表或哈希拼接顺序任一漂移，上报都会静默失败（线上数字永远 0）。

### GET /stats

```json
{
  "counters": { "cards_total": 0, "cards_active_30d": 0, "envelopes_total": 0, "plaza_total": 0, "gender_female": 0, "…": 0 },
  "site": { "cards": 0, "cards_active_30d": 0, "envelopes": 0, "plaza": 0 },
  "updated_at": "2026-10-15T12:00:00.000Z",
  "notice": "匿名聚合数据 · opt-in 上报 · 无用户标识 · 无 IP 记录"
}
```

## 部署状态（✅ 2026-10-21 已上线）

**线上端点：`https://count.hongxian.dev/stats`**（实测 200，CORS `*`，5 分钟缓存）

| 资源 | 值 |
|---|---|
| Worker 名 | `hongxian-counter` |
| Cloudflare 账户 | 使用自有账号（`<ACCOUNT_ID>`，不入库） |
| Zone | `hongxian.dev` / `<ZONE_ID>`（不入库） |
| KV 命名空间 | `hongxian-counter-kv` / `<KV_NAMESPACE_ID>`（自建后替换） |
| 自定义域 | `count.hongxian.dev` |
| 机密 | `RL_SALT`（32 字节随机 hex，经 secrets API 上传，**不入库**） |
| 关键设置 | **Browser Integrity Check 必须关闭**（zone 级）——否则非浏览器 UA 的程序化上报会被 CF 以 1010 拦截 |

> 自托管说明：以下 `<ACCOUNT_ID>` / `<ZONE_ID>` / `<KV_NAMESPACE_ID>` 均需替换为你自己的值，`$CF_TOKEN` 通过环境变量注入、绝不写进仓库。

### 本次部署方式（wrangler 不可用时的 REST 直推，可复用）

```bash
# 1) 建 KV 命名空间
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"hongxian-counter-kv"}'

# 2) 上传 Worker（⚠️ 必须用 application/javascript+module，否则 ES module 会被按 service-worker 解析报
#    "Unexpected token 'export'"；metadata 里的 main_module 必须与 file part 的 filename 一致）
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/scripts/hongxian-counter" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -F "metadata=@meta.json;type=application/json" \
  -F "index.js=@src/index.js;filename=index.js;type=application/javascript+module"

# 3) 上传机密
curl -X PUT ".../workers/scripts/hongxian-counter/secrets" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"RL_SALT","text":"<32-hex>","type":"secret_text"}'

# 4) 绑定自定义域（幂等 PUT）
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/domains" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"zone_id":"'$ZONE'","hostname":"count.hongxian.dev","service":"hongxian-counter","environment":"production"}'
```

`meta.json` 内容：

```json
{"main_module": "index.js", "compatibility_date": "2026-10-15",
 "bindings": [
   {"type": "kv_namespace", "name": "COUNTER", "namespace_id": "<KV_NAMESPACE_ID>"},
   {"type": "plain_text", "name": "POW_DIFFICULTY", "text": "4"}
 ]}
```

### 验收实测记录（2026-10-21）

| 用例 | 结果 |
|---|---|
| `GET /stats` | ✅ 200，返回合法 JSON，`Access-Control-Allow-Origin: *` |
| 错误 PoW 的 `POST /bump` | ✅ 403 `pow required`（防刷生效） |
| 未知 metric 的 `POST /bump` | ✅ 400 `unknown metric` |
| 正确 PoW 的 `POST /bump` | ✅ 200 `{"ok":true,"metric":["cards_total"]}`，`/stats` 同步 +1 |
| `OPTIONS /bump` 预检 | ✅ 204 + CORS 头 |
| 非浏览器 UA（Python urllib） | ✅ 200（关闭 BIC 后） |

`apps/web/assets/js/main.js` 的 `STATS_URL` 无需改动，网站数据区已自动接上真实端点。

### 新版部署（✅ 2026-10-25，wrangler 路径，透明数据区口径修正）

改动：`site` 块加 `imports`、移除无上报来源的 `cards_active_30d`（详见 §已知近似与边界）。

```bash
export CLOUDFLARE_API_TOKEN="<token>"        # 环境变量注入，绝不入任何文件
export CLOUDFLARE_ACCOUNT_ID="<account-id>"

# 部署配置放 .tmp-gh/wrangler.deploy.toml（git 忽略），与 apps/counter/wrangler.toml
# 的区别只有：KV id 填真实值、main 相对 .tmp-gh/ 上跳、带 custom domain routes。
npx wrangler deploy -c .tmp-gh/wrangler.deploy.toml
```

**本次踩坑（下次直接读这条）**：

1. **线上绑定是 Custom Domain，不是 routes 也不是 workers.dev 子域**。不带 `routes = [{ pattern = "count.hongxian.dev", custom_domain = true }]` 部署会报 `register a workers.dev subdomain`。
2. **wrangler 3.114 + "Edit Cloudflare Workers" 模板 token 下，带 custom_domain 的部署仍报同样的错，但脚本已经上传生效**（wrangler 先传脚本、后配触发器，报错退出时脚本已在线）。判断成功的标准是 `GET /stats` 的返回结构，不是命令退出码。
3. **脚本上传不等于绑定丢失**：custom domain 是 script 之外的独立资源，重新部署不会解绑；`RL_SALT` secret 同样与脚本分离存储，重部署不丢。
4. 真实 KV id / account id / token 一律走环境变量和 `.tmp-gh/`，`apps/counter/wrangler.toml` 永远保持占位符。

**验收实测（2026-10-25）**：`/stats` 返回新 `site` 块（cards/imports/envelopes/plaza 四键）✅；PoW 解出后 `POST /bump` 返回 200 且 `/stats` 同步 +1 ✅；测试计数已删（`wrangler kv key delete` 删 `t:cards:total` 与当日日桶），归零后官网四格显示 0 + 绿色「实时数据」pill ✅。

> 网站侧消费逻辑（`apps/web/index.html`）：优先读新版 `d.site`，回退旧版 `d.counters` 扁平键；四键全取不到才标「数据源暂不可达」并显示 0。

## 已知近似与边界（诚实清单）

1. **KV 最终一致性**：免费额度下读-改-写非原子，极端并发可能少计。对「生态健康数据」口径可接受；若数字成为战略资产，可升级 Durable Objects（付费）。
2. **滚动 30 天口径**：按日桶求和（保留 45 天）。同一 NAT 后多设备同日上报只计一次（去重按 IP 哈希）——是近似，不是精确 UV，页面文案不称「用户数」。
3. **难度可调**：若 Skill 上报端算力弱，调低 `POW_DIFFICULTY`；若发现刷数字，调高（1-8）。
4. **反污染**：`/stats` 公开只读；写端点限速 + PoW。数字被刷爆会反噬信任，这是设计 PoW 的原因。

## 月老 Skill 上报开关（另半天，Skill 侧）

- `settings.json` 中 opt-in 开关默认**关闭**；首次启动知情同意页明示「开启后仅上报以上匿名计数」
- 开启后，事件触发时客户端完成 PoW 并 POST 到 `/bump`；关闭后出网流量为零（v1 验收线）
