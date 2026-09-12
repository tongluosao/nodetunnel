import { ADMIN_API_PREFIX } from '@nodetunnel/shared';

/**
 * 管理 API 客户端。
 *
 * 统一处理：
 *   - 会话 Cookie（同源请求自动携带）；
 *   - 错误结构反序列化（后端固定返回 { error: { code, message } }）；
 *   - 401 时抛出可识别的错误，由路由守卫引导回登录页。
 */

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

export interface AdminInfo {
  id: string;
  username: string;
}

export interface AuthStatus {
  initialized: boolean;
  version: string;
  authenticated: boolean;
}

export interface TunnelPort {
  port: number;
  protocol: 'tcp' | 'udp';
}

export interface Tunnel {
  id: string;
  name: string;
  networkName: string;
  relayUrl: string;
  enabled: boolean;
  ports: TunnelPort[];
  createdAt: number;
  updatedAt: number;
}

export interface Route {
  id: string;
  slug: string;
  tunnelId: string;
  targetHost: string;
  targetPort: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NodeRecord {
  id: string;
  instanceId: string;
  machineId: string | null;
  hostname: string | null;
  tunnelId: string | null;
  ipv4: string | null;
  easytierVersion: string | null;
  lastSeen: number;
  createdAt: number;
}

export interface DashboardStats {
  tunnelCount: number;
  routeCount: number;
  nodeCount: number;
  onlineNodeCount: number;
  relayConnections: number;
  relayUrl: string;
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
    changePassword: (currentPassword: string, newPassword: string) =>
      request<{ ok: true }>('/auth/password', {
        method: 'PUT',
        ...json({ currentPassword, newPassword }),
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
    config: (id: string) =>
      fetch(`${ADMIN_API_PREFIX}/tunnels/${id}/config`, { credentials: 'same-origin' }).then(
        async (response) => {
          if (!response.ok) {
            throw new ApiError('config_fetch_failed', '获取配置失败', response.status);
          }
          return response.text();
        },
      ),
    create: (input: {
      name: string;
      networkName: string;
      networkSecret: string;
      relayUrl?: string;
      ports: TunnelPort[];
      enabled?: boolean;
    }) => request<{ tunnel: Tunnel }>('/tunnels', { method: 'POST', ...json(input) }),
    update: (
      id: string,
      input: Partial<{
        name: string;
        networkName: string;
        networkSecret: string;
        relayUrl: string;
        ports: TunnelPort[];
        enabled: boolean;
      }>,
    ) => request<{ tunnel: Tunnel }>(`/tunnels/${id}`, { method: 'PUT', ...json(input) }),
    remove: (id: string) => request<{ ok: true }>(`/tunnels/${id}`, { method: 'DELETE' }),
  },

  routes: {
    list: () => request<{ routes: Route[] }>('/routes'),
    create: (input: {
      slug: string;
      tunnelId: string;
      targetHost: string;
      targetPort: number;
      enabled?: boolean;
    }) => request<{ route: Route }>('/routes', { method: 'POST', ...json(input) }),
    update: (
      id: string,
      input: Partial<{
        slug: string;
        tunnelId: string;
        targetHost: string;
        targetPort: number;
        enabled: boolean;
      }>,
    ) => request<{ route: Route }>(`/routes/${id}`, { method: 'PUT', ...json(input) }),
    remove: (id: string) => request<{ ok: true }>(`/routes/${id}`, { method: 'DELETE' }),
  },

  nodes: {
    list: () => request<{ nodes: NodeRecord[] }>('/nodes'),
  },

  system: {
    relayHealth: (network = '') =>
      request<{ ok: boolean; state?: string; connections?: number }>(
        `/system/relay-health?network=${encodeURIComponent(network)}`,
      ),
  },
};
