/**
 * 前后端共用的领域类型。
 *
 * 这些类型是 Worker 管理 API、管理后台、agent 与 portal 之间的唯一契约来源。
 * 修改时必须同时检查四端的用法。
 */

/** 暴露端口的传输层协议。 */
export type PortProtocol = 'tcp' | 'udp';

export interface TunnelPort {
  port: number;
  protocol: PortProtocol;
}

/**
 * tunnel：一台主机端 agent 的接入登记与其暴露策略。
 *
 * 与重构前的区别：不再有 EasyTier 组网名与中继地址。主机端凭接入令牌
 * 连上 Worker 的信令房间，路由转发与 P2P 都以此为身份锚点。
 */
export interface Tunnel {
  id: string;
  /** 展示名，唯一。 */
  name: string;
  /**
   * 接入令牌的前 8 位，仅用于管理后台辨认「这是哪一把令牌」。
   * 完整令牌只在创建/轮换时返回一次，服务端只存哈希。
   */
  tokenPrefix: string;
  enabled: boolean;
  /** 允许入站的端口白名单；其余端口一律拒绝。 */
  ports: TunnelPort[];
  createdAt: number;
  updatedAt: number;
}

/**
 * 创建或轮换令牌后的一次性返回。
 *
 * `token` 是明文，此后服务端无法再取回 —— 丢失只能重新轮换。
 */
export interface TunnelWithToken extends Tunnel {
  token: string;
}

/** 路由：把 `/t/<slug>` 前缀映射到某台主机上的目标服务。 */
export interface Route {
  id: string;
  /** URL 前缀片段，唯一，形如 `my-app`，对应 `/t/my-app/...`。 */
  slug: string;
  tunnelId: string;
  targetHost: string;
  targetPort: number;
  /**
   * 专属域名（可选）。
   *
   * 设置后，该域名下的**所有**路径都直接交给这条路由，应用跑在自己
   * origin 的根路径上 —— 于是 `/js/app.js`、`/api/xxx` 这类绝对路径
   * 无需任何改写即可工作，这正是「各种项目直接接上 tunnel 就能跑」的关键。
   *
   * 为空表示只能用 `/t/<slug>/` 前缀形式访问（此时应用发出的绝对路径会失效）。
   */
  hostname: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 已接入的主机端 agent。由信令房间在连接建立/断开时写入。 */
export interface AgentRecord {
  id: string;
  tunnelId: string;
  hostname: string | null;
  version: string | null;
  /** 最近一次心跳时间（Unix 毫秒）。 */
  lastSeen: number;
  /** 最近一次上报的本地可达端口（用于管理后台核对白名单是否生效）。 */
  reportedPorts: number[];
  createdAt: number;
}

/** 管理员账号（绝不包含密码字段）。 */
export interface AdminAccount {
  id: string;
  username: string;
  createdAt: number;
  updatedAt: number;
}

/** 系统初始化状态。 */
export interface SystemStatus {
  initialized: boolean;
  version: string;
  /** 当前是否已有登录会话（仅 /api/v1/auth/status 返回）。 */
  authenticated?: boolean;
  /**
   * 当前登录的管理员账号（仅已登录时返回）。
   *
   * 带上它是为了让前端刷新页面后能拿到**真实**用户名：用户名可以修改，
   * 前端若硬编码一个默认名，改过用户名后顶栏会一直显示错误的旧值。
   */
  admin?: AdminAccount;
}

export interface DashboardStats {
  tunnelCount: number;
  routeCount: number;
  agentCount: number;
  onlineAgentCount: number;
  /** 当前信令房间内的活跃连接数（访客 + 主机）。 */
  activeConnections: number;
}

/** 统一错误响应体。 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
