# 红线计数器（hongxian-counter）

> 独立于月老 Skill 与红线协议的**纯计数器**（Cloudflare Worker + KV）。
> 法律性质 ≈ 网站访问计数器：不存储任何用户数据、不参与任何匹配流程、不认识任何用户。
> 这是它能进 v1（零服务端军规）的原因。

对应设计文档：《产品网站与透明统计v1设计初稿》第 2 节、《技术详设》第 7 节部署物三。

## 端点

| 端点 | 方法 | 调用方 | 说明 |
|---|---|---|---|
| `/bump` | POST | 月老 Skill（opt-in，默认关闭） | 上报一条匿名计数 |
| `/stats` | GET | 产品网站透明数据区 | 公开只读聚合数据 |

### POST /bump

```json
{ "metric": "gender", "bucket": "female", "salt": "…", "nonce": "…" }
```

- `metric` ∈ `cards` / `gender` / `age_band` / `exchanges`，`bucket` 取值见下表
- **工作量证明**：客户端需找到 `nonce`，使 `sha256(salt|metric|bucket|nonce)` 的十六进制前导 `POW_DIFFICULTY`（默认 4）位全为 0——防刷数字
- **限速**：同一 IP 哈希每天 120 次（KV 只存 IP 哈希 + 服务端盐，不存 IP 本身）
- **当日去重**：`cards/active`（当日活跃）按 IP 哈希每天只计一次
- 无日志：不记录 IP、时间戳与任何请求内容

| metric | bucket | 累计为 |
|---|---|---|
| `cards` | `total` / `active` | `cards_total` / `cards_active_30d`（滚动 30 天） |
| `gender` | `female` / `male` | `gender_female` / `gender_male` |
| `age_band` | `18_25` / `26_30` / `31_35` / `36_40` / `40_plus` | `age_band_*` |
| `exchanges` | `total` | `exchanges_total` |

### GET /stats

```json
{
  "counters": { "cards_total": 0, "cards_active_30d": 0, "gender_female": 0, "…": 0 },
  "updated_at": "2026-10-15T12:00:00.000Z",
  "notice": "匿名聚合数据 · opt-in 上报 · 无用户标识 · 无 IP 记录"
}
```

## 部署（W6，约半天）

```bash
cd apps/counter
npm install                       # 安装 wrangler
npx wrangler kv:namespace create COUNTER
# 把返回的 id 填进 wrangler.toml 的 [[kv_namespaces]] id
npx wrangler secret put RL_SALT   # 设置限速哈希盐（随机长字符串，勿外泄）
npx wrangler deploy
```

**绑定自定义域**：Cloudflare Dashboard → Workers & Pages → `hongxian-counter` → Triggers → Custom Domains → 添加 `count.hongxian.dev`（DNS 需托管在 Cloudflare）。添加后 `apps/web/assets/js/main.js` 中的 `STATS_URL` 即指向真实端点；未绑定前网站自动降级显示「等待第一个用户」。

## 已知近似与边界（诚实清单）

1. **KV 最终一致性**：免费额度下读-改-写非原子，极端并发可能少计。对「生态健康数据」口径可接受；若数字成为战略资产，可升级 Durable Objects（付费）。
2. **滚动 30 天口径**：按日桶求和（保留 45 天）。同一 NAT 后多设备同日上报只计一次（去重按 IP 哈希）——是近似，不是精确 UV，页面文案不称「用户数」。
3. **难度可调**：若 Skill 上报端算力弱，调低 `POW_DIFFICULTY`；若发现刷数字，调高（1-8）。
4. **反污染**：`/stats` 公开只读；写端点限速 + PoW。数字被刷爆会反噬信任，这是设计 PoW 的原因。

## 月老 Skill 上报开关（另半天，Skill 侧）

- `settings.json` 中 opt-in 开关默认**关闭**；首次启动知情同意页明示「开启后仅上报以上匿名计数」
- 开启后，事件触发时客户端完成 PoW 并 POST 到 `/bump`；关闭后出网流量为零（v1 验收线）
