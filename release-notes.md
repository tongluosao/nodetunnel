## NodeTunnel v0.1.0

用 **Cloudflare Worker 当隧道入口**的内网穿透工具。把内网的 HTTP 服务暴露到公网，
不需要服务器、公网 IP，也不需要开放路由器端口。

首个正式发布版本。

### 为什么要做这个

Cloudflare Tunnel 用 anycast 回源，其回源域名 `region1.v2.argotunnel.com` 和
`region2.v2.argotunnel.com` **分别只能解析到 `198.41.192.0/24` 和 `198.41.200.0/24`**，
在国内通常落到 **LAX / SEA 等美西节点** —— 延迟高、丢包率高，且 anycast 路由
由运营商决定，**基本无法优选**。

改用 Worker 当入口后：

- **回源可以优选**：走域名的正常解析路径，不用优选也往往比固定美西节点快得多
- **可接国内节点加速**：域名有备案的话可前置 EO / ESA
- **部署简单**：内网机器不需要复杂的隧道 daemon 配置

**代价**：Worker 只处理 HTTP，**无法建立通用 TCP/UDP 隧道**。
适合 Web 服务、API、管理后台；不适合 SSH、RDP、数据库直连等裸 TCP/UDP 场景。

### 下载主机端

**推荐**：直接下载对应平台的预编译二进制，**不需要安装 Node 或 npm**
（已内置运行时与全部依赖）。

| 平台 | 文件 | 大小 |
|---|---|---|
| Windows x64 | `nodetunnel-agent-win-x64.zip` | 30.9 MB |
| Windows ARM64 | `nodetunnel-agent-win-arm64.zip` | 26.8 MB |
| Linux x64 | `nodetunnel-agent-linux-x64.tar.gz` | 40.2 MB |
| Linux ARM64 | `nodetunnel-agent-linux-arm64.tar.gz` | 40.1 MB |

```bash
# Windows
nodetunnel-agent-win-x64.exe --server https://<Worker域名> --token <令牌> --ports 8080

# Linux
chmod +x nodetunnel-agent-linux-x64
./nodetunnel-agent-linux-x64 --server https://<Worker域名> --token <令牌> --ports 8080
```

**没有 32 位（x86）版本**：Node 官方早已停止发布 linux-x86 / win-x86 构建，
单文件可执行方案（Node SEA）拿不到载体二进制，技术上无法交付。
32 位环境请用源码运行。

### 实现要点

- **专属域名路由**：每条隧道一个完整域名，应用发出的绝对路径无需改写
  （路径前缀方案需重写 HTML/JS/CSS 里所有绝对路径，复杂应用几乎必然遗漏）
- **P2P 尝试 + 中继回落**：经 Worker 上的信令房间（Durable Object）交换
  SDP/ICE，浏览器原生 ICE 打洞；失败回落 Worker 中继。
  不自行实现打洞、不部署 TURN（回落路径本身就是中继）。
  STUN 只用国内服务器（国外 STUN 在国内常被劫持/接管，只会拖慢协商）。
- **中继是常态路径，不是异常兜底**：实测多数网络为对称 NAT，打洞成功率低。
  P2P 与中继对上层完全等价，走哪条不影响功能，只影响延迟。
- **两道端口白名单**：Worker 与 agent 各校验一次，缺一不可。
  agent 才是真正能连到本机端口的一方。
- **管理后台由 Worker 自身提供静态资源**，与 `/api/v1` 同源，无需代理与 CORS
- **数据库异常时 fail-closed**：D1 故障不再让整站 500，管理后台与登录保持可用
  以便排查，隧道流量期间不放行
- **无默认密码**：管理员凭据由首次访问者自行设置，初始化只能进行一次

### 快速开始

**1. 部署 Worker**（Cloudflare Dashboard → Workers & Pages → Create application
→ Import a repository）

| 设置项 | 值 |
|---|---|
| Root directory | `apps/worker` |
| Build command | `pnpm --filter @nodetunnel/admin build` |
| Deploy command | `pnpm exec wrangler d1 migrations apply nodetunnel --remote && pnpm exec wrangler deploy` |

部署后打开 Worker 域名，首次访问会引导设置管理员用户名和密码。

**2. 管理后台配置**：新建隧道（填端口白名单）→ 新建路由（选隧道、目标
`127.0.0.1:<端口>`、填专属域名）→ 复制接入令牌。

**3. 内网机器启动 agent**：见上方下载说明，`--ports` 必填。

### 已知限制

- 仅支持 HTTP，无法做通用 TCP/UDP 隧道
- P2P 打洞成功率低，实际以中继为主，不影响可用性
- 二进制体积 26–40 MB（单文件可执行需内置 Node 运行时）
- UDP 白名单暂无实际作用（数据面只走 HTTP）

### 从源码运行

```bash
git clone https://github.com/tongluosao/nodetunnel.git && cd nodetunnel
pnpm install
pnpm --filter @nodetunnel/agent build
node apps/agent/dist/agent.mjs --server <地址> --token <令牌> --ports 8080
```

完整文档：<https://github.com/tongluosao/nodetunnel#readme>
