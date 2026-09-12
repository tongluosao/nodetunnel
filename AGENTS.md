# AGENTS.md

本文件是本仓库的工程约定与操作手册，面向在本仓库中工作的自动化代理与人类开发者。

---

## 1. 身份

NodeTunnel 是一个部署在 Cloudflare Workers 上的自托管内网穿透系统。

它做三件事：

1. **EasyTier 中继**：所有 EasyTier 客户端都可把本服务作为初始节点接入，由它中转组网流量。中继逻辑完整复用上游 `easytier-js` 的 `@easytier/cloudflare` 包，不做修改。
2. **隧道编排**：以 `tunnel`（一个 EasyTier 组网）为中心，管理其暴露端口白名单，并把 `/t/<slug>/` 的 HTTP 请求转发到该组网内被放行的服务。端口白名单会被渲染成「默认拒绝入站」的 ACL，未声明的端口一律拒绝。
3. **节点接入**：普通 EasyTier 客户端把配置服务器指向本服务即可接入；浏览器用户也可以通过 WASM 在页面内运行一个 EasyTier 节点，加入同一虚拟局域网。

中心服务、管理后台、浏览器门户全部运行在 Cloudflare Worker 与静态托管之上，不依赖任何常驻服务器。**仅支持 HTTP**：浏览器无法在虚拟网内终止 TLS，因此被暴露的服务必须是 HTTP 明文服务。

角色定位：这是一个**工程实现型**仓库。判断改动是否合理的第一标准是「能否跑通并被验证」，而不是「设计是否优雅」。

---

## 2. 命令

以下命令均已在本仓库验证可执行。工作目录均为仓库根目录。

### 安装与启动

```bash
pnpm install                 # 安装依赖（Node >= 20，pnpm 11.22.0）
pnpm dev:worker              # 启动 Worker，监听 127.0.0.1:8787
pnpm dev:admin               # 启动管理后台，监听 127.0.0.1:5173，/api 代理到 8787
pnpm dev:portal              # 启动浏览器门户，监听 127.0.0.1:5174
```

首次启动 Worker 前需要创建本地密钥文件 `apps/worker/.dev.vars`（已被 gitignore 排除）：

```
ADMIN_SESSION_SECRET=<至少 32 字节的随机字符串>
NT_MASTER_KEY=<32 字节随机数据的 base64>
NT_RELAY_NETWORK_NAME=nodetunnel-relay
NT_RELAY_NETWORK_SECRET=<至少 16 位的随机字符串>
NT_ADMIN_ORIGIN=http://127.0.0.1:5173
```

`NT_MASTER_KEY` 必须是 **base64 编码且解码后恰好 32 字节**，否则加密组网密钥时会失败。

### 数据库

```bash
pnpm db:migrate:local        # 应用迁移到本地 D1
pnpm db:migrate:remote       # 应用迁移到远端 D1
```

### WebAssembly 内核

```bash
pnpm build:wasm              # 编译浏览器 profile 的内核
pnpm build:wasm:cf           # 编译 Cloudflare profile（中继用）的内核
pnpm build:wasm:all          # 编译两者，并把浏览器内核搬运到 portal 的 public 目录
```

编译需要 Rust（`wasm32-wasip1` 目标）、Visual Studio 的 MSVC 工具链与 clang。详细前置条件见第 7 节。

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
pnpm deploy                  # 部署 Worker（需先在 wrangler.jsonc 填入真实 D1 id）
```

### 上游同步

```bash
pnpm sync:upstream           # 从只读参考目录同步 easytier-js
pnpm sync:upstream --check   # 只校验差异，不写入
```

### 测试用目标服务

```bash
node scripts/test-target-server.mjs   # 在 127.0.0.1:9911 启动一个 HTTP 服务
```

用于验证 `/t/<slug>/` 转发链路，不参与构建产物。

---

## 3. 测试

### 测试栈

- Vitest 3，各工作区独立配置（`vitest.config.ts`）。
- Worker 与 portal 的测试运行在 `node` 环境，覆盖纯逻辑：协议渲染、输入校验、命名映射、HTTP 解析。

### 运行

```bash
pnpm test                                        # 全部
pnpm --filter @nodetunnel/worker test            # 单个工作区
pnpm --filter @nodetunnel/worker test:watch      # 监听模式
```

### 现有覆盖

| 工作区              | 文件                           | 覆盖内容                                        |
| ------------------- | ------------------------------ | ----------------------------------------------- |
| `packages/protocol` | `test/acl.test.ts`             | ACL 渲染的默认拒绝不变式                        |
| `packages/protocol` | `test/config.test.ts`          | 隧道节点与浏览器节点的配置渲染                  |
| `apps/worker`       | `test/config-security.test.ts` | 下发的 TOML 必须默认拒绝入站；管理 API 输入校验 |
| `apps/worker`       | `test/relay-naming.test.ts`    | 组网名到 Durable Object 名称的映射              |
| `apps/portal`       | `test/tunnel-http.test.ts`     | HTTP/1.1 响应解析（含 chunked 与畸形输入）      |

### 测试约定

- **安全不变式必须有测试守护。** 「入站默认拒绝」「只放行白名单端口」「转发链拒绝」这三条一旦被改坏，必须立刻有测试失败。
- 新增解析类逻辑（协议、报文、编码）必须附带畸形输入的报错测试。
- 测试名与断言注释使用中文，说明「这条断言在守护什么」。
- 需要加载 WASM 或 Workers 运行时的集成测试尚未引入；纯逻辑保持与运行时解耦，便于单独测试。

---

## 4. 项目结构

```
nodetunnel/
├── apps/
│   ├── worker/                    # 中心服务（接入层 + 业务层 + 基础层）
│   │   ├── migrations/            # D1 迁移（唯一事实来源）
│   │   ├── src/
│   │   │   ├── index.ts           # 入口：路径分发、异常兜底、DO 导出
│   │   │   ├── home.ts            # 首页与 /health
│   │   │   ├── env.d.ts           # Env 接口
│   │   │   ├── admin/             # 业务层：管理 API 与认证
│   │   │   ├── nodetunnel/        # 业务层：隧道、路由、节点、地址推导
│   │   │   ├── http-tunnel/       # 业务层：/t/<slug>/ 转发
│   │   │   ├── config-server/     # 基础层：WebSocket JSON-RPC 配置服务器
│   │   │   ├── relay/             # 基础层：EasyTier 中继与 DO 命名
│   │   │   ├── db/                # 基础层：D1 访问、心跳落库
│   │   │   └── lib/               # 基础层：错误、日志、加密、会话
│   │   ├── test/
│   │   └── wrangler.jsonc
│   ├── admin/                     # 管理后台（Vue 3 + Vite + Ant Design Vue）
│   │   └── src/{api,layouts,router,stores,styles,views}/
│   └── portal/                    # 浏览器门户（Vue 3 + Vite）
│       ├── public/easytier_core.wasm   # 由 build:wasm:all 搬运
│       ├── scripts/copy-wasm.mjs
│       ├── src/easytier/          # 浏览器内 EasyTier 节点与 HTTP-over-tunnel
│       └── test/
├── packages/
│   ├── shared/                    # 领域类型、校验、常量（零依赖）
│   ├── protocol/                  # ACL 与配置渲染、配置服务器 JSON-RPC
│   └── easytier-js/               # vendored 上游代码（见第 6 节）
│       ├── runtime/               # 共享 WASM 运行时与宿主实现
│       ├── browser/               # 浏览器适配
│       ├── cloudflare/            # Cloudflare Workers 适配
│       └── UPSTREAM.md            # 同步来源与保留清单（由脚本生成）
├── scripts/
│   ├── build-wasm.ps1             # 编译 EasyTier 内核为 wasm32-wasip1
│   ├── sync-upstream.mjs          # 从只读参考目录同步 easytier-js
│   └── test-target-server.mjs     # 测试用 HTTP 目标服务
├── docs/webrtc-p2p-status.md      # WebRTC P2P 的调研结论与阻塞点
└── 其他项目代码/                   # 只读参考代码，绝不修改
```

---

## 5. 代码风格

- **语言**：TypeScript strict，ESM，`verbatimModuleSyntax` 开启。类型导入必须写 `import type`。
- **注释与文案**：全部使用中文。注释解释**为什么**这样做（尤其是安全相关的取舍），不重述代码在做什么。
- **命名**：变量与函数用英文，领域概念（隧道、路由、节点、端口白名单）保持与中文注释一致。
- **格式化**：Prettier 统一处理，不要手工对齐。提交前跑 `pnpm format`。
- **类型**：禁止 `any`（ESLint 报错）。用 `unknown` 加显式收窄。
- **错误处理**：业务错误一律通过 `AppError` + `ErrorCode` 抛出，由顶层统一转换为结构化 JSON。不要在各处自行拼装错误响应。
- **日志**：使用 `src/lib/logger.ts`，它会自动脱敏敏感字段。禁止 `console.log` 输出密钥、密码或完整配置。
- **路径别名**：`@/` 指向各应用的 `src/`（仅在 admin 与 portal 中配置）。

### 三层边界

这是本仓库最重要的结构性约束，由 ESLint 的 `no-restricted-imports` 强制。

```
接入层  →  业务层  →  基础层
```

- **接入层**：`apps/worker/src/index.ts`、`apps/admin`、`apps/portal`。只做分发与展示，不含业务规则。
- **业务层**：`apps/worker/src/{nodetunnel,admin,http-tunnel}`。编排用例，决定「允许什么、拒绝什么」。
- **基础层**：`apps/worker/src/{db,relay,config-server,lib}`、`packages/**`。提供能力，不认识业务概念。

规则：

1. **基础层不得导入业务层或接入层。** 需要共享的类型下沉到 `packages/shared`。这条规则已经抓到过一次真实违规（配置服务器曾直接导入 `nodetunnel/node-registry`，后把心跳实现下沉到 `db/node-heartbeat.ts`）。
2. **业务层不得从 `cloudflare:workers` 导入 `DurableObject`。** 需要 Durable Object 能力时，通过基础层暴露的接口访问。
3. 出现循环依赖时，说明分层放错了位置，应下沉共享类型而不是绕过规则。

---

## 6. 上游代码与只读参考目录

### `其他项目代码/` 是只读的

该目录存放参考实现（EasyTier 源码、easytier-web、vue-vben-admin）。

**绝对禁止修改或写入其中任何文件。** 它被 `.gitignore` 排除，也不参与构建。需要借鉴代码时，复制到本仓库的对应位置再改。

已验证的保护措施：WASM 编译通过 `CARGO_TARGET_DIR` 把构建缓存重定向到 `.wasm-build/target`，因此不会在参考目录里生成 `target/`。

### `packages/easytier-js/` 是 vendored 上游代码

由 `pnpm sync:upstream` 从参考目录同步而来。原则是**最小改动复用上游**：

- 不做格式化、不重命名、不重构。
- `.prettierignore` 与 ESLint 都对该目录放宽，避免每次同步产生大量纯格式差异。
- 目前仅有 5 处必要的一行改动，全部登记在 `sync-upstream.mjs` 的 `PRESERVE` 列表中，同步时不会被覆盖：
  - 三个 `package.json`：改为 `private: true` + `workspace:*`，exports 直指 TS 源码；
  - `browser/tsconfig.json` 与 `cloudflare/tsconfig.json`：`include` 补上 `../runtime/src/jspi.d.ts`，否则从这两个包发起类型检查会找不到 `WebAssembly.Suspending`。
- `PRESERVE` 中还预留了 `runtime/src/rtc-host.ts` 与 `runtime/src/transport/`，供将来实现 WebRTC 时新增文件而不被同步覆盖。

**修改上游代码前必须先在 `PRESERVE` 中登记**，否则下次同步会静默丢失你的改动。

### 功能现状与限制

- 上游的宿主实现 `runtime/src/websocket-host.ts` **只实现了 WebSocket 隧道与 TCP 数据面**；所有 UDP 宿主函数（`start_udp_recv`、`try_udp_send`、`start_udp_bind` 等 7 个）都直接返回 `HOST_UNSUPPORTED`。
- `runtime/src/config.ts` 中 `disable_p2p = true` 位于公共尾部，对两个 profile 都生效。
- 因此**浏览器间 WebRTC P2P 直连目前不可用**，所有流量经中继转发。完整证据链与后续路线见 `docs/webrtc-p2p-status.md`。

---

## 7. 环境与配置

### 必需密钥（fail-closed）

Worker 在缺少必需密钥时**拒绝工作**，不会回退到默认值——使用默认密钥意味着任何人都能伪造管理会话或解密组网密钥。

| 变量                      | 要求                       | 用途                          |
| ------------------------- | -------------------------- | ----------------------------- |
| `ADMIN_SESSION_SECRET`    | ≥ 32 字节                  | 管理员会话令牌的 HMAC 密钥    |
| `NT_MASTER_KEY`           | base64，解码后恰好 32 字节 | AES-GCM 加密 `network_secret` |
| `NT_RELAY_NETWORK_NAME`   | 非空                       | 中继自身的组网名              |
| `NT_RELAY_NETWORK_SECRET` | 非空                       | 中继自身的组网密钥            |
| `NT_ADMIN_ORIGIN`         | 可选                       | 管理后台的 CORS 白名单来源    |

本地开发放在 `apps/worker/.dev.vars`；生产用 `wrangler secret put <名称>`。

### WASM 编译前置

编译 EasyTier 内核需要：

- Rust 工具链 + `rustup target add wasm32-wasip1`；
- Visual Studio 的 MSVC 工具链（编译 proc-macro 与 build script 的宿主代码）；
- **clang**（`ring` 在 `wasm32-wasip1` 目标下需要它交叉编译 C/汇编）。

`scripts/build-wasm.ps1` 会自动处理两件容易踩坑的事：

1. **MSVC 环境不能写成一行 `cmd /c "call vcvars64.bat && set X=%X%;..."`**。在一行命令中 `%X%` 会在 vcvars 执行**之前**就被展开，导致 vcvars 设置的值被覆盖（表现为找不到 `vcruntime.h`）。脚本改为生成临时 `.cmd` 文件并开启延迟展开。
2. **批处理文件以 UTF-8 写出**，否则中文路径「其他项目代码」会被按当前代码页解码成 `??????`。

### Cloudflare 侧的兼容标志

`wrangler.jsonc` 只使用 `["nodejs_compat"]`，与上游 `easytier-js/cloudflare/wrangler.jsonc` 保持一致。

**不要添加 JSPI 相关标志。** workerd 并不存在名为 `jspi` 或 `experimental_wasm_jspi` 的 compatibility flag，加上会导致「No such compatibility flag」而完全无法启动。JSPI 调度用于浏览器 profile，Cloudflare 适配层不依赖它。

### Durable Object

- 组网隔离通过对象名实现：组网名经 FNV-1a 哈希映射为 `net-<hex>`（见 `src/relay/object-name.ts`）。该函数是纯函数，被单元测试覆盖。
- DO 类必须从入口文件 `src/index.ts` 导出，否则 Wrangler 报「not exported in your entrypoint」。
- **Worker 模块的每个具名导出都必须是 handler 或 Durable Object 类。** 导出普通常量会导致运行时启动失败。

---

## 8. 错误处理

### 统一模型

所有业务错误通过 `AppError`（`src/lib/errors.ts`）抛出，携带 `ErrorCode` 与可选的中文消息、字段名。顶层 `handleTopLevelError` 负责转换：

- `AppError` → 对应 HTTP 状态码 + `{ error: { code, message, details } }`；
- 其他异常 → 记录完整堆栈到日志，但**只向客户端返回通用错误**，避免泄露内部结构。

### 设计规则

- **新增错误码时必须三处同步**：`ErrorCode` 常量对象、`ERROR_STATUS` 状态码映射、面向用户的文案。
- **不要把底层异常直接暴露给客户端。** 数据库或网络错误需要包装成有意义的业务错误。
- **安全相关的失败要 fail-closed。** 校验不通过时拒绝服务，而不是降级放过。密钥缺失、ACL 未配置、会话无效都属于这一类。
- **前端错误文案来自服务端。** 登录失败不区分「用户不存在」与「密码错误」，避免账号枚举；前端也不应自行推断具体原因。

### 可观测性

- 使用 `logger` 的分级方法。`logger.error` 用于需要人工介入的情况，`logger.warn` 用于可预期的拒绝。
- 日志字段用英文键名，值可以是中文。敏感字段由 logger 自动脱敏。

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

- **不要声称「应该能工作」。** 涉及运行时的改动必须在 `pnpm dev:worker` 下实际请求验证。
- 改动了配置下发或 ACL 逻辑时，必须实测一次客户端拉取到的 TOML，确认「默认拒绝入站」仍然成立。
- 改动了中继或 Durable Object 时，必须确认 `GET /health` 返回 `relay.state = "running"`。
- 构建类改动必须跑一次 `pnpm build`，确认 `wrangler deploy --dry-run` 通过（它会验证 WASM 能否正确打包）。

### Git 工作流

- 提交信息使用**中文**，遵循 Conventional Commits：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`。
- 首行简明扼要，正文说明**为什么**改，以及验证了什么。
- 一个提交只做一件事。修复与重构分开提交。
- 提交前确认 `git status` 中没有意外的文件（尤其是 `其他项目代码/`、`.dev.vars`、构建产物）。

---

## 10. 当前状态

已完成并经过实测：

- Worker 中继（Durable Object 内运行 EasyTier WASM 内核，`/health` 返回 `state: "running"`）；
- 配置服务器（WebSocket JSON-RPC，处理 `Heartbeat` 与 `GetFeature`）；
- 客户端配置下发（`/api/v1/machines/:machine-id/networks/config/:inst-id`，与 easytier-web 路由对齐）；
- 管理 API 与安全不变式（二次初始化被拒、未认证被拒、错误密码被拒）；
- 管理后台（初始化、登录、仪表盘、隧道、路由、节点、设置）；
- HTTP 隧道转发（`/t/<slug>/` → 虚拟网内服务，已端到端验证）；
- 浏览器门户（页面内运行 EasyTier 节点 + HTTP-over-tunnel）。

已知限制：

- 仅支持 HTTP，被暴露的服务必须自行处理 TLS 终止；
- WebRTC P2P 直连不可用，所有流量经中继转发（见 `docs/webrtc-p2p-status.md`）；
- 尚未引入基于 `@cloudflare/vitest-pool-workers` 的 Workers 运行时集成测试。
