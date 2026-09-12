import {
  MAX_TUNNEL_RESPONSE_BYTES,
  ROUTE_PREFIX,
  UPSTREAM_TIMEOUT_MS,
} from '@nodetunnel/shared';

import type { Env } from '../env.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import * as registry from '../nodetunnel/registry.js';
import * as routesRegistry from '../nodetunnel/routes.js';
import { resolveRelayUrl } from '../nodetunnel/endpoints.js';

/**
 * HTTP 隧道转发（需求 3 的中继路径）。
 *
 * 请求流程：
 *   浏览器 --GET /t/<slug>/path--> Worker --(EasyTier 虚拟网)--> 隧道节点上的 HTTP 服务
 *
 * 实现方式：
 *   Worker 已通过中继与隧道节点处于同一 EasyTier 虚拟局域网。
 *   本模块把用户的 HTTP 请求转换为对目标虚拟 IP:端口 的请求，并把响应流式回传。
 *
 * 限制（浏览器权限所致，已在 AGENTS.md 说明）：
 *   仅支持 HTTP 明文服务；HTTPS 目标需要隧道侧自行终止 TLS。
 */

export async function handleTunnelRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // 解析 /t/<slug>/<rest...>
  const remainder = url.pathname.slice(ROUTE_PREFIX.length);
  const segments = remainder.split('/').filter((segment) => segment !== '');

  if (segments.length === 0) {
    // 访问 /t 本身：列出可用路由，便于人工排查。
    const routes = await routesRegistry.listRoutes(env);
    return Response.json({
      service: 'nodetunnel',
      routes: routes
        .filter((route) => route.enabled)
        .map((route) => ({
          slug: route.slug,
          url: `${ROUTE_PREFIX}/${route.slug}/`,
          target: `${route.targetHost}:${route.targetPort}`,
        })),
    });
  }

  const slug = (segments[0] as string).toLowerCase();
  const rest = segments.slice(1);

  const route = await routesRegistry.findEnabledRouteBySlug(env, slug);
  if (route === undefined) {
    throw new AppError(ErrorCode.NOT_FOUND, `路由 /${ROUTE_PREFIX}/${slug} 不存在或已禁用`);
  }

  const tunnel = await registry.findTunnel(env, route.tunnelId);
  if (tunnel === undefined) {
    throw new AppError(ErrorCode.NOT_FOUND, '该路由所属的隧道不存在');
  }
  if (!tunnel.enabled) {
    throw new AppError(ErrorCode.TUNNEL_DISABLED);
  }

  return forwardToTunnel(request, tunnel.networkName, route, rest, url.search);
}

/**
 * 把请求转发到隧道内的目标服务。
 *
 * 目标地址为「虚拟 IP + 端口」。EasyTier 会把发往虚拟网段的流量
 * 通过中继或 P2P 通道送到隧道节点，因此在 Worker 侧表现为一次普通的
 * 内网 HTTP 请求。
 *
 * 注意：目标主机必须是虚拟网内的地址（如 10.144.144.x）。
 * 若管理员填写了公网地址，则该请求会绕过隧道直接访问，
 * 这不是预期行为 —— 因此在配置校验阶段已在文档中说明。
 */
async function forwardToTunnel(
  request: Request,
  networkName: string,
  route: { slug: string; targetHost: string; targetPort: number },
  rest: string[],
  search: string,
): Promise<Response> {
  const upstreamUrl = buildUpstreamUrl(route, rest, search);

  // 复制请求头，去掉逐跳头与 Host。
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('upgrade');
  headers.delete('keep-alive');
  headers.delete('transfer-encoding');
  // 标记来源，便于隧道侧识别请求经由 nodetunnel 转发。
  headers.set('X-Forwarded-Host', new URL(request.url).host);
  headers.set('X-Nodentunnel-Route', route.slug);

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  // GET/HEAD 不允许带 body。
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    // @ts-expect-error Cloudflare Workers 要求流式请求显式声明 duplex。
    init.duplex = 'half';
  }

  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { ...init, signal: timeoutSignal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = message.toLowerCase().includes('timed out') || timeoutSignal.aborted;

    logger.warn('tunnel_forward_failed', {
      slug: route.slug,
      network: networkName,
      target: `${route.targetHost}:${route.targetPort}`,
      timeout: isTimeout,
      error: message,
    });

    throw new AppError(
      isTimeout ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_ERROR,
      isTimeout
        ? `访问目标服务超时（${route.targetHost}:${route.targetPort}）。请确认隧道节点在线且服务已启动。`
        : `无法连接目标服务 ${route.targetHost}:${route.targetPort}。请确认隧道节点已接入且端口已在白名单中放行。`,
      { slug: route.slug },
    );
  }

  return buildDownstreamResponse(upstream, route.slug);
}

function buildUpstreamUrl(
  route: { targetHost: string; targetPort: number },
  rest: string[],
  search: string,
): string {
  const path = rest.length === 0 ? '/' : `/${rest.join('/')}`;
  // 目标服务始终使用 HTTP（浏览器端无法在隧道内终止 TLS）。
  const url = new URL(`http://${route.targetHost}:${route.targetPort}${path}`);
  url.search = search;
  return url.toString();
}

/**
 * 构造回传给浏览器的响应。
 *
 * 逐跳头必须剥离；同时加入安全响应头，避免隧道内容
 * 在 nodetunnel 域名下获得过高的权限。
 */
function buildDownstreamResponse(upstream: Response, slug: string): Response {
  const headers = new Headers(upstream.headers);
  headers.delete('connection');
  headers.delete('keep-alive');
  headers.delete('transfer-encoding');
  headers.delete('upgrade');
  // 隧道内容可能来自不受信任的内网服务，禁止其提升为同源特权。
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Nodentunnel-Route', slug);

  const contentLength = headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_TUNNEL_RESPONSE_BYTES) {
    throw new AppError(
      ErrorCode.UPSTREAM_ERROR,
      `目标服务响应体过大（超过 ${Math.round(MAX_TUNNEL_RESPONSE_BYTES / 1024 / 1024)} MB）`,
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** 供管理后台展示使用：生成某隧道的访问前缀。 */
export function routePrefixFor(slug: string): string {
  return `${ROUTE_PREFIX}/${slug}`;
}

/** 中继地址推导（转发层需要与配置下发保持一致的地址）。 */
export function relayUrlFor(env: Env, origin: string, networkName: string): string {
  void env;
  return resolveRelayUrl(origin, networkName);
}
