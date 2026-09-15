# WebRTC P2P 直连：调研结论与方案定型

本文记录「打洞成功后走 WebRTC P2P，失败回落中继」这一目标的完整调研过程与最终结论。

**结论先行**：

1. 浏览器与**普通 EasyTier 节点**之间**不可能** P2P，因为承载层错配（浏览器只有 WebRTC，
   普通节点只认原生 UDP）。
2. 浏览器与**自研 WebRTC 节点**之间**可以** P2P，两侧都受我们控制，承载层一致。
3. EasyTier 的打洞策略在 WebRTC 下**绝大部分无法迁移**，且**不需要迁移**——
   WebRTC 的 ICE 本身已内含可用部分。
4. **本项目不自行实现打洞**，直接使用浏览器原生 ICE；打洞失败回落现有 Worker 中继，
   **不部署 TURN**。

---

## 一、为什么浏览器无法与普通 EasyTier 节点打洞

早期结论正确，但原因需要精确化：**不是「改了协议格式」，而是「传输层对不上」**。

EasyTier 打洞流程：

1. 双方经信令交换各自的公网 `IP:UDP端口`——**格式完全兼容**，浏览器能收发；
2. 双方各自往对方地址**发原生 UDP 包**试图打穿 NAT——**这一步断掉**。

浏览器没有原始 UDP socket，唯一等效通道是 `RTCDataChannel`，
它走 **DTLS over ICE over SCTP**，字节层面根本不是 UDP 包，
也无法送达普通 EasyTier 客户端的 UDP 端口。

**因此：浏览器节点加入普通 EasyTier 组网，永远只能经中继通信。**
这一点与实现语言无关（Rust / JS 都一样），瓶颈是浏览器 API 的暴露面。

---

## 二、为什么「自研 WebRTC 节点」这条路可行

如果暴露 HTTP 服务的主机上跑的也是我们自己的 WebRTC 节点，两侧承载层就一致了：

```
浏览器门户 ──DataChannel──▶ 主机端桥接服务 ──TCP──▶ 内网 HTTP 服务
     │                            │
     └──── 信令经 Worker ─────────┘
     └──── 打洞失败 → 回落 /t/<slug>/ 中继 ────┘
```

这条路成立，但有一个必须明说的后果：

**在这条链路上 EasyTier 完全不参与。** 主机端桥接服务只做一件事——
把 DataChannel 的字节转成对 `127.0.0.1:<port>` 的 TCP 连接。
没有虚拟网、没有组网名、不需要 `network_secret`。

即：原始需求第 3 条（用 easytier-js 让浏览器加入虚拟网）与新方案是**两条独立路线**，
新方案更简单、能真正 P2P，但**不再有「虚拟局域网」这个抽象**。

---

## 三、EasyTier 打洞策略评估（源码级）

### 3.1 术语纠正：EasyTier 没有实现「生日攻击」

社区常把这个说成生日攻击，但源码显示是**随机端口扫描**，两者数学相关但行为不同。

候选池构造（`easytier-core/src/connectivity/hole_punch/udp/server.rs:79-80`）：

```rust
let mut shuffled_port_vec: Vec<u16> = (1..=65535).collect();
shuffled_port_vec.shuffle(&mut rand::thread_rng());
```

每轮发包量（同文件 `:225-228`）：

```rust
let mut max_k2: u32 = rand::thread_rng().gen_range(600..800);
if round > 2 {
    max_k2 = (max_k2 * 2 / round).max(MAX_K1_FOR_RANDOM_HARD_SYM);  // 180
}
```

发送逻辑（同文件 `:776-789`）：从打乱列表顺序取 600~800 个端口，
每个端口对每个公网 IP 发 3 个包，每包间隔 1ms；
对端用一次绑定 **84 个** UDP socket 的数组接应
（`client.rs:38` `UDP_ARRAY_SIZE_FOR_HARD_SYM = 84`）。

**这是穷举扫描 + 多 socket 接应，不是生日悖论的概率碰撞。**

### 3.2 完整策略矩阵

决定逻辑在 `easytier-core/src/connectivity/hole_punch/udp/common.rs:81-137`：

| 本端 ↓ / 对端 → | Open | Cone           | EasySym              | HardSym |
| --------------- | ---- | -------------- | -------------------- | ------- |
| **Open**        | None | None           | None                 | None    |
| **Cone**        | None | **ConeToCone** | None                 | None    |
| **EasySym**     | None | **SymToCone**  | **EasySymToEasySym** | None    |
| **HardSym**     | None | **SymToCone**  | None                 | None    |

两个容易误读的点：

- **Open 返回 None 不是缺陷**：已在公网，直连即可，无需打洞
  （`common.rs:110-112`）。
- **HardSym ↔ HardSym 上游自己就放弃了**（`common.rs:128-133`）：
  双方端口都随机、窗口对不上，穷举 `65535 × 65535` 不现实。

### 3.3 各策略在 WebRTC 下的可用性

| 策略                 | WebRTC 可用？   | 原因                                                                     |
| -------------------- | --------------- | ------------------------------------------------------------------------ |
| **ConeToCone**       | ⚠️ 可用但无意义 | ICE 原生就做这件事，不需要 EasyTier 代码                                 |
| **SymToCone**        | ❌ 不可用       | 需指定源端口、从 84 个 socket 发包；浏览器不暴露也不允许干预 UDP 端口    |
| **EasySymToEasySym** | ❌ 不可用       | 需 STUN 查基准端口 + 预测偏移（`DST_PORT_OFFSET = 20`）+ 绑 25 个 socket |
| **HardSym 端口扫描** | ❌ 不可用       | 需绑多个 socket 并任意指定目标端口，浏览器无此能力                       |
| **HardSym↔HardSym**  | ❌ 不可用       | 上游本就未实现                                                           |

**关键推论**：这些策略**不需要迁移**。WebRTC 的 ICE 已经内含了工业级的打洞实现：

| EasyTier              | WebRTC/ICE 对应                         |
| --------------------- | --------------------------------------- |
| ConeToCone            | ICE 原生（host / srflx candidate 互探） |
| 84 个 UDP socket 数组 | ICE candidate pair 集合                 |
| SymToCone 端口预测    | ICE 不做（浏览器不暴露端口）            |
| HardSym 端口扫描      | ICE 不做                                |
| EasySymToEasySym      | ICE 不做                                |

ICE 的策略是固定的：**能打就打（Cone 场景），打不通就靠 TURN 中转。**
不存在「让 EasyTier 用生日攻击」的可能——攻击所需能力（绑端口、控源端口、
多 socket）浏览器一个都不提供。

### 3.4 对称型 NAT（NAT4）的实际结果

| 场景                       | EasyTier 原生 UDP | WebRTC          |
| -------------------------- | ----------------- | --------------- |
| Cone ↔ Cone                | ✅                | ✅ ICE 直接搞定 |
| Cone ↔ 一方有公网 IP       | ✅                | ✅              |
| Cone ↔ Sym                 | ✅ SymToCone      | ❌ 需 TURN      |
| **Sym ↔ Sym（双方 NAT4）** | ❌ 上游未实现     | ❌ 需 TURN      |

**NAT4 ↔ NAT4 在任何方案下都基本无解**，除非部署 TURN。

---

## 四、最终方案

### 4.1 决策

1. **不自行实现打洞**，直接使用浏览器原生 ICE。
2. **不部署 TURN**（Cloudflare 托管 TURN 或自建 coturn 都不引入）。
3. **打洞失败回落现有 Worker 中继**（`/t/<slug>/`，已端到端实测可用）。
4. 主机端形态：**与现有管理后台的 tunnel 绑定**，用 tunnel 的 id + 密钥
   自动拉取配置，不手写配置文件。
5. 传输范围：**只做 HTTP**（浏览器无法在虚拟网内终止 TLS）。

### 4.2 与需求原文的对应

> 未打洞成功时使用中继访问该 tunnel 服务，打洞成功时走 P2P

- **打洞成功**：WebRTC DataChannel 直连主机端桥接服务；
- **打洞失败**：回落 `/t/<slug>/` 中继（含 Cone↔Sym、Sym↔Sym 等 ICE 失败场景）。

需求意图完整实现，且**不需要 TURN**——因为回落路径就是中继本身。

### 4.3 待实现组件

1. **信令房间（Durable Object）**：中转 SDP / ICE candidate。
   Worker 是无状态的，WebSocket 无法在两个客户端间直接转发，必须用 DO 做房间。
   可复用现有 DO 基础设施与命名方式（`src/relay/object-name.ts`）。
2. **主机端桥接服务（Node.js）**：`RTCDataChannel` ←→ 本地 TCP。
   需要验证 Node 侧 WebRTC 实现的可用性（如 `node-datachannel`，含原生依赖）。
3. **浏览器门户改造**：新增 P2P 路径，优先尝试 DataChannel，
   失败则回落到现有中继路径。

### 4.4 验证顺序（必须先做第 1 步）

1. **主机端 Node WebRTC 可用性验证**：两个 Node 进程之间建立 DataChannel
   并跑通字节传输。**这是地基**——若 Node 侧 WebRTC 不可用，整个方案不成立。
2. 信令 DO 与信令协议。
3. 浏览器 ↔ 主机端真实打洞，实测 Cone 场景成功率。
4. 回落逻辑与端到端联调。

---

## 五、附：本文结论的源码依据

| 结论                                   | 文件与行号                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| WASM 导入 7 个 UDP 宿主函数            | `packages/easytier-js/browser/src/generated/easytier_core.wasm` import 段解析 |
| JS 宿主全部返回 HOST_UNSUPPORTED       | `packages/easytier-js/runtime/src/websocket-host.ts:161-169`                  |
| `disable_p2p = true` 对两 profile 生效 | `packages/easytier-js/runtime/src/config.ts:64`                               |
| 打洞策略矩阵                           | `easytier-core/src/connectivity/hole_punch/udp/common.rs:81-137`              |
| 84 / 25 socket 数组常量                | `easytier-core/src/connectivity/hole_punch/udp/client.rs:38-39`               |
| 端口预测偏移 20                        | `easytier-core/src/connectivity/hole_punch/udp/client.rs:40`                  |
| 65535 端口打乱候选池                   | `easytier-core/src/connectivity/hole_punch/udp/server.rs:79-80`               |
| 每轮 600~800 包、下限 180              | `easytier-core/src/connectivity/hole_punch/udp/server.rs:225-228`             |
| 扫描发送逻辑（每端口 3 包）            | `easytier-core/src/connectivity/hole_punch/udp/server.rs:776-789`             |

`scripts/sync-upstream.mjs` 的 PRESERVE 列表已预留
`runtime/src/rtc-host.ts` 与 `runtime/src/transport/`，供将来实现时新增文件
而不被上游同步覆盖。
