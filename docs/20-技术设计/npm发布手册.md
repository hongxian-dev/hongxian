# npm 发布手册

> **版本** v1.0 / **日期** 2026-10-24 / **状态** 首发待执行
> 适用：`@hongxian/schema` `@hongxian/crypto` `@hongxian/core` `@hongxian/mcp`（`@hongxian/server` 暂不发，见 §9）

---

## 1. 现状

**✅ 已发布（2026-10-24 22:55）**：`@hongxian/schema` / `crypto` / `core` / `mcp` 四包 `0.1.0`，registry 可下载，`npx -y @hongxian/mcp` 实测跑通（干净目录 `npm i` + bin 启动均验证）。

| 项 | 状态 |
|---|---|
| `@hongxian` org | ✅ 已建（owner: `sunchaooo`） |
| 四个包 | ✅ 0.1.0 已上线，`latest` 指向 0.1.0 |
| provenance | ⚠ **首发没有**（本地发布生成不了），0.1.1 起走 CI 补齐 |
| `@hongxian/server` | 仍不发（AGPL 署名主体未定 + `exports` 待拆，见 §9） |
| 残留 | 每个包多一个 `0.0.0-stage` 占位版本（npm 新包首次发布的副作用，无害，见 §10） |

---

## 2. 一次性前置（只有人能做）

### 2.1 建 org

https://www.npmjs.com/org/create → 名称填 `hongxian` → 选 **免费 / Unlimited public packages**。

> 建完先别急着建 token。**已泄露的那个 token 必须 revoke**，然后重新生成——建 org 之前生成的 token，其包范围里不含 `@hongxian`，发了也会被拒。

### 2.2 重新生成 token

npmjs.com → Access Tokens → Generate New Token → **Granular Access Token**：

| 字段 | 取值 |
|---|---|
| Expiration | 90 天（不要选 no expiration） |
| Packages and scopes | **Read and write** |
| 包范围 | `@hongxian` scope（或 All packages） |
| Organizations | `hongxian` → read and write |
| Bypass 2FA | 勾选（CI 无法交互输入 OTP） |

Classic token 也行，但权限过宽（能改所有包、能改账号设置）。**发布只需要 granular。**

### 2.3 放进 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret：
名称 **`NPM_TOKEN`**，值就是上面那个 `npm_...`。

> 任何文件、任何提交、任何 `.env` 里都不得出现这个值。`release.yml` 只通过 `${{ secrets.NPM_TOKEN }}` 引用。

---

## 3. 首次发布

本地先自检（不上传）：

```bash
npm run build
npm run verify        # 全量回归，不绿不发
npm run pack:check    # tarball 体检：必须 4/4 ✓
npm run release:dry   # 演练，四个包依次打一次包，不传字节
```

推 tag，让 CI 发：

```bash
git add -A
git commit -m "chore: release v0.1.0"
git tag v0.1.0
git push origin main --tags
```

`release.yml` 会：`npm ci` → build → **全量 verify** → pack:check → 校验 tag 与版本一致 → 按
`schema → crypto → core → mcp` 顺序发布，每个包带 `--provenance --access public`。

顺序不能改：`core` 依赖 `schema@0.1.0` 精确版本，`schema` 不在 registry 上，`core` 装上就失败。

手动兜底（CI 不通时才用，**会丢失 provenance**）：

```bash
NODE_AUTH_TOKEN=npm_xxx node scripts/publish-all.mjs
```

### 发布完立刻验

```bash
npm view @hongxian/mcp version          # 0.1.0
npm view @hongxian/mcp dist.tarball     # 有 tarball 地址
npx -y @hongxian/mcp --help             # 真的能跑起来（这一步不能省）
```

---

## 4. 日常发版

```bash
node scripts/bump-version.mjs patch     # 五包版本 + 相互依赖一次改对
npm install --package-lock-only         # 让 lock 对齐，否则 CI 的 npm ci 直接拒跑
npm run build && npm run verify
npm run pack:check && npm run release:dry
git add -A && git commit -m "chore: release v0.1.1"
git tag v0.1.1 && git push origin main --tags
```

`release.yml` 里 `publish-all.mjs` 会先查 registry：**已存在的版本直接跳过**。
所以「发到一半失败」时，修完重跑整条链是安全的，不会卡在已发布的包上。

---

## 5. 不可逆红线（发布前必读）

来自 [npm unpublish 政策](https://docs.npmjs.com/policies/unpublish)：

- **版本号永久不可重用。** `@hongxian/mcp@0.1.0` 一旦用过，即使删掉，别人也不能再用这个号，你也不能。
  所以**别发空包试水**——`guard-publish.mjs` 就是为这个存在的。
- 发布后 **72 小时内**，若没有其他包依赖它，可以 `npm unpublish` 自行撤回。
- 超过 72 小时，必须同时满足三条才能撤：无依赖 + 近一周下载 < 300 + 单一维护者。
- 全部版本撤下后，**24 小时内不能发新版本**。
- 不符合条件时唯一手段是 **deprecate**（`npm deprecate @hongxian/mcp@0.1.0 "别用，有安全问题"`），
  包还能下载，但会显示警告。

> 结论：**宁可晚发一天，也不要发错一个版本号。**

---

## 6. 发布后收尾（当天做完）

1. **切换到 Trusted Publishing**，彻底摆脱长期 token：
   包 Settings → Trusted publishing → GitHub Actions，填
   - Organization or user：`hongxian-dev`
   - Repository：`hongxian`
   - Workflow filename：`release.yml`（**只填文件名**，区分大小写）

   ⚠️ 两个坑：① 新建的 trusted publisher 配置必须在 **2 天内完成一次成功发布**才会生效并绑定，否则作废重配；② 配置创建后**不能改**，填错了只能删了重建。
   要求 npm CLI ≥ 11.5.1、Node ≥ 22.14.0、GitHub 托管 runner。

2. 验证 OIDC 发布成功后，回包 Settings → Publishing access 选
   **Require two-factor authentication and disallow tokens**，然后 revoke 所有 granular token。

3. 改文案（这是最后一步，别提前做）：
   - 主 `README.md` 第 20 / 44 行：删掉「尚未发布到 npm」
   - `apps/web/index.html` 四处（约 334 / 649 / 665 / 761 行）：`git clone …` → `npx -y @hongxian/mcp`
   - FAQ Q6 里「npx 一行安装要等 npm 发布，目前还没发」整段重写
   - `docs/README.md`、`docs/20-技术设计/技术详设.md` 里「npm 未发布（registry 404）」的表述
   - `MEMORY.md` 第 9 节那条「任何文档不得写未验证的一行安装」→ 改为已验证

---

## 7. 常见报错对照

| 报错 | 原因 | 处理 |
|---|---|---|
| `E404 Scope not found` | org 还没建 | 去建 `hongxian` org |
| `E403 Forbidden` + 发布时 | token 没有该 scope 的写权限 | 重发 granular token，勾 `@hongxian` read+write |
| `E402 Payment Required` | scoped 包按私有发，触发了付费团队包 | `publishConfig.access` 必须是 `public` |
| `E409 Conflict` | 该版本已存在 | 不能重发同号，只能 bump 版本 |
| `provenance` 相关报错 | 在本地发布，或 `repository.url` 与仓库不匹配 | 只能 CI 发；`repository` 必须精确指向 `hongxian-dev/hongxian` |
| `npm ci` 报 lock 不一致 | bump 后没更新 lock | `npm install --package-lock-only` |
| `ENEEDAUTH` | token 没传进 CI，或 2FA 拦截 | 检查 `NODE_AUTH_TOKEN`；granular token 要勾 bypass 2FA |
| `npx` 装完报语法错 | bin 缺 shebang | `guard-publish.mjs` 已拦，检查 dist 首行 |

---

## 8. 结构说明

```
scripts/packages.mjs       发布清单与顺序（唯一来源，改这里）
scripts/guard-publish.mjs  prepublishOnly 闸门：dist/README/LICENSE/bin shebang 缺一不发
scripts/pack-check.mjs     npm run pack:check —— tarball 内容逐项核对
scripts/publish-all.mjs    npm run release / release:dry —— 按顺序发，已存在则跳过
scripts/bump-version.mjs   npm run bump —— 版本与相互依赖一起改
.github/workflows/release.yml  tag 触发，verify 通过才发
```

---

## 9. `@hongxian/server` 为什么暂不发

三个包已具备发布条件（元数据、AGPL-3.0 全文已内置、守卫会检查），但首发不发：

- AGPL 的**署名主体未定**（个人 / 上海讯锡 / 鹊桥），发了再改要动 LICENSE；
- 自托管走 `docker compose` 更自然，npm 上的 server 包不是主路径；
- 它还有个待修的设计：`main` 指向的 `dist/index.js` 同时是 bin，别人 `import` 会直接起 HTTP 服务。
  要发之前先把 `exports` 拆开（`.` → `dist/app.js`，`./app` 显式导出）。

要发时把 `scripts/packages.mjs` 里的 `NOT_YET` 挪进 `PACKAGES` 末尾即可，其余不用改。

---

## 10. 首发实录（2026-10-24）：四个真实坑

这一节是事后写的，全部来自当晚实际失败，不是推演。下次换机器或换人发版会再遇到。

### 10.1 token 必须勾对三项，缺一项报的是「404 包不存在」

症状：

```
npm publish -w @hongxian/schema --access public
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/@hongxian%2fschema
npm error 404 The requested resource '@hongxian/schema@0.1.0' could not be found or you do not have permission to access it.
```

**npm 用 404 掩盖 403**，所以措辞看着像"包不存在/包名有问题"，实际是**权限不足**。当晚在这个措辞上白花了一轮。

比 `npm whoami` 有效的诊断命令：

```bash
npm access list packages --//registry.npmjs.org/:_authToken=<token>
# 403 → token 的组织授权段是空的（就是本条）
# 200 → 权限正常
```

Granular token 四项必须同时满足：

| 字段 | 必须的值 | 备注 |
|---|---|---|
| Permissions | **Read and write** | 只读发不了 |
| Packages and scopes | **@hongxian**（scope 级） | **不能选单个包**——首发时包里还不存在，列表里根本没有，选了个空 |
| Organizations | **hongxian → Read and write** | **最容易漏的一项**，两次 token 都缺在这里 |
| Bypass 2FA | 账号开了 2FA 就**必须勾** | 不勾会卡在一次性 OTP |

嫌麻烦：Classic Token → 类型 **Automation**，等价于账号全部权限、自动绕过 2FA，用完 revoke。

### 10.2 `npm profile get` 报 403 是正常的

`GET /-/npm/v1/user` 不在 granular token 的授权范围里，403 与发布权限无关。**别拿它判断能不能发。**

### 10.3 `PUT 202` + 随后 `GET 404` ≠ 失败

首发一个全新 scope 会看到三个「看起来像失败」的现象：

1. `npm publish` 结尾是 `+ @hongxian/xxx@0.1.0` 加一句「being processed and may take a few minutes」——**`+` 号就是成功**；
2. HTTP 是 **202 Accepted**，不是 201；
3. 紧接着 `npm view` 仍然 404。

因为 registry 先建一个 `0.0.0-stage` 的 stub 占位版本，真实版本随后才落。**唯一可靠的完成判据**：

```bash
curl -s https://registry.npmjs.org/@hongxian%2fschema \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(Object.keys(j.versions).join(", "))})'
# 看到 0.0.0-stage, 0.1.0 且 0.1.0 的 dist.tarball 存在 = 完成
```

本次实测：schema/crypto/core 约 1 分钟内落地，**mcp 最慢，约 2 分半**。四个包串行发，最后一个落地时第一个可能还没完全就绪——**不用重发**（重发会 409）。

### 10.4 本地发布必须加 `--no-provenance`

`package.json` 里 `publishConfig.provenance: true` 只在云 CI 成立。本地 `npm publish` 带它会直接失败。所以：

```bash
# 本地（一次性妥协，无 provenance）
node scripts/publish-all.mjs --no-provenance

# CI（release.yml 里，永远不要加这个参数）
node scripts/publish-all.mjs
```

代价要如实写进 README 与 install-and-trust：**0.1.0 没有 provenance，0.1.1 起补齐**。不要为了好看把这句话删掉——被问到"你们的包可验证构建吗"时，答案必须是准的。

### 10.5 本次实际执行的完整命令序列

```bash
# 0. 前置：org 已建、token 四项勾对
npm whoami --//registry.npmjs.org/:_authToken=<token>        # sunchaooo
npm run build && npx vitest run                              # 372/372
node scripts/pack-check.mjs                                  # 4/4 合格
node scripts/publish-all.mjs --dry-run --no-provenance        # 演练

# 1. 真发（四个包，schema→crypto→core→mcp）
NODE_AUTH_TOKEN=<token> node scripts/publish-all.mjs --no-provenance

# 2. 判完成（不要只看 npm publish 的退出码）
curl -s https://registry.npmjs.org/@hongxian%2fmcp | grep -o '"versions":{[^}]*'

# 3. 干净目录验收（这一步才是"发布成功"的真正含义）
mkdir -p /tmp/npm-real && cd /tmp/npm-real && npm init -y && npm i @hongxian/mcp
./node_modules/.bin/hongxian-mcp < /dev/null
# [yuelao] 月老已上线（STDIO，零服务端依赖）。21 件工具 + 8 条指引就绪。

# 4. 承诺级验收：npx 一行
npx -y @hongxian/mcp < /dev/null
```

### 10.6 遗留：`0.0.0-stage`

四个包各多一个 stub 版本 `0.0.0-stage`，`latest` 不指向它，不影响安装。它由 registry 在创建新包时自动写入，正常发版途径删不掉。**不要试图为此重发或 unpublish**——收益为零，风险是版本号被永久占用。

### 10.7 未做但该做的两件

1. **GitHub Actions 首发**（有 provenance）：把 `NPM_TOKEN` 加进 repo Secrets，打 tag 触发 `release.yml`。首发没走这条路只因为当时 `git push` 被本地代理掐断（`CONNECT tunnel 502`），改用本地直发。
2. **Trusted Publishing 迁移**：包已在 registry 上，现在可以去包的 Settings → Trusted Publisher 绑定 `hongxian-dev/hongxian` + `release.yml`，之后彻底不需要 `NPM_TOKEN`。注意 GitHub changelog 已明确：**bypass-2FA 的 token 将在 2027 年 1 月失去直接发布能力**，只剩 stage 能力——所以这条不是可选项。
