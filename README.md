# NodeTunnel

部署在 Cloudflare Workers 上的自托管内网穿透服务。

一个 Worker 承担三件事，不需要任何常驻服务器：

1. **专属域名隧道** —— 每条路由绑定一个完整域名（`project1.example.com`），
   访问它就直接打开主机端内网里的那个 HTTP 服务。主机端主动连出，
   **不需要任何公网入口**。
2. **管理后台** —— 同一个 Worker 的另一个域名即是管理界面，
   管理隧道、路由、主机端与账号。
3. **其它所有域名** —— 只要没有绑定路由，一律打开管理后台。

> 仅支持 HTTP：浏览器无法在隧道内终止 TLS，被暴露的服务必须是 HTTP 明文服务。
> 公网入口那一段（浏览器 ↔ Worker）由 Cloudflare 自动加密，不受此限制。

---

## 快速开始（本地）

```bash
pnpm install

# 首次启动前创建本地密钥文件
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
#   把 ADMIN_SESSION_SECRET 换成至少 32 字节的随机串

pnpm db:migrate:local
pnpm dev:worker        # Worker:        http://127.0.0.1:8787
pnpm dev:admin         # 管理后台:      http://127.0.0.1:5173
```

在管理后台完成初始化，创建隧道与路由（路由的「专属域名」填 `项目名.localhost`），
然后在内网机器上运行主机端：

```bash
pnpm dev:agent --server http://127.0.0.1:8787 --token <接入令牌> --ports 8080
```

本地开发期前后端是两个端口（5173 / 8787），管理后台通过 Vite 代理访问 API。
**部署到 Workers 之后两者同源，不再需要代理与 CORS。**

---

## 部署到 Cloudflare Workers

完整步骤见 [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md)，要点如下。

### 一次性准备

```bash
# 1. 创建 D1，把输出的 database_id 填进 apps/worker/wrangler.jsonc
pnpm --filter @nodetunnel/worker exec wrangler d1 create nodetunnel

# 2. 设置会话密钥
pnpm --filter @nodetunnel/worker exec wrangler secret put ADMIN_SESSION_SECRET

# 3. 应用迁移
pnpm db:migrate:remote
```

`database_id` 不是密钥，可以提交到仓库 —— 这正是「导入仓库一键部署」能成立的前提。

### 从 GitHub 导入部署（Workers Builds）

Cloudflare Dashboard → **Workers & Pages** → **Create application**
→ **Import a repository** → 选中本仓库，填：

| 设置项             | 值                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------- |
| **Root directory** | `apps/worker`                                                                             |
| **Build command**  | `pnpm --filter @nodetunnel/admin build`                                                   |
| **Deploy command** | `pnpm exec wrangler d1 migrations apply nodetunnel --remote && pnpm exec wrangler deploy` |

依赖关系由 Workers Builds 自动安装（检测到 `pnpm-lock.yaml` 会执行 `pnpm install`，
pnpm 会向上找到 workspace 根）。之后每次 push 自动构建并部署。

> Worker 名字必须是 `nodetunnel`，与 `apps/worker/wrangler.jsonc` 里的 `name` 一致。

### 绑定域名

- **管理后台**：给 Worker 加一个 Custom Domain，例如 `tunnel.example.com`。
- **隧道域名**：加一条通配 Route `*.example.com/*`，
  并确认 DNS 有一条**代理已开启**的 `*` 通配记录（A `192.0.2.1` / AAAA `100::`）。

配好之后：绑定了路由的域名走对应应用，其余一切域名都打开管理后台。
新增隧道域名时**不需要再动 DNS 与控制台**，只要在管理后台填好专属域名即可。

---

## 本地命令

```bash
pnpm check              # format:check + lint + typecheck + test（提交前必须通过）
pnpm build              # turbo 构建
pnpm deploy             # 构建并部署 Worker
pnpm db:migrate:local   # 本地 D1 迁移
node scripts/e2e-check.mjs   # 端到端验证（需先启动 Worker 与目标服务）
```

---

## 结构

```
apps/worker    中心服务（Cloudflare Worker）：信令房间 DO、中继转发、管理 API
apps/admin     管理后台（Vue 3 + Vite + Ant Design Vue）
apps/portal    浏览器门户（WebRTC P2P 优先，失败回落中继）
apps/agent     主机端桥接（Node）：连出到 Worker，转发到本机端口
packages/shared 领域类型、校验、常量、信令协议、端口策略
```

分层约束（由 ESLint 强制）：接入层 → 业务层 → 基础层。
详细的工程约定、测试要求与已知限制见 [AGENTS.md](AGENTS.md)。

---

## 安全边界

- 端口白名单在 Worker 与 agent **各自独立校验一次**（agent 才是真正能连到本机端口的一方）；
- 目标地址只允许回环与 RFC1918 私有网段；
- 未指定 `--ports` 时白名单为空，**拒绝一切端口**；
- 接入令牌服务端随机生成，库里只存 SHA-256 摘要，明文仅返回一次。

---

## 许可

MIT
