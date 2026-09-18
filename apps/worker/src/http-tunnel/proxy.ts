import {
  MAX_TUNNEL_RESPONSE_BYTES,
  isPortAllowed,
  isTargetHostAllowed,
  type Route,
  type TunnelPort,
} from '@nodetunnel/shared';

import type { Env } from '../env.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import * as registry from '../nodetunnel/registry.js';
import { signalingRoomName } from '../signaling/object-name.js';
import {
  RELAY_SLUG_HEADER,
  RELAY_TARGET_HOST_HEADER,
  RELAY_TARGET_PORT_HEADER,
} from '../signaling/headers.js';

/**
 * HTTP 隧道转发（中继回落路径）。
 *
 * 请求流程：
 *   浏览器 --GET /path--> Worker --(信令房间)-- 主机端 agent --(本地连接)--> 内网服务
 *
 * 为什么经 Durable Object 而不是直连：
 *   Worker 无法主动向主机端发起连接（主机端在内网、没有公网入口）。
 *   主机端主动连上 Worker 的信令房间并保持长连接，Worker 把请求
 *   顺着这条连接下发 —— 这就是「中继回落」的实现。
 *
 * 与 P2P 的关系：
 *   浏览器门户可以尝试用 WebRTC 直连主机端 agent；打洞成功时
 *   请求不经过本模块。但实测本机网络为对称 NAT，打洞成功率低，
 *   因此本模块是常态路径，不是异常兜底。
 *
 * 入口只有「专属域名」一种：应用跑在自己 origin 的根路径上，
 * 它发出的绝对路径（/js/app.js、/api/xxx）与浏览器实际请求的路径一致，
 * 因此任何项目接上就能跑，无需改应用代码。
 * 曾经存在的 `/t/<slug>/` 前缀入口已移除：前缀必须被剥离才能交给应用，
 * 而应用发出的绝对路径不带前缀，必然 404 —— 那条入口只能服务
 * 「纯相对路径」的页面，保留它只会让人误以为能用。
 *
 * 限制：仅支持 HTTP 明文服务；HTTPS 目标需由主机端侧自行终止 TLS。
 */

/**
 * 专属域名入口。
 *
 * 路径与查询串原样透传：任何「补前缀」或「剥前缀」的动作都会破坏
 * 应用自己发出的绝对路径。
 */
export async function handleHostRequest(
  request: Request,
  env: Env,
  route: Route,
): Promise<Response> {
  const tunnel = await registry.findTunnel(env, route.tunnelId);
  if (tunnel === undefined) {
    throw new AppError(ErrorCode.NOT_FOUND, '该路由所属的隧道不存在');
  }
  if (!tunnel.enabled) {
    throw new AppError(ErrorCode.TUNNEL_DISABLED);
  }

  // 安全边界在这里把关（业务层决策）。
  // 主机端会再次独立校验一次 —— 不信任 Worker 的结论，两边都拦。
  ensureTargetAllowed(tunnel.ports, route.targetHost, route.targetPort);

  const url = new URL(request.url);
  return forwardViaRoom(request, env, tunnel.id, route, url.search);
}

/**
 * 校验转发目标是否在白名单与允许的地址范围内。
 *
 * 两条都必须过：端口未声明一律拒绝；地址必须是内网/回环，
 * 否则这套系统会变成开放的匿名代理。
 */
function ensureTargetAllowed(ports: TunnelPort[], targetHost: string, targetPort: number): void {
  if (!isPortAllowed(ports, targetPort, 'tcp')) {
    throw new AppError(ErrorCode.FORBIDDEN, `端口 ${targetPort} 未在隧道端口白名单中放行`, {
      port: targetPort,
    });
  }
  if (!isTargetHostAllowed(targetHost)) {
    throw new AppError(ErrorCode.FORBIDDEN, `目标地址 ${targetHost} 不在允许的内网范围内`, {
      host: targetHost,
    });
  }
}

/**
 * 把请求投递给信令房间，由它转交主机端。
 *
 * 目标地址通过请求头传给 DO —— DO 是基础层，不认识「路由」概念，
 * 只按给定地址转发，业务决策留在这里。
 */
async function forwardViaRoom(
  request: Request,
  env: Env,
  tunnelId: string,
  route: { slug: string; targetHost: string; targetPort: number },
  search: string,
): Promise<Response> {
  const room = env.SIGNALING_ROOM.getByName(signalingRoomName(tunnelId));

  // 保留原始路径：专属域名下应用就挂在根路径上。
  const upstream = new URL(request.url);
  upstream.search = search;

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('upgrade');
  headers.delete('keep-alive');
  headers.delete('transfer-encoding');
  headers.set(RELAY_TARGET_HOST_HEADER, route.targetHost);
  headers.set(RELAY_TARGET_PORT_HEADER, String(route.targetPort));
  headers.set(RELAY_SLUG_HEADER, route.slug);

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    // @ts-expect-error Cloudflare Workers 要求流式请求显式声明 duplex。
    init.duplex = 'half';
  }

  let response: Response;
  try {
    response = await room.fetch(new Request(upstream.toString(), init));
  } catch (error) {
    logger.warn('tunnel_forward_failed', {
      slug: route.slug,
      target: `${route.targetHost}:${route.targetPort}`,
      error: String(error),
    });
    throw new AppError(
      ErrorCode.AGENT_OFFLINE,
      `无法访问目标服务 ${route.targetHost}:${route.targetPort}。请确认主机端已接入。`,
      { slug: route.slug },
    );
  }

  return buildDownstreamResponse(response, route.slug);
}

/**
 * 构造回传给浏览器的响应。
 *
 * 房间已经剥离过逐跳头，这里只做体量检查并补一个来源标记。
 */
function buildDownstreamResponse(upstream: Response, slug: string): Response {
  const headers = new Headers(upstream.headers);
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
