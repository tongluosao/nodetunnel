import {
  ADMIN_API_PREFIX,
  SESSION_COOKIE,
  validateNetworkName,
  validateNetworkSecret,
  validatePassword,
  validatePort,
  validateRelayUrl,
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
import * as nodeRegistry from '../nodetunnel/node-registry.js';
import { resolveConfigServerUrl, resolveOrigin, resolveRelayUrl } from '../nodetunnel/endpoints.js';
import * as queries from '../db/queries.js';
import { NODE_ONLINE_WINDOW_SECONDS } from '@nodetunnel/shared';
import { renderTunnelNodeConfig } from '@nodetunnel/protocol';
import { relayObjectName } from '../relay/app.js';

/**
 * 管理 API（接入层 + 业务编排）。
 *
 * 路由表与 easytier-web 的 /api/v1 保持一致，使普通 EasyTier 客户端
 * 无需修改即可通过 `--config-server` 拉取配置。
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
    const response = await dispatch(request, env, method, path, url.searchParams);
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
  query: URLSearchParams,
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

  // ------------------------------------------------------------ 配置服务器
  // 普通 EasyTier 客户端通过此端点拉取配置（与 easytier-web 对齐）。
  if (head === 'machines') {
    return handleMachines(request, env, method, rest);
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

    case 'nodes':
      return handleNodes(env, method, rest);

    case 'system':
      return handleSystem(env, method, rest, query);

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
  const token = await (
    await import('./auth.js')
  ).login(env, {
    username: username.value,
    password: password.value,
  });
  if (!token.ok) {
    // 理论上不会发生；发生则要求用户手动登录。
    return Response.json({ admin: result.value });
  }

  return Response.json(
    { admin: result.value },
    { headers: { 'Set-Cookie': buildSessionCookie(token.value.token, isSecureRequest(request)) } },
  );
}

/* --------------------------- 配置下发（客户端） --------------------------- */

/**
 * 与 easytier-web 对齐的配置拉取端点。
 *
 * 普通 EasyTier 客户端使用：
 *   GET /api/v1/machines/:machine-id/networks/config/:inst-id
 * 拉取自身配置。返回的配置已自动填入中继地址、组网名与组网密钥，
 * 并按隧道声明的端口白名单收紧 ACL（默认拒绝入站）。
 */
async function handleMachines(
  request: Request,
  env: Env,
  method: string,
  rest: string[],
): Promise<Response> {
  // rest: [machineId, 'networks', 'config', instId]
  if (rest.length < 4 || rest[1] !== 'networks' || rest[2] !== 'config') {
    throw new AppError(ErrorCode.NOT_FOUND, '接口不存在');
  }

  const machineId = validateUuid(rest[0]);
  if (!machineId.ok) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, machineId.message, { field: 'machine-id' });
  }
  const instId = validateUuid(rest[3]);
  if (!instId.ok) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, instId.message, { field: 'inst-id' });
  }

  if (method !== 'GET') {
    throw new AppError(ErrorCode.NOT_FOUND, '仅支持 GET');
  }

  // 客户端通过查询参数声明它要接入的隧道组网名。
  const networkName = new URL(request.url).searchParams.get('network');
  const networkCheck = validateNetworkName(networkName);
  if (!networkCheck.ok) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, '缺少或非法的 network 查询参数', {
      field: 'network',
    });
  }

  const tunnel = await registry.loadTunnelByNetworkName(env, networkCheck.value);
  if (!tunnel.ok) {
    throw tunnel.error;
  }
  if (!tunnel.value.enabled) {
    throw new AppError(ErrorCode.TUNNEL_DISABLED);
  }

  const origin = resolveOrigin(request);
  const config = renderTunnelNodeConfig({
    instanceId: instId.value,
    instanceName: `node-${instId.value.slice(0, 8)}`,
    networkName: tunnel.value.networkName,
    networkSecret: tunnel.value.networkSecret,
    relayUrl: resolveRelayUrl(origin, tunnel.value.networkName),
    ports: tunnel.value.ports,
  });

  // 记录归属关系，供心跳与后台展示使用。
  await queries.bindNodeToTunnel(env.DB, instId.value, tunnel.value.id, Date.now());

  logger.info('network_config_served', {
    machineId: machineId.value,
    instId: instId.value,
    tunnelId: tunnel.value.id,
  });

  // 返回纯文本 TOML：客户端将其作为实例配置使用。
  return new Response(config, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/* ------------------------------- 仪表盘 ------------------------------- */

async function dashboardStats(env: Env): Promise<DashboardStats & { relayUrl: string }> {
  const since = Date.now() - NODE_ONLINE_WINDOW_SECONDS * 1000;
  const [tunnelCount, routeCount, nodeCount, onlineNodeCount] = await Promise.all([
    queries.countTunnels(env.DB),
    queries.countRoutes(env.DB),
    queries.countNodes(env.DB),
    queries.countOnlineNodes(env.DB, since),
  ]);

  return {
    tunnelCount,
    routeCount,
    nodeCount,
    onlineNodeCount,
    // 中继连接数需要探测 Durable Object；此处返回 0，由 /system/relay-health 单独查询。
    relayConnections: 0,
    relayUrl: resolveConfigServerUrl('http://placeholder'),
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

  // POST /api/v1/tunnels —— 新建
  if (id === undefined && method === 'POST') {
    const body = await readJson(request);
    const parsed = parseCreateTunnelBody(body);
    if (!parsed.ok) {
      throw parsed.error;
    }
    // 未显式指定中继地址时，使用本 Worker 自身的中继。
    const relayUrl =
      parsed.value.relayUrl === ''
        ? resolveRelayUrl(resolveOrigin(request), parsed.value.networkName)
        : parsed.value.relayUrl;

    const result = await registry.createTunnel(env, {
      name: parsed.value.name,
      networkName: parsed.value.networkName,
      networkSecret: parsed.value.networkSecret,
      relayUrl,
      ports: parsed.value.ports,
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

  // GET /api/v1/tunnels/:id/config —— 预览下发给客户端的配置
  if (sub === 'config' && method === 'GET') {
    const tunnel = await registry.loadTunnelWithSecret(env, id);
    if (!tunnel.ok) {
      throw tunnel.error;
    }

    const origin = resolveOrigin(request);
    const instanceId = new URL(request.url).searchParams.get('instance-id') ?? crypto.randomUUID();
    const config = renderTunnelNodeConfig({
      instanceId,
      instanceName: `node-${instanceId.slice(0, 8)}`,
      networkName: tunnel.value.networkName,
      networkSecret: tunnel.value.networkSecret,
      relayUrl: resolveRelayUrl(origin, tunnel.value.networkName),
      ports: tunnel.value.ports,
    });

    // 预览会包含明文组网密钥，仅供已登录管理员查看。
    return new Response(config, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  throw new AppError(ErrorCode.NOT_FOUND, '接口不存在');
}

/**
 * 解析「新建隧道」请求体。
 *
 * 与更新不同，创建时所有关键字段都是必填的，
 * 因此这里返回字段齐全的类型，交由类型系统保证调用点不会漏填。
 */
function parseCreateTunnelBody(body: Record<string, unknown>): Result<
  {
    name: string;
    networkName: string;
    networkSecret: string;
    relayUrl: string;
    ports: { port: number; protocol: 'tcp' | 'udp' }[];
    enabled: boolean;
  },
  AppError
> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') {
    return err(new AppError(ErrorCode.VALIDATION_FAILED, '隧道名称不能为空', { field: 'name' }));
  }
  if (name.length > 64) {
    return err(
      new AppError(ErrorCode.VALIDATION_FAILED, '隧道名称不能超过 64 字符', { field: 'name' }),
    );
  }

  const networkName = validateNetworkName(body.networkName);
  if (!networkName.ok) {
    return err(
      new AppError(ErrorCode.VALIDATION_FAILED, networkName.message, { field: 'networkName' }),
    );
  }

  const networkSecret = validateNetworkSecret(body.networkSecret);
  if (!networkSecret.ok) {
    return err(
      new AppError(ErrorCode.VALIDATION_FAILED, networkSecret.message, { field: 'networkSecret' }),
    );
  }

  // relayUrl 允许省略：省略时由调用方填入本 Worker 自身的中继地址。
  let relayUrl = '';
  if (body.relayUrl !== undefined) {
    const relay = validateRelayUrl(body.relayUrl);
    if (!relay.ok) {
      return err(new AppError(ErrorCode.VALIDATION_FAILED, relay.message, { field: 'relayUrl' }));
    }
    relayUrl = relay.value;
  }

  const ports = validateTunnelPorts(body.ports ?? []);
  if (!ports.ok) {
    return err(new AppError(ErrorCode.VALIDATION_FAILED, ports.message, { field: 'ports' }));
  }

  let enabled = true;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return err(
        new AppError(ErrorCode.VALIDATION_FAILED, 'enabled 必须是布尔值', { field: 'enabled' }),
      );
    }
    enabled = body.enabled;
  }

  return ok({
    name,
    networkName: networkName.value,
    networkSecret: networkSecret.value,
    relayUrl,
    ports: ports.value,
    enabled,
  });
}

/** 解析并校验隧道请求体。isCreate 为 true 时要求必填字段齐全。 */
function parseTunnelBody(
  body: Record<string, unknown>,
  isCreate: boolean,
): Result<
  {
    name?: string;
    networkName?: string;
    networkSecret?: string;
    relayUrl?: string;
    ports?: { port: number; protocol: 'tcp' | 'udp' }[];
    enabled?: boolean;
  },
  AppError
> {
  const output: {
    name?: string;
    networkName?: string;
    networkSecret?: string;
    relayUrl?: string;
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

  if (body.networkName !== undefined || isCreate) {
    const networkName = validateNetworkName(body.networkName);
    if (!networkName.ok) {
      return err(
        new AppError(ErrorCode.VALIDATION_FAILED, networkName.message, { field: 'networkName' }),
      );
    }
    output.networkName = networkName.value;
  }

  if (body.networkSecret !== undefined || isCreate) {
    const secret = validateNetworkSecret(body.networkSecret);
    if (!secret.ok) {
      return err(
        new AppError(ErrorCode.VALIDATION_FAILED, secret.message, { field: 'networkSecret' }),
      );
    }
    output.networkSecret = secret.value;
  }

  if (body.relayUrl !== undefined) {
    const relay = validateRelayUrl(body.relayUrl);
    if (!relay.ok) {
      return err(new AppError(ErrorCode.VALIDATION_FAILED, relay.message, { field: 'relayUrl' }));
    }
    output.relayUrl = relay.value;
  } else if (isCreate) {
    // 创建时允许省略，表示使用本 Worker 自身的中继。
    output.relayUrl = undefined;
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

/* -------------------------------- 节点 -------------------------------- */

async function handleNodes(env: Env, method: string, rest: string[]): Promise<Response> {
  if (rest.length > 0) {
    throw new AppError(ErrorCode.NOT_FOUND, '接口不存在');
  }
  if (method !== 'GET') {
    throw new AppError(ErrorCode.NOT_FOUND, '接口不存在');
  }
  return Response.json({ nodes: await nodeRegistry.listNodes(env) });
}

/* -------------------------------- 系统 -------------------------------- */

async function handleSystem(
  env: Env,
  method: string,
  rest: string[],
  query: URLSearchParams,
): Promise<Response> {
  const [action] = rest;

  if (action === 'config-server' && method === 'GET') {
    const origin = query.get('origin') ?? 'http://127.0.0.1:8787';
    return Response.json({ url: resolveConfigServerUrl(origin) });
  }

  if (action === 'relay-health' && method === 'GET') {
    const network = query.get('network') ?? '';
    try {
      // 复用中继处理器导出的对象名解析，确保与真实中继路由到同一个 Durable Object。
      const response = await env.EASYTIER_RELAY.getByName(relayObjectName(network)).fetch(
        new Request('https://internal/health', { method: 'GET' }),
      );
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return Response.json({ ok: response.ok, ...body }, { status: 200 });
    } catch (error) {
      logger.warn('relay_health_probe_failed', {
        network,
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json({ ok: false, state: 'stopped', connections: 0 });
    }
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
