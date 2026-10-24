# npm 发布手册

> **版本** v1.0 / **日期** 2026-10-24 / **状态** 首发待执行
> 适用：`@hongxian/schema` `@hongxian/crypto` `@hongxian/core` `@hongxian/mcp`（`@hongxian/server` 暂不发，见 §9）

---

## 1. 现状

| 项 | 状态 |
|---|---|
| registry 上 `@hongxian` scope | **不存在**（`Scope not found`，名字未被占） |
| 包名 `@hongxian/mcp` 等 | 未发布，registry 404 |
| 发布物（元数据 / LICENSE / README / 守卫 / 工作流） | ✅ 全部就绪，tarball 体检 4/4 合格 |
| 阻断项 | 只有一件：**org 还没建** |

包名没有被占这件事是运气，不是保证——**先去建，别拖**。

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
