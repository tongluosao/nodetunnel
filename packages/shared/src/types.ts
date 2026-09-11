/**
 * 前后端共用的领域类型。
 *
 * 这些类型是 Worker 管理 API、管理后台与 portal 之间的唯一契约来源。
 * 修改时必须同时检查三端的用法。
 */

/** ACL 协议枚举，取值与 easytier-proto/proto/acl.proto 的 Protocol 一致。 */
export const AclProtocol = {
  Unspecified: 0,
  TCP: 1,
  UDP: 2,
  ICMP: 3,
  ICMPv6: 4,
  Any: 5,
} as const;

/** ACL 动作枚举，取值与 acl.proto 的 Action 一致。 */
export const AclAction = {
  Noop: 0,
  Allow: 1,
  Drop: 2,
} as const;

/** ACL 链类型枚举，取值与 acl.proto 的 ChainType 一致。 */
export const AclChainType = {
  Unspecified: 0,
  /** 发往本节点 */
  Inbound: 1,
  /** 由本节点发出 */
  Outbound: 2,
  /** 子网代理转发 */
  Forward: 3,
} as const;

export type AclProtocolValue = (typeof AclProtocol)[keyof typeof AclProtocol];
export type AclActionValue = (typeof AclAction)[keyof typeof AclAction];
export type AclChainTypeValue = (typeof AclChainType)[keyof typeof AclChainType];

/** 暴露端口的传输层协议。 */
export type PortProtocol = 'tcp' | 'udp';

export interface TunnelPort {
  port: number;
  protocol: PortProtocol;
}

/** tunnel：一个 EasyTier 组网 + 其暴露策略。 */
export interface Tunnel {
  id: string;
  /** 展示名，唯一。 */
  name: string;
  /** EasyTier 网络名，唯一。 */
  networkName: string;
  /** 中继地址（wss://...）。 */
  relayUrl: string;
  enabled: boolean;
  /** 允许入站的端口白名单；其余端口一律拒绝。 */
  ports: TunnelPort[];
  createdAt: number;
  updatedAt: number;
}

/** 路由：把 `/<slug>` 前缀映射到某个 tunnel 内的目标服务。 */
export interface Route {
  id: string;
  /** URL 前缀片段，唯一，形如 `my-app`，对应 `/t/my-app/...`。 */
  slug: string;
  tunnelId: string;
  targetHost: string;
  targetPort: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 已接入的 EasyTier 节点。 */
export interface NodeRecord {
  id: string;
  instanceId: string;
  hostname: string | null;
  machineId: string | null;
  tunnelId: string | null;
  ipv4: string | null;
  easytierVersion: string | null;
  lastSeen: number;
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
}

export interface DashboardStats {
  tunnelCount: number;
  routeCount: number;
  nodeCount: number;
  onlineNodeCount: number;
  relayConnections: number;
}

/** 统一错误响应体。 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
