# NodeTunnel

把内网服务暴露到公网的自托管内网穿透工具。跑在 Cloudflare Workers 上，**不需要服务器、不需要公网 IP、不需要开放路由器端口**。

核心思路：内网机器上的 agent **主动向外连接** Worker，因此内网侧不需要任何入站能力。

---

## 它是怎么工作的

```
浏览器 ──► Worker（按域名分流）──► 内网 agent ──► 你的服务
             │
             ├─ 域名绑定了路由  → 转发到对应内网服务
             └─ 域名没绑路由    → 打开管理后台
```

**每条隧道一个完整域名**，例如 `project1.example.com` 直接打开内网的 8080 端口服务。
用域名而不是路径前缀，是因为应用发出的绝对路径（`/js/app.js`、`/api/xxx`）**不需要任何改写**——这是本工具不做路径重写的原因。

---

## 你需要准备什么

- 一个 Cloudflare 账号（免费额度够用）
- Node.js ≥ 20 与 pnpm
- （可选）一个托管在 Cloudflare 的域名

---

## 三个端，分别怎么搞

| 端           | 是什么              | 跑在哪里                      |
| ------------ | ------------------- | ----------------------------- |
| **Worker**   | 中心服务 + 管理后台 | Cloudflare（部署一次）        |
| **agent**    | 主机端桥接          | 你的内网机器（常驻）          |
| **管理后台** | 网页控制台          | 已打包进 Worker，不用单独部署 |

---

## 一、部署 Worker（中心服务）

### 方式 A：从 GitHub 一键导入（推荐）

1. Fork 或直接用本仓库，推送到你的 GitHub
2. Cloudflare Dashboard → **Workers & Pages** → **Create application** → **Import a repository**
3. 构建设置按下表填：

| 设置项             | 值                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------- |
| **Root directory** | `apps/worker`                                                                             |
| **Build command**  | `pnpm --filter @nodetunnel/admin build`                                                   |
| **Deploy command** | `pnpm exec wrangler d1 migrations apply nodetunnel --remote && pnpm exec wrangler deploy` |

> Worker 名字必须是 `nodetunnel`，与 `apps/worker/wrangler.jsonc` 里的 `name` 一致。
> 依赖由 Workers Builds 自动安装（识别到 `pnpm-lock.yaml` 会跑 `pnpm install`）。

### 方式 B：本地命令行部署

```bash
git clone <你的仓库> && cd nodetunnel
pnpm install

# 1. 创建 D1 数据库，把输出的 database_id 填进 apps/worker/wrangler.jsonc
pnpm --filter @nodetunnel/worker exec wrangler d1 create nodetunnel

# 2. 设置会话密钥（随机生成至少 32 字节）
pnpm --filter @nodetunnel/worker exec wrangler secret put ADMIN_SESSION_SECRET

# 3. 应用数据库迁移
pnpm db:migrate:remote

# 4. 部署
pnpm deploy
```

### 首次访问：设置管理员

部署完成后打开你的 Worker 域名（如 `https://nodetunnel.xxx.workers.dev`）。

**系统没有默认密码。** 第一次访问会自动跳到初始化页面，让你自己设置管理员用户名和密码。设置完成后即可登录。

> 初始化只能进行一次，之后无法再通过该入口创建管理员。

---

## 二、配置隧道（管理后台网页）

1. **隧道管理** → 新建隧道
   - 填名称
   - **端口白名单**：填你允许暴露的本机端口（可填多个）
2. **路由管理** → 新建路由
   - 选刚建的隧道
   - 目标主机 `127.0.0.1`，目标端口填你的服务端口
   - **专属域名**：填完整域名，如 `project1.example.com`
3. 在隧道详情里**复制接入令牌**（明文只显示一次，请保存好）

---

## 三、启动主机端 agent（内网机器）

先确保要暴露的服务已在运行，然后：

```bash
git clone <你的仓库> && cd nodetunnel
pnpm install
pnpm --filter @nodetunnel/agent build

node apps/agent/dist/agent.mjs \
  --server https://nodetunnel.xxx.workers.dev \
  --token <接入令牌> \
  --ports 8080
```

### 参数说明

| 参数       | 必填 | 说明                                                 |
| ---------- | ---- | ---------------------------------------------------- |
| `--server` | ✅   | Worker 地址，用 **https**；agent 内部会转成 `wss://` |
| `--token`  | ✅   | 管理后台复制的接入令牌                               |
| `--ports`  | ✅   | 允许放行的本机端口，逗号分隔，如 `3000,8080`         |
| `--p2p`    | ❌   | 是否尝试 P2P 直连，默认开启；失败自动回落到中继      |

也可以用环境变量代替：`NT_SERVER` / `NT_TOKEN` / `NT_PORTS` / `NT_P2P`。

### ⚠️ 两道端口白名单都要放行

这是**故意设计**的两道独立防线：

| 防线      | 配置位置                  | 不放行的后果    |
| --------- | ------------------------- | --------------- |
| Worker 侧 | 管理界面 → 隧道端口白名单 | 请求被拒（403） |
| agent 侧  | 启动命令 `--ports`        | 请求被拒（502） |

**两边都放行才能通。** 因为 agent 才是真正能连到你本机端口的一方——如果只在服务端校验，一旦 Worker 校验被绕过或出现不经过 Worker 的路径（P2P 直连就是），攻击面就直接落到你内网。

> `--ports` 留空时 agent 会明确警告「未放行任何端口」，这是默认拒绝的设计，不是故障。
> 建议 `--ports` 一次给出可能用到的端口，之后在管理界面改路由目标端口**无需重启 agent**。

---

## 四、绑定域名（让专属域名生效）

默认只有 `*.workers.dev` 能访问。要让 `project1.example.com` 这类专属域名生效：

1. **管理后台入口**：Workers & Pages → `nodetunnel` → **Settings → Domains & Routes** → 加 Custom Domain（如 `tunnel.example.com`）
2. **隧道域名**：加一条通配 Route `*.example.com/*`
3. **DNS**：确认有一条**代理已开启**（橙色云朵）的通配记录

| 类型 | 名称 | 内容        | 代理 |
| ---- | ---- | ----------- | ---- |
| A    | `*`  | `192.0.2.1` | ✅   |
| AAAA | `*`  | `100::`     | ✅   |

配好之后：绑定了路由的域名走对应内网服务，**其余所有域名都打开管理后台**。新增隧道域名时不用再动 DNS。

> `*.example.com` 不匹配裸域。想让裸域也打开后台，再单独加一条 `example.com/*` 路由。

---

## 本地开发

```bash
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # 填入 ADMIN_SESSION_SECRET
pnpm db:migrate:local

pnpm dev:worker   # Worker        → http://127.0.0.1:8787
pnpm dev:admin    # 管理后台      → http://127.0.0.1:5173
pnpm dev:portal   # 浏览器门户    → http://127.0.0.1:5174
```

本地调试时，路由的专属域名填 `xxx.localhost`（`*.localhost` 自动指向 127.0.0.1，无需配 DNS）。

> 开发期前后端分属两个端口，管理后台通过 Vite 代理访问 API。
> **部署后两者同源**，不需要代理与 CORS。

---

## 常用命令

```bash
pnpm check                     # 质量门禁：格式 + lint + 类型 + 测试
pnpm build                     # 构建全部产物
pnpm deploy                    # 构建并部署 Worker
pnpm db:migrate:local          # 本地 D1 迁移
pnpm db:migrate:remote         # 线上 D1 迁移
node scripts/e2e-check.mjs     # 端到端验证（需先启动 Worker）
```

---

## 安全边界

- **端口白名单双校验**：Worker 与 agent 各自独立执行一次，缺一不可
- **目标地址限制**：只允许回环地址与 RFC1918 私有网段，防止被滥用为开放代理
- **默认拒绝**：`--ports` 留空即拒绝一切
- **接入令牌**：服务端随机生成，数据库只存 SHA-256 摘要，明文仅显示一次
- **无默认密码**：管理员凭据由首次访问者自行设置

---

## 已知限制

- **仅支持 HTTP**：浏览器无法在隧道内终止 TLS，被暴露的服务必须是 HTTP 明文服务。
  公网侧（浏览器 ↔ Worker）由 Cloudflare 自动加密，不受此限制。
- **P2P 打洞成功率低**：多数家庭/办公网络是对称 NAT，实际以中继转发为主。
  两条路径对上层等价，不影响可用性。
- UDP 白名单暂无实际作用（数据面只走 HTTP）。

---

## 结构

```
apps/worker    中心服务（Worker）：信令房间、中继转发、管理 API、管理后台静态资源
apps/admin     管理后台（Vue 3 + Vite + Ant Design Vue）
apps/agent     主机端桥接（Node）
apps/portal    浏览器门户（WebRTC P2P 优先，回落中继）
packages/shared 领域类型、校验、协议、端口策略
docs/          部署与架构文档
```

工程约定、分层约束与测试要求见 [AGENTS.md](AGENTS.md)。

---

## 许可

MIT
