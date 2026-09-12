# WebRTC P2P 直连：可行性与现状说明

本文记录「需求 3 打洞后走 WebRTC P2P」这一目标的调研结论。
结论先行：**当前无法在不修改上游 Rust 内核的前提下实现浏览器间 P2P 直连**，
因此本阶段没有落地代码，而是把阻塞点、证据与可行路线记录清楚。

## 需求原文

> 用户尝试对接入的所有 tunnel 进行打洞……实现当未打洞成功时，
> 会使用当前的中转访问该 tunnel 服务，当打洞成功时，
> 用户通过 WebRTC 技术实现 p2p 的网页访问。

## 现状：已实现的部分

「打洞失败时回落到中继」这条路径**已经是可用的**，并且经过实测：

- 浏览器节点通过 `wss://<host>/relay?network=<组网名>` 接入中继
  （Durable Object 内运行 EasyTier WASM 内核）；
- Worker 侧 `/t/<slug>/` 把 HTTP 请求经虚拟网转发到隧道内服务
  （已用 `scripts/test-target-server.mjs` 端到端验证）；
- 浏览器侧也可通过 `EasyTierTcpStream` 直接连接虚拟网内的
  `IP:端口`（见 `apps/portal/src/easytier/tunnel-http.ts`）。

也就是说，**「未打洞成功时使用中继访问」这一半的需求是完成状态**。

## 阻塞点：UDP 宿主函数全部返回「不支持」

浏览器内要建立 WebRTC DataChannel，必须让 EasyTier 内核把它的
UDP 数据报通过 DataChannel 收发。为此需要宿主（JS 层）实现
UDP 相关的导入函数。

### 证据一：内核确实导入了 UDP 宿主函数

解析编译产物 `easytier_core.wasm` 的 import 段，得到：

```
import 模块统计：{ "easytier_host": 37, "wasi_snapshot_preview1": 8 }

与 udp 相关的导入：
  easytier_host.start_udp_recv
  easytier_host.take_udp_recv
  easytier_host.try_udp_send
  easytier_host.start_udp_send_ready
  easytier_host.take_udp_send_ready
  easytier_host.start_udp_bind
  easytier_host.take_udp_bind
```

内核侧接口是齐备的，Rust 代码里存在完整的 UDP 抽象。

### 证据二：JS 宿主把它们全部立即返回「不支持」

`packages/easytier-js/runtime/src/websocket-host.ts` 第 161–169 行：

```ts
start_udp_recv: () => HOST_UNSUPPORTED,
take_udp_recv: () => HOST_UNSUPPORTED,
try_udp_send: () => HOST_UNSUPPORTED,
start_udp_send_ready: () => HOST_UNSUPPORTED,
take_udp_send_ready: () => HOST_UNSUPPORTED,
start_tcp_connect: () => HOST_UNSUPPORTED,
start_udp_bind: () => HOST_UNSUPPORTED,
take_udp_bind: () => HOST_UNSUPPORTED,
```

其中 `HOST_UNSUPPORTED = -4`。同目录的 `websocket-host.ts` 是本项目
唯一实现的宿主：它只实现了 **WebSocket 隧道 + TCP 数据面**，
UDP 路径是彻底的占位实现。

### 证据三：P2P 被显式关闭

`packages/easytier-js/runtime/src/config.ts` 第 64 行：

```ts
lines.push("disable_p2p = true");
```

该行位于 `renderConfig` 的公共尾部，**对 browser 与 cloudflare 两个
profile 都生效**，即所有由本 runtime 生成的配置都禁用了 P2P。

### 证据四：整个仓库没有任何 WebRTC 依赖

`Cargo.toml` 与各 `package.json` 中均无 `webrtc`、`str0m`、
`RTCPeerConnection` 相关的依赖或代码。上游的浏览器适配层
（`@easytier/browser`）也只是把 WebSocket 当作唯一传输。

## 为什么这不是「补几个函数」就能解决的

要真正打通，需要同时完成：

1. **JS 宿主实现 UDP 语义**：在 `websocket-host.ts` 中把 7 个 UDP
   导入函数实现为基于 `RTCDataChannel` 的收发队列，包括绑定、
   接收、发送与背压（`*_write_ready` 系列）。这是对上游核心文件
   的大幅修改。
2. **修改内核配置**：让 `config.ts` 能关闭 `disable_p2p`，
   并按需注入 P2P 相关参数。
3. **信令通道**：浏览器之间交换 SDP / ICE candidate 需要一个信令
   服务。当前架构里最自然的落点是复用配置服务器或中继的
   WebSocket 连接，但这需要新增一套信令协议与对应的服务端实现。
4. **NAT 穿透的现实约束**：即使用上 WebRTC，能否打洞成功仍取决于
   双方 NAT 类型；对称型 NAT 下依然要回落到 TURN 中继
   —— 而 TURN 服务器本项目并未部署。

第 1 项直接违反本项目「尽量不修改上游 easytier-js」的原则；
第 3、4 项则属于新增基础设施，超出「Worker + 浏览器」的范围。

## 结论与后续建议

- **不建议**在当前版本强行实现 P2P：改动面大、成功率受 NAT 影响、
  且需要额外部署信令与 TURN，投入产出比低。
- 当前架构的实际效果是：所有流量经 Cloudflare 的中继转发。
  这在功能上等价于「Cloudflare Tunnel」，延迟与可用性由
  Cloudflare 边缘网络保证，对绝大多数场景已经足够。
- 若确实需要 P2P，建议按以下顺序推进（每一步都可独立验证）：
  1. 先在 `websocket-host.ts` 旁边新增一个 `rtc-host.ts`，
     以「新增而非改写」的方式实现 UDP 宿主函数；
  2. 用 `RTCDataChannel` 在两个浏览器标签页之间做最小连通性验证
     （不接入 EasyTier，先证明数据面可用）；
  3. 再让 `config.ts` 支持关闭 `disable_p2p` 并把 DataChannel
     注册为一条 peer；
  4. 最后补信令通道与 TURN 回落。

`scripts/sync-upstream.mjs` 的 PRESERVE 列表已预留
`runtime/src/rtc-host.ts` 与 `runtime/src/transport/`，
后续实现时不会被上游同步覆盖。
