# AGENTS.md

本文件是本仓库的工程约定与操作手册，面向在本仓库中工作的自动化代理与人类开发者。

---

## 1. 身份

NodeTunnel 是一个部署在 Cloudflare Workers 上的自托管内网穿透系统。

它做三件事：

1. **信令与中继**：一个 Durable Object 按隧道分房间，把浏览器访客与主机端
   agent 配对。房间负责转发 WebRTC 信令（SDP / ICE 候选），并在打洞失败时
   转发中继帧。
2. **隧道编排**：以 `tunnel` 为中心管理接入令牌与端口白名单，并把
   **专属域名**上的 HTTP 请求经房间转发到主机端被放行的服务。
   路由表里填的是完整域名（如 `project1.example.com`），
   应用跑在根路径上，因此应用发出的绝对路径不需要任何改写。
   本地开发期有一条快捷约定：`<slug>.localhost` 自动指向同名路由。
3. **主机端接入**：用户在自己内网机器上运行 `nodetunnel-agent`，用接入令牌
   连出到 Worker。它主动连出，因此内网机器**不需要任何公网入口**。

浏览器门户用原生 WebRTC 尝试与 agent 直连（P2P），失败则回落到中继。

中心服务、管理后台、浏览器门户全部运行在 Cloudflare Worker 与静态托管之上，
不依赖任何常驻服务器。**仅支持 HTTP**：浏览器无法在隧道内终止 TLS，
因此被暴露的服务必须是 HTTP 明文服务。

角色定位：这是一个**工程实现型**仓库。判断改动是否合理的第一标准是
「能否跑通并被验证」，而不是「设计是否优雅」。

### 关于 P2P 的现实预期

**中继是常态路径，不是异常兜底。** 实测本机所处网络为对称 NAT
（单一出口 IP、端口随目标变化），对端无法预测本端映射端口，打洞成功率低。
架构上 P2P 与中继对上层完全等价，因此这**不影响系统可用**，
但不要因为「打洞没成功」就认为系统有 bug —— 请先确认中继路径本身是否正常。

---

## 2. 命令

以下命令均已在本仓库验证可执行。工作目录均为仓库根目录。

### 安装与启动

```bash
pnpm install                 # 安装依赖（Node >= 20，pnpm 11.22.0）
pnpm dev:worker              # 启动 Worker，监听 127.0.0.1:8787
pnpm dev:admin               # 启动管理后台，监听 127.0.0.1:5173，/api 代理到 8787
pnpm dev:portal              # 启动浏览器门户，监听 127.0.0.1:5174
pnpm dev:agent --server http://127.0.0.1:8787 --token <令牌> --ports 8080
```

首次启动 Worker 前需要创建本地密钥文件 `apps/worker/.dev.vars`（已被 gitignore 排除）：

```
ADMIN_SESSION_SECRET=<至少 32 字节的随机字符串>
NT_ADMIN_ORIGIN=http://127.0.0.1:5173
```

只有 `ADMIN_SESSION_SECRET` 是必需的。**不再有 `NT_MASTER_KEY`** ——
接入令牌由服务端随机生成，库里只存 SHA-256 摘要，没有需要加密的长期密钥。

### 数据库

```bash
pnpm db:migrate:local        # 应用迁移到本地 D1
pnpm db:migrate:remote       # 应用迁移到远端 D1
```

迁移文件内容一旦改动，本地 D1 里已记录的同名迁移**不会重新执行**。
改了 `0001_init.sql` 之后必须删掉 `apps/worker/.wrangler/state` 再重新应用，
否则本地库仍是旧表结构，表现为「代码没问题但查询报 no such column」。

### 质量检查

```bash
pnpm check                   # 依次执行 format:check、lint、typecheck、test
pnpm format                  # 用 Prettier 格式化
pnpm lint                    # ESLint（包含三层边界规则）
pnpm typecheck               # 全部工作区类型检查
pnpm test                    # 全部工作区测试
```

**提交前必须执行 `pnpm check` 并通过。** 该命令必须全绿，不接受「只有 warning」。

### 构建与部署

```bash
pnpm build                   # turbo 构建全部产物
pnpm deploy                  # 先 pnpm build 再 wrangler deploy（需先填入真实 D1 id）
```

部署形态下管理后台的静态资源由 Worker 自己提供（`apps/worker/wrangler.jsonc`
的 `assets` 指向 `apps/admin/dist`），因此 Worker 自身的域名就是管理后台入口，
前端与 `/api/v1` **同源**，不再需要 CORS 与开发期的 Vite 代理。

完整部署步骤（创建 D1、设置密钥、Workers Builds 从 GitHub 导入、绑定域名）
见 [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md)。

### 验证脚本

```bash
node scripts/test-target-server.mjs   # 在 127.0.0.1:9911 启动一个 HTTP 目标服务
node scripts/e2e-check.mjs            # 端到端验证（需先启动 Worker 与目标服务）
```

`e2e-check.mjs` 是重构后最关键的验收脚本，它会实际创建隧道与路由、拉起
agent、并断言「访客经中继取回本机服务内容」。**改动数据面后必须跑它。**
它不参与构建产物。

---

## 3. 测试

### 测试栈

- Vitest 3，各工作区独立配置（`vitest.config.ts`）。
- 所有测试运行在 `node` 环境，覆盖纯逻辑：端口策略、校验、房间命名、
  分帧、分片、HTTP 报文解析。

### 运行

```bash
pnpm test                                        # 全部
pnpm --filter @nodetunnel/worker test            # 单个工作区
pnpm --filter @nodetunnel/worker test:watch      # 监听模式
```

### 现有覆盖

| 工作区        | 文件                               | 覆盖内容                                     |
| ------------- | ---------------------------------- | -------------------------------------------- |
| `apps/worker` | `test/security-invariants.test.ts` | 端口白名单默认拒绝、协议严格性、地址范围限制 |
| `apps/worker` | `test/signaling-room-name.test.ts` | 隧道 ID 到 Durable Object 名称的映射         |
| `apps/worker` | `test/route-hostname.test.ts`      | 专属域名归一化、按 Host 解析路由、拒绝自锁   |
| `apps/worker` | `test/relay-chunks.test.ts`        | 中继分片累加：首个分片携带响应头（首片优先） |
| `apps/portal` | `test/transport.test.ts`           | 行分帧、分片还原、HTTP 请求构造与响应解析    |
| `apps/agent`  | `test/agent.test.ts`               | 参数解析、WebSocket 地址推导、本地转发白名单 |

### 测试约定

- **安全不变式必须有测试守护。** 「默认拒绝端口」「只连回环地址」
  「拒绝公网目标」这三条一旦被改坏，必须立刻有测试失败。
- 新增解析类逻辑（协议、报文、编码）必须附带畸形输入的报错测试。
- 测试名与断言注释使用中文，说明「这条断言在守护什么」。
- 需要 Workers 运行时的集成测试尚未引入；纯逻辑保持与运行时解耦，便于单独测试。
  数据面的正确性由 `scripts/e2e-check.mjs` 在真实 `wrangler dev` 下验证。

---

## 4. 项目结构

```
nodetunnel/
├── apps/
│   ├── worker/                    # 中心服务（接入层 + 业务层 + 基础层）
│   │   ├── migrations/            # D1 迁移（唯一事实来源）
│   │   ├── src/
│   │   │   ├── index.ts           # 入口：路径分发、异常兜底、DO 导出
│   │   │   ├── home.ts            # /health 与纯文本兜底页
│   │   │   ├── env.d.ts           # Env 接口
│   │   │   ├── admin/             # 业务层：管理 API、认证、SPA 静态资源分发
│   │   │   ├── nodetunnel/        # 业务层：隧道、路由、agent、地址推导、信令接入
│   │   │   ├── http-tunnel/       # 业务层：专属域名的 HTTP 转发
│   │   │   ├── signaling/         # 基础层：信令房间 Durable Object、中继分片累加
│   │   │   ├── db/                # 基础层：D1 访问
│   │   │   └── lib/               # 基础层：错误、日志、加密、会话
│   │   ├── test/
│   │   └── wrangler.jsonc
│   ├── agent/                     # 主机端桥接服务（Node + werift）
│   │   ├── scripts/build.mjs      # esbuild 打包为单文件入口
│   │   └── src/{config,index,local-forward,log,peer,signaling-client}.ts
│   ├── admin/                     # 管理后台（Vue 3 + Vite + Ant Design Vue）
│   │   └── src/{api,layouts,router,stores,styles,views}/
│   └── portal/                    # 浏览器门户（Vue 3 + Vite）
│       ├── src/http/              # HTTP 报文构造与解析
│       ├── src/signaling/         # 信令客户端
│       ├── src/transport/         # P2P 与中继两条传输、行分帧
│       └── src/tunnel-client.ts   # 串起「信令 → P2P → 回落中继 → 发请求」
├── packages/
│   └── shared/                    # 领域类型、校验、常量、信令协议、端口策略（零依赖）
├── scripts/
│   ├── e2e-check.mjs              # 端到端验证
│   ├── test-target-server.mjs     # 测试用 HTTP 目标服务
│   └── poc/                       # 阶段 0 可行性验证（独立依赖，见其 README）
├── docs/
│   ├── deploy-cloudflare.md       # 部署到 Cloudflare Workers（含从 GitHub 导入）
│   └── webrtc-p2p-status.md       # WebRTC 方案定型的调研过程与结论
└── 其他项目代码/                   # 只读参考代码，绝不修改
```

---

## 5. 代码风格

- **语言**：TypeScript strict，ESM，`verbatimModuleSyntax` 开启。类型导入必须写 `import type`。
- **注释与文案**：全部使用中文。注释解释**为什么**这样做（尤其是安全相关的取舍），不重述代码在做什么。
- **命名**：变量与函数用英文，领域概念（隧道、路由、主机端、端口白名单）保持与中文注释一致。
- **格式化**：Prettier 统一处理，不要手工对齐。提交前跑 `pnpm format`。
- **类型**：禁止 `any`（ESLint 报错）。用 `unknown` 加显式收窄。
- **错误处理**：业务错误一律通过 `AppError` + `ErrorCode` 抛出，由顶层统一转换为结构化 JSON。不要在各处自行拼装错误响应。
- **日志**：使用 `src/lib/logger.ts`（Worker）或 `apps/agent/src/log.ts`（agent），两者都会自动脱敏敏感字段。禁止 `console.log` 输出密钥、密码或完整配置。
- **路径别名**：`@/` 指向各应用的 `src/`（仅在 admin 与 portal 中配置）。

### 三层边界

这是本仓库最重要的结构性约束，由 ESLint 的 `no-restricted-imports` 强制。

```
接入层  →  业务层  →  基础层
```

- **接入层**：`apps/worker/src/index.ts`、`apps/admin`、`apps/portal`、`apps/agent`。只做分发与展示，不含业务规则。
- **业务层**：`apps/worker/src/{nodetunnel,admin,http-tunnel}`。编排用例，决定「允许什么、拒绝什么」。
- **基础层**：`apps/worker/src/{db,signaling,lib}`、`packages/**`。提供能力，不认识业务概念。

规则：

1. **基础层不得导入业务层或接入层。** 需要共享的类型下沉到 `packages/shared`。
   这条规则已经抓到过一次真实违规：信令房间最初把「校验接入令牌」写在自己
   内部（属于业务规则），后来拆成 `signaling/room.ts`（纯转发）+
   `nodetunnel/signaling-gateway.ts`（鉴权与路由解析）。
   房间需要的请求头常量下沉到 `signaling/headers.ts`，
   这样业务层不必为了取一个常量去导入 DO 类。
2. **业务层不得从 `cloudflare:workers` 导入 `DurableObject`。** 需要 Durable Object 能力时，通过基础层暴露的接口访问。
3. 出现循环依赖时，说明分层放错了位置，应下沉共享类型而不是绕过规则。

---

## 6. 通信协议

信令与中继共用**一条** WebSocket（agent ↔ Worker），用消息的 `type` 字段区分。
定义在 `packages/shared/src/signaling.ts`，它是唯一的线协议事实来源。

| 类型              | 方向            | 用途                              |
| ----------------- | --------------- | --------------------------------- |
| `hello` / `ready` | agent ↔ Worker  | 接入与接受                        |
| `ping` / `pong`   | 双向            | 保活（Cloudflare 会回收空闲连接） |
| `connect`         | Worker → agent  | 有访客进入房间                    |
| `connected`       | Worker → portal | 会话已建立，可开始交换 SDP        |
| `peer-gone`       | Worker → 任一方 | 对端离开                          |
| `description`     | 双向            | SDP（透传，Worker 不解析）        |
| `candidate`       | 双向            | 单个 ICE 候选（透传）             |
| `relay-request`   | portal → agent  | 经中继发起一次 HTTP 请求          |
| `relay-response`  | agent → portal  | 中继响应，**可能分片**            |
| `relay-abort`     | 双向            | 中止进行中的请求                  |
| `error`           | 双向            | 协议级错误                        |

### 分片

响应体可能远大于单条消息上限，因此按 `RELAY_CHUNK_BYTES`（16 KiB）分片，
最后一片带 `last: true`。P2P 与中继两条路径**共用这套约定**。

SCTP 单条消息的硬上限是 64 KiB，超过会直接抛
`max-message-size exceeded`。16 KiB 留出了充足余量。

### DataChannel 的行分帧

DataChannel 保序，但**不保证「一次 send 对应一次 message」**：
多个逻辑消息可能被合并进一条消息。因此 P2P 路径用换行分帧
（`apps/portal/src/transport/line-framing.ts`），必须能处理任意切分 ——
该模块的测试包含「逐字符喂入」这一用例。

选 JSON + 换行而不是二进制长度头，是为了让两条路径承载**同一种报文**：
主机端只需要一份请求处理逻辑。代价是 base64 约 33% 的体积开销。

---

## 7. 安全模型

### 端口白名单：两道独立防线

这是本项目的核心安全边界，实现在 `packages/shared/src/policy.ts`，
由 Worker 与 agent **各自独立执行一次**：

- Worker 侧：`admin/router.ts` 在**创建路由时**就拒绝非内网目标地址，
  `http-tunnel/proxy.ts` 在转发前再校验端口；
  信令房间也会拦掉访客伪造的 `targetPort`。
- agent 侧：`local-forward.ts` 再校验一次端口白名单，
  并把目标**固定为 `127.0.0.1`**，不采用请求里传来的 host。

为什么要重复判断：agent 才是真正持有「能否连到本机某个端口」这一能力的一方。
如果只有 Worker 判断，一旦 Worker 校验被绕过、或将来出现不经过 Worker 的
入站路径（P2P 直连就是一条），攻击面会直接落到用户内网。

### 目标地址限制

只允许回环地址与 RFC1918 私有网段（`isTargetHostAllowed`）。
**这条必须保持**：允许任意目标会让本系统变成可被滥用的开放代理。

### 接入令牌

- 服务端随机生成，格式 `nt_` + 43 字符。
- 库里只存 SHA-256 摘要与 8 位前缀，**明文仅在创建/轮换时返回一次**。
- 用 `Authorization: Bearer` 头传递，不走查询参数 —— 查询参数会进入
  各级访问日志与浏览器历史。
- 令牌用 SHA-256 而非 PBKDF2：它是 256 位随机值，不存在字典攻击面，
  加盐慢哈希只会给每次连接白白增加开销。

### 默认拒绝

- agent 未指定 `--ports` 时白名单为空，**拒绝一切端口**。
  配置漏填的后果应当是「用不了」，而不是「内网暴露」。
- 未认证访问管理 API 一律 401；主机端离线时中继明确返回 503，不静默降级。

---

## 8. 错误处理

### 统一模型

所有业务错误通过 `AppError`（`src/lib/errors.ts`）抛出，携带 `ErrorCode`
与可选的中文消息、字段名。顶层 `handleTopLevelError` 负责转换：

- `AppError` → 对应 HTTP 状态码 + `{ error: { code, message, details } }`；
- 其他异常 → 记录完整堆栈到日志，但**只向客户端返回通用错误**，避免泄露内部结构。

### 设计规则

- **新增错误码时必须三处同步**：`ErrorCode` 常量对象、`ERROR_STATUS` 状态码映射、面向用户的文案。
- **不要把底层异常直接暴露给客户端。** 数据库或网络错误需要包装成有意义的业务错误。
- **安全相关的失败要 fail-closed。** 校验不通过时拒绝服务，而不是降级放过。
  密钥缺失、白名单未配置、会话无效都属于这一类。
- **前端错误文案来自服务端。** 登录失败不区分「用户不存在」与「密码错误」，
  避免账号枚举；前端也不应自行推断具体原因。

### 可观测性

- 使用 `logger` 的分级方法。`logger.error` 用于需要人工介入的情况，
  `logger.warn` 用于可预期的拒绝。
- 日志字段用英文键名，值可以是中文。敏感字段由 logger 自动脱敏。
- agent 的日志会脱敏 `token` / `authorization` / `secret` / `password` 字段。

---

## 9. 质量检查

### 提交前必须通过

```bash
pnpm check
```

它依次执行四项，**必须全部通过**：

1. `format:check` —— Prettier 格式一致；
2. `lint` —— ESLint 无 error（含三层边界规则）；
3. `typecheck` —— 全部工作区的 `tsc`/`vue-tsc` 无错误；
4. `test` —— 全部测试通过。

### 验证标准

- **不要声称「应该能工作」。** 涉及运行时的改动必须实际请求验证。
- 改动了数据面（信令房间、中继转发、agent 转发）时，必须跑一次
  `node scripts/e2e-check.mjs` 并确认全部断言通过。
- 改动了端口策略或转发目标逻辑时，必须确认 `security-invariants.test.ts` 仍然通过，
  并实测一次非白名单端口确实被拒。
- 构建类改动必须跑一次 `pnpm build`，确认 `wrangler deploy --dry-run` 通过。

### 已知的构建陷阱

- **`apps/agent` 必须打包后运行，不能直接跑 TS 源码。**
  Node 的 `--experimental-strip-types` 只删类型、不重写模块路径，
  不会把 `./types.js` 映射回 `./types.ts`，而 `@nodetunnel/shared`
  按约定直接以 TS 源码被消费、内部使用 `.js` 后缀互相引用。
  直接运行必然 `ERR_MODULE_NOT_FOUND`（已实测确认 Node 无此回退）。
  因此用 esbuild 打成 `dist/agent.mjs`。
- **strip-only 模式不支持参数属性**（`constructor(private readonly x)`）、
  `enum`、`namespace`。agent 源码里构造函数字段一律显式声明。
  打包后其实不再受此限制，但保持显式声明可以让源码在两种运行方式下都成立。
- **Worker 模块的每个具名导出都必须是 handler 或 Durable Object 类。**
  导出普通常量会导致运行时启动失败。
- **DO 类必须从入口文件 `src/index.ts` 导出**，否则 Wrangler 报
  「not exported in your entrypoint」。
- **Durable Object 迁移用 `new_sqlite_classes`**，不能用 `new_classes`。

---

## 10. 当前状态

已完成并经过实测：

- 信令房间 Durable Object（按隧道分房间，支持休眠唤醒）；
- 接入令牌模型（一次性明文、SHA-256 摘要存储、轮换）；
- 管理 API 与安全不变式（二次初始化被拒、未认证被拒、错误密码被拒、
  公网目标地址被拒）；
- 管理后台（初始化、登录、仪表盘、隧道、路由、主机端、设置）；
- 主机端 agent（信令接入、中继转发、P2P answerer、保活与重连）；
- HTTP 隧道转发（专属域名 → 主机端本机服务，已端到端验证；
  `/t/<slug>/` 前缀入口已移除，路径前缀会破坏应用的绝对路径）；
- 浏览器门户（WebRTC P2P 优先，失败回落中继）；
- 管理后台由 Worker 自身提供静态资源（assets 绑定 + `run_worker_first`），
  部署后与 `/api/v1` 同源，其它未绑定路由的域名一律打开管理后台；
- 管理后台深浅色主题切换（CSS 变量 + Ant Design 算法由同一个 `data-theme` 驱动）；
- 管理员用户名可改；修改密码不再需要验证当前密码；
- `scripts/e2e-check.mjs` 27 项断言全部通过。

已知限制：

- 仅支持 HTTP，被暴露的服务必须自行处理 TLS 终止；
- 实测网络为对称 NAT，P2P 打洞成功率低，实际以中继为主（见第 1 节）；
- `DashboardStats.activeConnections` 目前等于 `onlineAgentCount`，
  尚未把各房间的实时连接数汇总上来；
- 管理后台的端口编辑器保留了 tcp/udp 选项，但当前数据面只走 HTTP（即 TCP），
  UDP 白名单暂无实际作用；
- 尚未引入基于 `@cloudflare/vitest-pool-workers` 的 Workers 运行时集成测试。

### 版本历史

- **0.2.0**：移除 EasyTier 与 WASM 内核，改为 WebRTC 信令 + 接入令牌模型。
  原因见 `docs/webrtc-p2p-status.md`：上游 `easytier-js` 的宿主实现里
  7 个 UDP 宿主函数全部返回 `HOST_UNSUPPORTED`，且 `disable_p2p = true`
  对两个 profile 都生效，浏览器侧 P2P 无从实现；同时安全边界依赖内核 ACL，
  内核一旦不再承担数据面，这条边界就消失了。
- **0.1.0**：基于 EasyTier 中转的初版。
