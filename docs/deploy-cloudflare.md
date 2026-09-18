# 部署到 Cloudflare Workers

本文说明如何把 NodeTunnel 部署成一个 **Cloudflare Worker**，并实现这样的效果：

- 各条隧道用**自己的完整域名**访问（`project1.example.com` → 主机端 8080 端口的应用）；
- 其余所有域名（含 `*.workers.dev` 域名）都直接打开**管理后台**。

---

## 1. 「前后端端口分离」在部署后为什么就不存在了

开发期确实有两个端口：

| 角色     | 开发期                                 | 部署后                        |
| -------- | -------------------------------------- | ----------------------------- |
| 管理后台 | Vite dev server，`127.0.0.1:5173`      | Worker 自身的域名（静态资源） |
| 管理 API | Worker，`127.0.0.1:8787`               | 同一个 Worker，`/api/v1/*`    |
| 跨域处理 | `vite.config.ts` 把 `/api` 代理到 8787 | **不需要**，同源              |
| CORS     | 需要 `NT_ADMIN_ORIGIN`                 | **不需要**                    |

原因是部署形态下管理后台的构建产物被打包进 Worker 的静态资源
（`apps/worker/wrangler.jsonc` 的 `assets` 配置，目录指向 `apps/admin/dist`），
浏览器访问的是**同一个源**，`fetch('/api/v1/...')` 天然同源，
Cookie 也是第一方 Cookie。

所以：**部署后前端不需要任何改动，也不需要配置接口地址。**

> 开发期的 `pnpm dev:admin` + `/api` 代理仍然保留，两者互不影响。

---

## 2. 请求是怎么分流的

`apps/worker/src/index.ts` 里按固定顺序判断，这个顺序就是整套设计的核心：

| 顺序 | 条件                            | 去处                                |
| ---- | ------------------------------- | ----------------------------------- |
| 1    | 路径是 `/agent`                 | 主机端 agent 的信令接入（所有域名） |
| 2    | 路径是 `/signal`                | 浏览器访客的信令接入（所有域名）    |
| 3    | **Host 命中某条路由的专属域名** | 该应用（整站接管，根路径原样转发）  |
| 4    | 路径是 `/health`                | 运行状态 JSON                       |
| 5    | 路径以 `/api/v1` 开头           | 管理 API                            |
| 6    | 其它                            | 管理后台 SPA（静态资源）            |

两个关键点：

- **第 1、2 步必须在第 3 步之前。** 否则把 agent 指向某个专属域名时，
  隧道会因为「域名被应用占用」而自己把自己挡掉。
- **第 3 步必须在第 5 步之前。** 一个被占用的域名是「专用」的；
  若先匹配 `/api/v1`，应用自己的 `/api/v1/*` 就会被管理 API 截胡。

因为顺序由代码决定，`wrangler.jsonc` 里的 `assets.run_worker_first` **必须为 `true`**：
否则 Cloudflare 会先匹配静态资源，专属域名下的 `/index.html`、`/assets/*.js`
会被管理后台的构建产物抢走，表现为「隧道通了但打开的是管理后台」。

---

## 3. 部署步骤

### 3.1 前置

- 一个 Cloudflare 账号；
- 一个托管在 Cloudflare 的域名（推荐，见第 4 节）；只用 `*.workers.dev` 也能跑通；
- 本地装好 Node ≥ 20 与 pnpm，并 `pnpm install`。

### 3.2 创建 D1 数据库

```bash
pnpm --filter @nodetunnel/worker exec wrangler d1 create nodetunnel
```

输出里会有 `database_id`（8 段 UUID）。把它填进
`apps/worker/wrangler.jsonc` 的 `d1_databases[0].database_id`，替换掉
`REPLACE_WITH_REAL_D1_ID`。

> 这个 id **不是密钥**，可以提交到仓库 —— 这也是「导入仓库一键部署」能成立的前提。

### 3.3 配置会话密钥

```bash
pnpm --filter @nodetunnel/worker exec wrangler secret put ADMIN_SESSION_SECRET
```

粘一个至少 32 字节的随机串。生成一个：

```powershell
-join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
```

`ADMIN_SESSION_SECRET` 是唯一的必需密钥。**不需要**配置 `NT_ADMIN_ORIGIN`：
部署后前后端同源，CORS 那条路径根本不会走到。

### 3.4 应用数据库迁移

```bash
pnpm db:migrate:remote
```

> 迁移不是幂等的「重跑」，但 Wrangler 会记录已应用的迁移，重复执行是安全的。
> 因此把它放进部署命令（见 3.6）也没问题。

### 3.5 本地先部署一次（可选但推荐）

```bash
pnpm deploy
```

它会先 `pnpm build`（turbo 构建，其中 `@nodetunnel/worker#build` 显式依赖
`@nodetunnel/admin#build`，保证 assets 目录在 Wrangler 校验之前已存在），
再执行 `wrangler deploy`。

### 3.6 用 GitHub 一键部署（Workers Builds）

1. 把仓库推送到 GitHub。
2. 打开 Cloudflare Dashboard → **Workers & Pages** → **Create application**
   → **Import a repository** → 选中这个仓库。
3. 按下面的值填写构建设置：

   | 设置项                        | 值                                                                                        |
   | ----------------------------- | ----------------------------------------------------------------------------------------- |
   | **Root directory**            | `apps/worker`                                                                             |
   | **Build command**             | `pnpm --filter @nodetunnel/admin build`                                                   |
   | **Deploy command**            | `pnpm exec wrangler d1 migrations apply nodetunnel --remote && pnpm exec wrangler deploy` |
   | **Non-production deploy cmd** | `pnpm exec wrangler versions upload`（默认值，保持不动）                                  |

   > **Root directory 必须设为 `apps/worker`**，因为 `wrangler.jsonc` 在那里，
   > Workers Builds 也要求 Worker 名字与配置文件里的 `name`（`nodetunnel`）一致。
   > pnpm 会自动向上找到 workspace 根目录，所以 `--filter` 与 lockfile 都能正常工作。

   > 依赖安装不用写进构建命令：Workers Builds 会检测到 `pnpm-lock.yaml` 并自动
   > 执行 `pnpm install`（它会向上找到 workspace 根，安装整个 workspace）。

4. **Save and Deploy**。之后每次 push 都会自动构建 + 部署。

> 构建镜像默认 pnpm 版本是 10.x，而仓库声明了 `packageManager: pnpm@11.22.0`。
> Corepack 会按 `packageManager` 字段切换到 11.22.0；如果构建日志里出现
> pnpm 版本报错，在 **Settings → Build → Build Variables** 里加一个
> `PNPM_VERSION=11.22.0` 即可。

---

## 4. 把域名指向 Worker

这是「除路由域名外都打开管理后台」的关键一步。有两种做法，建议**两个都做**。

### 4.1 给管理后台一个专属域名（Custom Domain）

Workers & Pages → 选中 `nodetunnel` → **Settings → Domains & Routes → Add → Custom Domain**，
填 `tunnel.example.com`。

Cloudflare 会自动创建 DNS 记录并签发证书。访问它得到管理后台。

### 4.2 用通配路由接住所有隧道域名（Route）

Workers & Pages → 选中 `nodetunnel` → **Settings → Domains & Routes → Add → Route**，
填 `*.example.com/*`，区域选 `example.com`。

同时确认 DNS 里有一条**代理开启（橙色云朵）**的通配记录：

| 类型 | 名称 | 内容        | 代理 |
| ---- | ---- | ----------- | ---- |
| A    | `*`  | `192.0.2.1` | ✅   |
| AAAA | `*`  | `100::`     | ✅   |

（`192.0.2.1` / `100::` 是 Cloudflare 官方文档给出的「必须经由 Worker 处理」的占位地址。）

配好之后：

- `project1.example.com` → 命中第 3 步的专属域名判断 → 打开主机端 8080 的应用；
- `admin.example.com`、`随便什么.example.com` → 没有对应路由 → 打开管理后台。

**这正是你想要的效果**，而且不需要为每个隧道单独加域名：新增一条路由时，
只要在管理后台的「路由管理」里把专属域名填成 `新域名.example.com` 就行，
DNS 与证书由通配记录和 Cloudflare 自动覆盖。

> 注意：`*.example.com` 不匹配裸域 `example.com`。如果也想让裸域打开管理后台，
> 再单独加一条 `example.com/*` 的路由。

### 4.3 关于 HTTPS

Cloudflare 在边缘终结 TLS，所以：

- 浏览器 ↔ Worker 这一段是 HTTPS（会话 Cookie 会自动带 `Secure`）；
- Worker ↔ 主机端 agent 这一段仍然按原设计走 HTTP/WebSocket。

也就是说，第 1 节里「仅支持 HTTP」的限制**只影响主机端被暴露的那个服务本身**，
公网入口这一段是自动加密的。

---

## 5. 部署后自检

```bash
# 管理后台（应返回 index.html）
curl -I https://tunnel.example.com/

# 运行状态（应返回 JSON）
curl https://tunnel.example.com/health

# 专属域名（应返回应用的响应）
curl -I https://project1.example.com/
```

在浏览器里确认：

1. `tunnel.example.com` 打开管理后台，能登录；
2. 管理后台的「设置」页里，接入信息显示的是当前域名派生的地址；
3. 在主机端跑 agent，连上后「主机端」页面显示在线；
4. 访问专属域名能打开目标应用，且**静态资源的 MIME 正常**（不是空 MIME）。

---

## 6. 常见问题

**打开专属域名却看到管理后台。**
`assets.run_worker_first` 不是 `true`。Cloudflare 的静态资源路由抢在了 Worker 前面。

**构建日志报 `The name in your Wrangler configuration file must match the name of your Worker`。**
Dashboard 上的 Worker 名字与 `apps/worker/wrangler.jsonc` 里的 `name` 不一致，
两边都改成 `nodetunnel`。

**构建日志报 `Missing entry-point`。**
Root directory 没设成 `apps/worker`。

**部署报 `database_id` 无效。**
`REPLACE_WITH_REAL_D1_ID` 还没替换。

**`/health` 返回了 HTML。**
说明 `/health` 被 SPA 回退吃掉了。检查 `index.ts` 里第 4 步是否还在第 6 步之前。

**管理后台刷新子路由 404。**
`apps/worker/src/admin/spa.ts` 只对导航请求（`Accept: text/html`）回退
`index.html`。如果新加了 SPA 路由且刷新 404，确认浏览器发出的是导航请求。
