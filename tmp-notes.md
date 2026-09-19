## NodeTunnel v0.1.0

把内网服务暴露到公网的自托管内网穿透工具。跑在 Cloudflare Workers 上，不需要服务器、公网 IP 或开放路由器端口。

首个正式发布版本。

### 下载主机端

**推荐**：直接下载对应平台的预编译二进制，**不需要安装 Node 或 npm**（已内置运行时与全部依赖）。

| 平台          | 文件                                  | 大小  |
| ------------- | ------------------------------------- | ----- |
| Windows x64   | `nodetunnel-agent-win-x64.zip`        | 30 MB |
| Windows ARM64 | `nodetunnel-agent-win-arm64.zip`      | 26 MB |
| Linux x64     | `nodetunnel-agent-linux-x64.tar.gz`   | 40 MB |
| Linux ARM64   | `nodetunnel-agent-linux-arm64.tar.gz` | 40 MB |

解压即用：

```bash
# Windows
nodetunnel-agent-win-x64.exe --server https://<Worker 域名> --token <接入令牌> --ports 8080

# Linux
chmod +x nodetunnel-agent-linux-x64
./nodetunnel-agent-linux-x64 --server https://<Worker 域名> --token <接入令牌> --ports 8080
```

**没有 32 位（x86）版本**：Node 官方早已停止发布 linux-x86 / win-x86 构建，单文件可执行方案（Node SEA）拿不到载体二进制，技术上无法交付。32 位环境请改用源码运行（见下）。

### 快速开始

**1. 部署 Worker（只需一次）**

Cloudflare Dashboard → Workers & Pages → Create application → Import a repository

| 设置项         | 值                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------- |
| Root directory | `apps/worker`                                                                             |
| Build command  | `pnpm --filter @nodetunnel/admin build`                                                   |
| Deploy command | `pnpm exec wrangler d1 migrations apply nodetunnel --remote && pnpm exec wrangler deploy` |

部署后打开 Worker 域名，**系统没有默认密码**，首次访问会引导你设置管理员用户名和密码。

**2. 管理后台配置隧道**

新建隧道（填端口白名单）→ 新建路由（选隧道、目标 `127.0.0.1:<端口>`、填专属域名）→ 复制接入令牌。

**3. 内网机器启动 agent**

见上方下载说明。注意 `--ports` 是必填的。

### ⚠️ 两道端口白名单都要放行

这是**故意设计**的双防线，两边都放行才能通：

| 防线      | 配置位置                  | 不放行的后果 |
| --------- | ------------------------- | ------------ |
| Worker 侧 | 管理界面 → 隧道端口白名单 | 403          |
| agent 侧  | 启动命令 `--ports`        | 502          |

因为 agent 才是真正能连到你本机端口的一方——只在服务端校验的话，一旦 Worker 校验被绕过或出现不经过 Worker 的路径（P2P 直连就是），攻击面就直接落到内网。

### 本版要点

- **管理后台由 Worker 自身提供静态资源**，与 `/api/v1` 同源，不需要代理与 CORS
- **专属域名路由**：每条隧道一个完整域名，应用发出的绝对路径无需改写（`/t/<slug>/` 前缀入口已移除）
- **数据库异常时 fail-closed**：D1 查询失败不再让整站 500，管理后台与登录保持可用以便排查，隧道流量期间不放行
- **无默认密码**：管理员凭据由首次访问者自行设置，初始化只能进行一次
- **深浅色主题**切换；管理员用户名可改；修改密码无需验证当前密码
- 修复 PBKDF2 迭代次数超过 Workers 运行时上限（100000）导致线上无法初始化的问题

### 已知限制

- 仅支持 HTTP：被暴露的服务必须是 HTTP 明文服务（公网侧由 Cloudflare 自动加密）
- P2P 打洞成功率低，实际以中继转发为主，不影响可用性
- UDP 白名单暂无实际作用（数据面只走 HTTP）
- 二进制体积较大（26–40 MB），因单文件可执行需内置整个 Node 运行时

### 从源码运行

```bash
git clone https://github.com/tongluosao/nodetunnel.git && cd nodetunnel
pnpm install
pnpm --filter @nodetunnel/agent build
node apps/agent/dist/agent.mjs --server <地址> --token <令牌> --ports 8080
```

完整文档：<https://github.com/tongluosao/nodetunnel#readme>
