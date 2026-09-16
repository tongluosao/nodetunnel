import {
  ADMIN_API_PREFIX,
  AGENT_ONLINE_WINDOW_SECONDS,
  SESSION_COOKIE,
  isTargetHostAllowed,
  validatePassword,
  validatePort,
  validateSlug,
  validateTargetHost,
  validateTunnelPorts,
  validateUsername,
  validateUuid,
  type DashboardStats,
  type SystemStatus,
} from '@nodetunnel/shared';

import type { Env } from '../env.js';
import { AppError, ErrorCode, err, ok, type Result } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { currentAdmin, changePassword, initializeAdmin, isInitialized, login } from './auth.js';
import { buildClearSessionCookie, buildSessionCookie } from '../lib/session.js';
import * as registry from '../nodetunnel/registry.js';
import * as routesRegistry from '../nodetunnel/routes.js';
import * as agentRegistry from '../nodetunnel/agent-registry.js';
import { resolveAgentUrl, resolveOrigin, resolveSignalingUrl } from '../nodetunnel/endpoints.js';
import * as queries from '../db/queries.js';

/**
 * 管理 API（接入层 + 业务编排）。
 *
 * 所有端点都以 /api/v1 为前缀，除 auth 与 setup 外均要求管理员会话。
 */

export async function handleAdminApi(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // 跨域：管理后台在开发期与 Worker 不同源。
  const corsHeaders = buildCorsHeaders(request, env);
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const response = await dispatch(request, env, method, path);
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value);
    }
    return response;
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError(ErrorCode.INTERNAL_ERROR);
    if (!(error instanceof AppError)) {
      logger.error('admin_api_unhandled', {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return Response.json(appError.toBody(), { status: appError.status, headers: corsHeaders });
  }
}

async function dispatch(
  request: Request,
  env: Env,
  method: string,
  path: string,
): Promise<Response> {
  const segments = path
    .slice(ADMIN_API_PREFIX.length)
    .split('/')
    .filter((s) => s !== '');
  const [head, ...rest] = segments;

  // ---------------------------------------------------------------- 认证
  if (head === 'auth') {
    return handleAuth(request, env, method, rest);
  }

  // ---------------------------------------------------------------- 初始化
  if (head === 'setup' && method === 'POST') {
    return handleSetup(request, env);
  }

  // 以下端点均需要管理员会话。
  const admin = await currentAdmin(request, env);
  if (admin === undefined) {
    throw new AppError(ErrorCode.UNAUTHORIZED);
  }

  switch (head) {
    case 'dashboard':
      return Response.json(await dashboardStats(env));

    case 'tunnels':
      return handleTunnels(request, env, method, rest);

    case 'routes':
      return handleRoutes(request, env, method, rest);

    case 'agents':
      return handleAgents(env, method, rest);

    case 'system':
      return handleSystem(request, method, rest);

    default:
      throw new AppError(ErrorCode.NOT_FOUND, '接口不存在');
  }
}

/* ------------------------------- 认证 ------------------------------- */

async function handleAuth(
  request: Request,
  env: Env,
  method: string,
  rest: string[],
): Promise<Response> {
  const [action] = rest;

  // GET /api/v1/auth/status —— 无需登录，用于前端判断是否跳转初始化页。
  if (action === 'status' && method === 'GET') {
    const initialized = await isInitialized(env);
    const admin = await currentAdmin(request, env);
    const status: SystemStatus = {
      initialized,
      version: env.NODETUNNEL_VERSION,
      authenticated: admin !== undefined,
    };
    return Response.json(status);
  }

  if (action === 'login' && method === 'POST') {
    const body = await readJson(request);
    const username = validateUsername(body.username);
    if (!username.ok) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, username.message, { field: 'username' });
    }
    if (typeof body.password !== 'string') {
      throw new AppError(ErrorCode.VALIDATION_FAILED, '密码必须是字符串', { field: 'password' });
    }

    const result = await login(env, { username: username.value, password: body.password });
    if (!result.ok) {
      throw result.error;
    }

    return Response.json(
      { admin: result.value.admin },
      {
        headers: {
          'Set-Cookie': buildSessionCookie(result.value.token, isSecureRequest(request)),
        },
      },
    );
  }

  if (action === 'logout' && method === 'POST') {
    return Response.json(
      { ok: true },
      { headers: { 'Set-Cookie': buildClearSessionCookie(isSecureRequest(request)) } },
    );
  }

  if (action === 'password' && method === 'PUT') {
    const admin = await currentAdmin(request, env);
    if (admin === undefined) {
      throw new AppError(ErrorCode.UNAUTHORIZED);
    }
    const body = await readJson(request);
    if (typeof body.currentPassword !== 'string') {
      throw new AppError(ErrorCode.VALIDATION_FAILED, '缺少当前密码', {
        field: 'currentPassword',
      });
    }
    const next = validatePassword(body.newPassword);
    if (!next.ok) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, next.message, { field: 'newPassword' });
    }

    const result = await changePassword(env, admin.id, {
      currentPassword: body.currentPassword,
      newPassword: next.value,
    });
    if (!result.ok) {
      throw result.error;
    }
    return Response.json({ ok: true });
  }

  throw new AppError(ErrorCode.NOT_FOUND, '接口不存在');
}

/* ------------------------------ 初始化 ------------------------------ */

async function handleSetup(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);

  const username = validateUsername(body.username);
  if (!username.ok) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, username.message, { field: 'username' });
  }
  const password = validatePassword(body.password);
  if (!password.ok) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, password.message, { field: 'password' });
  }

  const result = await initializeAdmin(env, {
    username: username.value,
    password: password.value,
  });
  if (!result.ok) {
    throw result.error;
  }

  // 初始化成功后直接签发会话，免去一次登录。
  const session = await login(env, { username: username.value, password: password.value });
  if (!session.ok) {
    // 理论上不会发生；发生则要求用户手动登录。
    return Response.json({ admin: result.value });
  }

  return Response.json(
    { admin: result.value },
    {
      headers: { 'Set-Cookie': buildSessionCookie(session.value.token, isSecureRequest(request)) },
    },
  );
}

/* ------------------------------- 仪表盘 ------------------------------- */

async function dashboardStats(env: Env): Promise<DashboardStats> {
  const since = Date.now() - AGENT_ONLINE_WINDOW_SECONDS * 1000;
  const [tunnelCount, routeCount, agentCount, onlineAgentCount] = await Promise.all([
    queries.countTunnels(env.DB),
    queries.countRoutes(env.DB),
    queries.countAgents(env.DB),
    queries.countOnlineAgents(env.DB, since),
  ]);

  return {
    tunnelCount,
    routeCount,
    agentCount,
    onlineAgentCount,
    // 活跃连接数需要逐房间查询 Durable Object，这里不做扇出探测；
    // 需要精确值时由 /system/signaling 按隧道单独查询。
    activeConnections: onlineAgentCount,
  };
}

/* -------------------------------- 隧道 -------------------------------- */

async function handleTunnels(
  request: Request,
  env: Env,
  method: string,
  rest: string[],
): Promise<Response> {
  const [id, sub] = rest;

  // GET /api/v1/tunnels —— 列表
  if (id === undefined && method === 'GET') {
    return Response.json({ tunnels: await registry.listTunnels(env) });
  }

  // POST /api/v1/tunnels —— 新建（返回一次性明文令牌）
  if (id === undefined && method === 'POST') {
    const body = await readJson(request);
    const parsed = parseTunnelBody(body, true);
    if (!parsed.ok) {
      throw parsed.error;
    }

    const result = await registry.createTunnel(env, {
      name: parsed.value.name as string,
      ports: parsed.value.ports ?? [],
      enabled: parsed.value.enabled,
    });
    if (!result.ok) {
      throw result.error;
    }
    return Response.json({ tunnel: result.value }, { status: 201 });
  }

  if (id === undefined) {
    throw new AppError(ErrorCode.NOT_FOUND, '接口不存在');
  }

  // GET /api/v1/tunnels/:id
  if (sub === undefined && method === 'GET') {
    const tunnel = await registry.findTunnel(env, id);
    if (tunnel === undefined) {
      throw new AppError(ErrorCode.NOT_FOUND, '隧道不存在');
    }
    return Response.json({ tunnel });
  }

  // PUT /api/v1/tunnels/:id
  if (sub === undefined && method === 'PUT') {
    const body = await readJson(request);
    const parsed = parseTunnelBody(body, false);
    if (!parsed.ok) {
      throw parsed.error;
    }
    const result = await registry.updateTunnel(env, id, parsed.value);
    if (!result.ok) {
      throw result.error;
    }
    return Response.json({ tunnel: result.value });
  }

  // DELETE /api/v1/tunnels/:id
  if (sub === undefined && method === 'DELETE') {
    const result = await registry.deleteTunnel(env, id);
    if (!result.ok) {
      throw result.error;
    }
    return Response.json({ ok: true });
  }

  // POST /api/v1/tunnels/:id/rotate-token —— 轮换接入令牌
  // 旧令牌立即失效，主机端需用新令牌重连。
  if (sub === 'rotate-token' && method === 'POST') {
    const result = await registry.rotateTunnelToken(env, id);
    if (!result.ok) {
      throw result.error;
    }
    logger.info('tunnel_token_rotated', { tunnelId: id });
    return Response.json({ tunnel: result.value });
  }

  throw new AppError(ErrorCode.NOT_FOUND, '接口不存在');
}

/**
 * 解析并校验隧道请求体。
 *
 * isCreate 为 true 时 name 必填；其余字段可选。
 * 注意这里不再接受组网名、组网密钥或中继地址 —— 接入令牌由服务端生成，
 * 不接受客户端指定。
 */
function parseTunnelBody(
  body: Record<string, unknown>,
  isCreate: boolean,
): Result<
  {
    name?: string;
    ports?: { port: number; protocol: 'tcp' | 'udp' }[];
    enabled?: boolean;
  },
  AppError
> {
  const output: {
    name?: string;
    ports?: { port: number; protocol: 'tcp' | 'udp' }[];
    enabled?: boolean;
  } = {};

  if (body.name !== undefined || isCreate) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '') {
      return err(new AppError(ErrorCode.VALIDATION_FAILED, '隧道名称不能为空', { field: 'name' }));
    }
    if (name.length > 64) {
      return err(
        new AppError(ErrorCode.VALIDATION_FAILED, '隧道名称不能超过 64 字符', { field: 'name' }),
      );
    }
    output.name = name;
  }

  if (body.ports !== undefined) {
    const ports = validateTunnelPorts(body.ports);
    if (!ports.ok) {
      return err(new AppError(ErrorCode.VALIDATION_FAILED, ports.message, { field: 'ports' }));
    }
    output.ports = ports.value;
  } else if (isCreate) {
    output.ports = [];
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return err(
        new AppError(ErrorCode.VALIDATION_FAILED, 'enabled 必须是布尔值', { field: 'enabled' }),
      );
    }
    output.enabled = body.enabled;
  }

  return ok(output);
}

/* -------------------------------- 路由 -------------------------------- */

async function handleRoutes(
  request: Request,
  env: Env,
  method: string,
  rest: string[],
): Promise<Response> {
  const [id] = rest;

  if (id === undefined && method === 'GET') {
    return Response.json({ routes: await routesRegistry.listRoutes(env) });
  }

  if (id === undefined && method === 'POST') {
    const body = await readJson(request);
    const parsed = parseRouteBody(body, true);
    if (!parsed.ok) {
      throw parsed.error;
    }
    const result = await routesRegistry.createRoute(env, {
      slug: parsed.value.slug as string,
      tunnelId: parsed.value.tunnelId as string,
      targetHost: parsed.value.targetHost as string,
      targetPort: parsed.value.targetPort as number,
      enabled: parsed.value.enabled,
    });
    if (!result.ok) {
      throw result.error;
    }
    return Response.json({ route: result.value }, { status: 201 });
  }

  if (id !== undefined && method === 'PUT') {
    const body = await readJson(request);
    const parsed = parseRouteBody(body, false);
    if (!parsed.ok) {
      throw parsed.error;
    }
    const result = await routesRegistry.updateRoute(env, id, parsed.value);
    if (!result.ok) {
      throw result.error;
    }
    return Response.json({ route: result.value });
  }

  if (id !== undefined && method === 'DELETE') {
    const result = await routesRegistry.deleteRoute(env, id);
    if (!result.ok) {
      throw result.error;
    }
    return Response.json({ ok: true });
  }

  throw new AppError(ErrorCode.NOT_FOUND, '接口不存在');
}

function parseRouteBody(
  body: Record<string, unknown>,
  isCreate: boolean,
): Result<
  {
    slug?: string;
    tunnelId?: string;
    targetHost?: string;
    targetPort?: number;
    enabled?: boolean;
  },
  AppError
> {
  const output: {
    slug?: string;
    tunnelId?: string;
    targetHost?: string;
    targetPort?: number;
    enabled?: boolean;
  } = {};

  if (body.slug !== undefined || isCreate) {
    const slug = validateSlug(body.slug);
    if (!slug.ok) {
      return err(new AppError(ErrorCode.VALIDATION_FAILED, slug.message, { field: 'slug' }));
    }
    output.slug = slug.value;
  }

  if (body.tunnelId !== undefined || isCreate) {
    const tunnelId = validateUuid(body.tunnelId);
    if (!tunnelId.ok) {
      return err(
        new AppError(ErrorCode.VALIDATION_FAILED, tunnelId.message, { field: 'tunnelId' }),
      );
    }
    output.tunnelId = tunnelId.value;
  }

  if (body.targetHost !== undefined || isCreate) {
    const host = validateTargetHost(body.targetHost);
    if (!host.ok) {
      return err(new AppError(ErrorCode.VALIDATION_FAILED, host.message, { field: 'targetHost' }));
    }
    // 在这里就拒绝公网地址，而不是等到转发时才拒。
    // 理由：让管理员在配置时就拿到明确反馈，而不是等到用户访问失败才发现；
    // 同时这是一道独立的防线 —— 转发层也会再判一次，两层都不依赖对方。
    if (!isTargetHostAllowed(host.value)) {
      return err(
        new AppError(
          ErrorCode.FORBIDDEN,
          `目标地址 ${host.value} 不在允许的内网范围内。只允许回环地址与私有网段，` +
            '否则本服务会变成可被滥用的开放代理。',
          { field: 'targetHost' },
        ),
      );
    }
    output.targetHost = host.value;
  }

  if (body.targetPort !== undefined || isCreate) {
    const port = validatePort(body.targetPort);
    if (!port.ok) {
      return err(new AppError(ErrorCode.VALIDATION_FAILED, port.message, { field: 'targetPort' }));
    }
    output.targetPort = port.value;
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return err(
        new AppError(ErrorCode.VALIDATION_FAILED, 'enabled 必须是布尔值', { field: 'enabled' }),
      );
    }
    output.enabled = body.enabled;
  }

  return ok(output);
}

/* ------------------------------ 主机端 agent ------------------------------ */

async function handleAgents(env: Env, method: string, rest: string[]): Promise<Response> {
  if (rest.length > 0) {
    throw new AppError(ErrorCode.NOT_FOUND, '接口不存在');
  }
  if (method !== 'GET') {
    throw new AppError(ErrorCode.NOT_FOUND, '接口不存在');
  }
  return Response.json({ agents: await agentRegistry.listAgents(env) });
}

/* -------------------------------- 系统 -------------------------------- */

async function handleSystem(request: Request, method: string, rest: string[]): Promise<Response> {
  const [action] = rest;

  // GET /api/v1/system/endpoints —— 主机端与门户需要的接入地址。
  // 由服务端给出而不是让前端自己拼，避免协议（ws/wss）判断出现分歧。
  if (action === 'endpoints' && method === 'GET') {
    const origin = resolveOrigin(request);
    return Response.json({
      agentUrl: resolveAgentUrl(origin),
      signalingUrl: resolveSignalingUrl(origin),
    });
  }

  throw new AppError(ErrorCode.NOT_FOUND, '接口不存在');
}

/* ------------------------------- 工具 ------------------------------- */

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new AppError(ErrorCode.INVALID_REQUEST, '请求体必须是 JSON 对象');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(ErrorCode.INVALID_REQUEST, '请求体不是合法的 JSON');
  }
}

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

function buildCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowed = env.NT_ADMIN_ORIGIN ?? '';
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
  };

  // 仅回显白名单内的来源；未配置时回显请求来源（本地开发便利），
  // 生产环境必须显式配置 NT_ADMIN_ORIGIN。
  if (origin !== null) {
    if (allowed === '' || origin === allowed) {
      headers['Access-Control-Allow-Origin'] = origin;
    }
  }

  return headers;
}

export { SESSION_COOKIE };
