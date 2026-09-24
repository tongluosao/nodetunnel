# NodeTunnel

用 **Cloudflare Worker 当隧道入口**的内网穿透工具。

把内网里的 HTTP 服务暴露到公网，不需要服务器、公网 IP，也不需要开放路由器端口。

---

## 为什么要做这个

### Cloudflare Tunnel 的回源问题

Cloudflare Tunnel 用 anycast 做回源。它的回源域名 `region1.v2.argotunnel.com` 和
`region2.v2.argotunnel.com` **分别只能解析到 `198.41.192.0/24` 和 `198.41.200.0/24`**
这两个段里的地址。

而这两个段对应的接入点，在国内网络环境下通常落在 **LAX（洛杉矶）或 SEA（西雅图）**
等美西节点 —— 延迟高、丢包率高，而且 **anycast 的路由由运营商决定，基本无法优选**。

家里带宽再好、本地网络再快，流量也得先绕去美国西海岸再回来。

### 用 Worker 当入口的好处

把隧道入口换成 Cloudflare Worker 后：

- **回源可以优选**。Worker 跑在 Cloudflare 全球边缘节点上，回源走的是你域名的
  正常解析路径，该优选就优选，不用优选也往往比固定美西节点快得多。
- **可以接国内节点加速**。域名有备案的话可以前置 EO（Edge One）或 ESA，
  用国内节点加速，进一步缩短链路。
- **部署简单**。内网机器不需要复杂的隧道 daemon 配置，Worker 侧一次部署即可。

### 代价：只支持 HTTP

Worker 只处理 HTTP 请求，**无法建立通用的 TCP / UDP 隧道**。

所以本工具适合暴露 Web 服务、API、管理后台这类 HTTP 服务；不适合 SSH、
RDP、游戏服务器、数据库直连这类需要裸 TCP/UDP 的场景。

> 这里说的是**隧道内**只传输 HTTP。公网这一段（浏览器 ↔ Worker）
> 由 Cloudflare 自动提供 HTTPS，不受影响。

---

## 它是怎么工作的

### 整体链路

```
浏览器 ──HTTPS──▶ Worker（边缘节点，按域名分流）
                    │
                    ├── 打洞成功 ──▶ WebRTC DataChannel 直连 ──┐
                    │                                          ▼
                    └── 打洞失败 ──▶ 经 Worker 中继 ───────▶ 内网 agent ──HTTP──▶ 你的服务
```

内网机器上的 agent **主动向外连接** Worker，因此内网侧不需要任何入站能力，
也不用开路由器端口。

### 每条隧道一个完整域名

`project1.example.com` 直接打开内网的 8080 端口服务。

用**专属域名**而不是路径前缀（比如 `example.com/t/project1/`），是因为应用发出的
绝对路径（`/js/app.js`、`/api/xxx`）**不需要任何改写**。路径前缀方案要重写
HTML/JS/CSS 里所有绝对路径，对复杂应用几乎必然遗漏。

本地调试可以用 `xxx.localhost`（`*.localhost` 自动指向 127.0.0.1，不用配 DNS）。

### P2P 尝试与中继回落

访客进入时，浏览器会尝试与 agent 建立 **WebRTC DataChannel 直连**：

1. 双方经 Worker 上的**信令房间**（Durable Object）交换 SDP 与 ICE 候选；
2. 浏览器原生 ICE 自行完成打洞；
3. **成功** → 数据走 P2P 直连，不经过 Worker 转发；
4. **失败** → 回落到 Worker 中继。

**关于 P2P 的现实预期（重要）**：

**中继是常态路径，不是异常兜底。** 实测多数家庭/办公网络是对称 NAT
（单一出口 IP、端口随目标变化），对端无法预测本端映射端口，打洞成功率很低。

架构上 P2P 与中继**对上层完全等价**（同一个 `TunnelTransport` 抽象的两个实现），
走哪条不影响功能，只影响延迟。所以打洞没成功**不代表系统有问题**。

几点技术细节：

- **不自行实现打洞**，直接用浏览器原生 ICE。WebRTC 的 ICE 已是工业级实现；
  而 EasyTier 那套端口预测/扫描策略依赖「绑定多个 UDP socket、控制源端口」，
  浏览器一个都不提供，无法迁移也没必要迁移。
- **不部署 TURN**。打洞失败就走中继 —— 回落路径本身就是中继，
  再引入 TURN 是重复建设。
- **STUN 只用国内服务器**（`stun.miwifi.com` 等）。实测
  `stun.l.google.com:19302` 在国内常被 DNS 劫持或代理 TUN 接管，
  配上只会拖慢协商。
- 主机端 WebRTC 用 **werift**（纯 TypeScript，零原生依赖）而非
  `node-datachannel`（需编译原生模块）—— 这样「下载二进制直接跑」才成立。

### 安全：两道独立防线

端口白名单在 **Worker 和 agent 各校验一次**，缺一不可：

| 防线      | 配置位置                  | 不放行的后果 |
| --------- | ------------------------- | ------------ |
| Worker 侧 | 管理界面 → 隧道端口白名单 | 403          |
| agent 侧  | 启动命令 `--ports`        | 502          |

为什么要重复判断：agent 才是真正持有「能否连到本机某个端口」这一能力的一方。
如果只在服务端校验，一旦 Worker 校验被绕过、或出现不经过 Worker 的入站路径
（P2P 直连就是一条），攻击面就直接落到内网。

---

## 快速开始

### 一、部署 Worker（中心服务）

**方式 A：从 GitHub 导入（推荐）**

Cloudflare Dashboard → **Workers & Pages** → **Create application**
→ **Import a repository**，构建设置按下表填：

| 设置项             | 值                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------- |
| **Root directory** | `apps/worker`                                                                             |
| **Build command**  | `pnpm --filter @nodetunnel/admin build`                                                   |
| **Deploy command** | `pnpm exec wrangler d1 migrations apply nodetunnel --remote && pnpm exec wrangler deploy` |

> Worker 名字必须是 `nodetunnel`，与 `apps/worker/wrangler.jsonc` 里的 `name` 一致。

**方式 B：本地命令行部署**

```bash
git clone https://github.com/tongluosao/nodetunnel.git && cd nodetunnel
pnpm install

# 1. 创建 D1，把输出的 database_id 填进 apps/worker/wrangler.jsonc
pnpm --filter @nodetunnel/worker exec wrangler d1 create nodetunnel

# 2. 设置会话密钥（随机至少 32 字节）
pnpm --filter @nodetunnel/worker exec wrangler secret put ADMIN_SESSION_SECRET

# 3. 应用数据库迁移
pnpm db:migrate:remote

# 4. 部署
pnpm deploy
```

**首次访问**：打开 Worker 域名，**系统没有默认密码**，会自动引导你设置管理员
用户名和密码。初始化只能进行一次。

### 二、管理后台配置隧道

1. **隧道管理** → 新建隧道，填**端口白名单**（可多个）
2. **路由管理** → 新建路由：选隧道、目标 `127.0.0.1`、目标端口、**专属域名**
3. 隧道详情里**复制接入令牌**（明文只显示一次）

### 三、内网机器启动 agent

**方式 A：下载预编译二进制（推荐，无需 Node）**

从 [Releases](https://github.com/tongluosao/nodetunnel/releases) 下载对应平台包：

| 平台          | 文件                                  |
| ------------- | ------------------------------------- |
| Windows x64   | `nodetunnel-agent-win-x64.zip`        |
| Windows ARM64 | `nodetunnel-agent-win-arm64.zip`      |
| Linux x64     | `nodetunnel-agent-linux-x64.tar.gz`   |
| Linux ARM64   | `nodetunnel-agent-linux-arm64.tar.gz` |

```bash
# Windows
nodetunnel-agent-win-x64.exe --server https://<Worker域名> --token <令牌> --ports 8080

# Linux
chmod +x nodetunnel-agent-linux-x64
./nodetunnel-agent-linux-x64 --server https://<Worker域名> --token <令牌> --ports 8080
```

已内置 Node 运行时与全部依赖，**不需要装 Node**（体积 26–40 MB，
因为单文件可执行需内置整个运行时）。

> 无 32 位（x86）版本：Node 官方早已停止发布 linux-x86 / win-x86 构建，
> 单文件可执行方案拿不到载体二进制。32 位环境请用方式 B。

**方式 B：从源码运行（需 Node ≥ 20）**

```bash
pnpm install
pnpm --filter @nodetunnel/agent build
node apps/agent/dist/agent.mjs --server https://<Worker域名> --token <令牌> --ports 8080
```

**参数**

| 参数       | 必填 | 说明                                              |
| ---------- | ---- | ------------------------------------------------- |
| `--server` | ✅   | Worker 地址，用 **https**（内部自动转 `wss://`）  |
| `--token`  | ✅   | 管理后台复制的接入令牌                            |
| `--ports`  | ✅   | 放行端口，逗号分隔，如 `3000,8080`；留空=拒绝一切 |
| `--p2p`    | ❌   | 是否尝试 P2P，默认开启；失败自动回落中继          |

也可用环境变量：`NT_SERVER` / `NT_TOKEN` / `NT_PORTS` / `NT_P2P`。

### 四、绑定域名

默认只有 `*.workers.dev` 可访问。要让专属域名生效：

1. **管理后台入口**：Worker → **Settings → Domains & Routes** → 加 Custom Domain
2. **隧道域名**：加通配 Route `*.example.com/*`
3. **DNS**：确认有**代理已开启**（橙色云朵）的通配记录

| 类型 | 名称 | 内容        | 代理 |
| ---- | ---- | ----------- | ---- |
| A    | `*`  | `192.0.2.1` | ✅   |
| AAAA | `*`  | `100::`     | ✅   |

配好后：绑定路由的域名走内网服务，**其余所有域名都打开管理后台**。
新增隧道域名时不用再动 DNS。

> `*.example.com` 不匹配裸域，想让裸域也打开后台需另加 `example.com/*` 路由。

---

## 本地开发

```bash
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # 填 ADMIN_SESSION_SECRET
pnpm db:migrate:local

pnpm dev:worker   # Worker     → http://127.0.0.1:8787
pnpm dev:admin    # 管理后台   → http://127.0.0.1:5173
pnpm dev:portal   # 浏览器门户 → http://127.0.0.1:5174
node scripts/e2e-check.mjs   # 端到端验证
```

> 开发期前后端分属两个端口，管理后台通过 Vite 代理访问 API。
> **部署后两者同源**，不需要代理与 CORS。

工程约定、分层约束与测试要求见 [AGENTS.md](AGENTS.md)；
WebRTC 方案定型的完整调研过程见
[docs/webrtc-p2p-status.md](docs/webrtc-p2p-status.md)。

---

## 结构

```
apps/worker    中心服务：信令房间 DO、中继转发、管理 API、管理后台静态资源
apps/admin     管理后台（Vue 3 + Vite + Ant Design Vue）
apps/agent     主机端桥接（Node + werift）
apps/portal    浏览器门户（WebRTC P2P 优先，回落中继）
packages/shared 领域类型、校验、信令协议、端口策略
docs/          部署与架构文档
```

---

## 已知限制

- **仅支持 HTTP**：无法做通用 TCP/UDP 隧道（见开头）
- **P2P 打洞成功率低**：实际以中继为主，不影响可用性
- **二进制体积偏大**（26–40 MB）：单文件可执行需内置 Node 运行时
