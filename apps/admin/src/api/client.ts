import { ADMIN_API_PREFIX } from '@nodetunnel/shared';
import type {
  AgentRecord,
  DashboardStats,
  PortProtocol,
  Route,
  Tunnel,
  TunnelPort,
  TunnelWithToken,
} from '@nodetunnel/shared';

/**
 * 管理 API 客户端。
 *
 * 统一处理：
 *   - 会话 Cookie（同源请求自动携带）；
 *   - 错误结构反序列化（后端固定返回 { error: { code, message } }）；
 *   - 401 时抛出可识别的错误，由路由守卫引导回登录页。
 *
 * 领域类型全部复用 @nodetunnel/shared，避免前后端各写一份契约而逐渐漂移。
 */

export type {
  AgentRecord,
  DashboardStats,
  PortProtocol,
  Route,
  Tunnel,
  TunnelPort,
  TunnelWithToken,
};

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** 会话失效：需要重新登录。 */
  get isUnauthorized(): boolean {
    return this.status === 401 && this.code === 'unauthorized';
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

/**
 * 组装请求头。
 *
 * 仅在带请求体时声明 Content-Type: application/json，
 * 避免无体的 GET 请求触发不必要的 CORS 预检。
 */
function buildHeaders(init: RequestInit): HeadersInit {
  const headers: Record<string, string> = {};

  if (init.body !== undefined && init.body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  // 调用方显式传入的头优先。
  if (init.headers !== undefined) {
    const extra = new Headers(init.headers);
    extra.forEach((value, key) => {
      headers[key] = value;
    });
  }

  return headers;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${ADMIN_API_PREFIX}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: buildHeaders(init),
  });

  // 204 或空响应体。
  const text = await response.text();
  const payload: unknown = text === '' ? undefined : safeParse(text);

  if (!response.ok) {
    const body = payload as ErrorBody | undefined;
    throw new ApiError(
      body?.error?.code ?? 'unknown_error',
      body?.error?.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
      body?.error?.details,
    );
  }

  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function json(body: unknown): RequestInit {
  return { body: JSON.stringify(body) };
}

/* ------------------------------ 类型定义 ------------------------------ */

/** 管理后台会话中的管理员视图。服务端返回完整账号，前端只用到标识与用户名。 */
export interface AdminInfo {
  id: string;
  username: string;
}

export interface AuthStatus {
  initialized: boolean;
  version: string;
  authenticated: boolean;
  /** 已登录时返回真实账号，用于刷新后恢复顶栏用户名。 */
  admin?: AdminInfo;
}

/** 主机端与门户需要的接入地址，由服务端按当前部署域名推导。 */
export interface Endpoints {
  /** 主机端 agent 的 WebSocket 接入地址。 */
  agentUrl: string;
  /** 浏览器访客的信令地址。 */
  signalingUrl: string;
}

/* -------------------------------- 接口 -------------------------------- */

export const api = {
  auth: {
    status: () => request<AuthStatus>('/auth/status'),
    login: (username: string, password: string) =>
      request<{ admin: AdminInfo }>('/auth/login', {
        method: 'POST',
        ...json({ username, password }),
      }),
    logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
    /** 修改密码：不再需要当前密码，会话本身即身份凭证。 */
    changePassword: (newPassword: string) =>
      request<{ ok: true }>('/auth/password', {
        method: 'PUT',
        ...json({ newPassword }),
      }),
    /** 修改用户名：服务端会重签会话，返回更新后的账号信息。 */
    changeUsername: (username: string) =>
      request<{ admin: AdminInfo }>('/auth/username', {
        method: 'PUT',
        ...json({ username }),
      }),
  },

  setup: (username: string, password: string) =>
    request<{ admin: AdminInfo }>('/setup', {
      method: 'POST',
      ...json({ username, password }),
    }),

  dashboard: () => request<DashboardStats>('/dashboard'),

  tunnels: {
    list: () => request<{ tunnels: Tunnel[] }>('/tunnels'),
    get: (id: string) => request<{ tunnel: Tunnel }>(`/tunnels/${id}`),
    /** 创建隧道。返回值里的 token 是明文，只会出现这一次。 */
    create: (input: { name: string; ports?: TunnelPort[]; enabled?: boolean }) =>
      request<{ tunnel: TunnelWithToken }>('/tunnels', { method: 'POST', ...json(input) }),
    update: (id: string, input: Partial<{ name: string; ports: TunnelPort[]; enabled: boolean }>) =>
      request<{ tunnel: Tunnel }>(`/tunnels/${id}`, { method: 'PUT', ...json(input) }),
    remove: (id: string) => request<{ ok: true }>(`/tunnels/${id}`, { method: 'DELETE' }),
    /**
     * 轮换接入令牌。
     *
     * 旧令牌立即失效，主机端必须用新令牌重连；新令牌同样只返回一次。
     */
    rotateToken: (id: string) =>
      request<{ tunnel: TunnelWithToken }>(`/tunnels/${id}/rotate-token`, { method: 'POST' }),
  },

  routes: {
    list: () => request<{ routes: Route[] }>('/routes'),
    create: (input: {
      slug: string;
      tunnelId: string;
      targetHost: string;
      targetPort: number;
      /** 专属域名（完整域名）。路由没有域名就没有访问入口。 */
      hostname?: string | null;
      enabled?: boolean;
    }) => request<{ route: Route }>('/routes', { method: 'POST', ...json(input) }),
    update: (
      id: string,
      input: Partial<{
        slug: string;
        tunnelId: string;
        targetHost: string;
        targetPort: number;
        /** null 表示清除专属域名，undefined 表示保持不变。 */
        hostname: string | null;
        enabled: boolean;
      }>,
    ) => request<{ route: Route }>(`/routes/${id}`, { method: 'PUT', ...json(input) }),
    remove: (id: string) => request<{ ok: true }>(`/routes/${id}`, { method: 'DELETE' }),
  },

  agents: {
    list: () => request<{ agents: AgentRecord[] }>('/agents'),
  },

  system: {
    endpoints: () => request<Endpoints>('/system/endpoints'),
  },
};
