import { AGENT_PATH, SIGNALING_PATH } from '@nodetunnel/shared';

import type { Env } from '../env.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { authenticateTunnelToken } from './registry.js';
import { findEnabledRouteBySlug } from './routes.js';
import { signalingRoomName } from '../signaling/object-name.js';
import { ROLE_HEADER, ROLE_HOST, ROLE_VISITOR } from '../signaling/roles.js';
import {
  HOSTNAME_HEADER,
  ROUTE_SLUG_HEADER,
  TUNNEL_ID_HEADER,
  TUNNEL_PORTS_HEADER,
  VERSION_HEADER,
} from '../signaling/headers.js';

/**
 * 信令接入网关（业务层）。
 *
 * 本模块是「谁能进哪个房间」的唯一决策点：
 *   - 主机端：凭接入令牌证明自己属于某个 tunnel；
 *   - 访客：凭一个已启用的路由 slug 找到它所属的 tunnel。
 * 校验通过后把身份写进请求头，交给 Durable Object 只做投递。
 *
 * 把鉴权放在这里的理由：Durable Object 是基础层，按分层约定
 * 不应认识「隧道」「路由」这些业务概念，也不该直接读数据库。
 */

/** 判断是否为主机端接入请求。 */
export function isAgentPath(path: string): boolean {
  return path === AGENT_PATH || path.startsWith(`${AGENT_PATH}/`);
}

/** 判断是否为访客信令请求。 */
export function isSignalingPath(path: string): boolean {
  return path === SIGNALING_PATH || path.startsWith(`${SIGNALING_PATH}/`);
}

/**
 * 主机端接入。
 *
 * 令牌通过 `Authorization: Bearer <token>` 传递。
 * 不用 URL 查询参数：那会让令牌进入各级访问日志与浏览器历史。
 */
export async function handleAgentConnect(request: Request, env: Env): Promise<Response> {
  const token = readBearerToken(request);
  if (token === undefined) {
    throw new AppError(ErrorCode.UNAUTHORIZED, '缺少接入令牌');
  }

  const tunnel = await authenticateTunnelToken(env, token);
  if (tunnel === undefined) {
    // 不区分「令牌不存在」与「隧道已禁用」，避免通过响应差异枚举令牌。
    logger.warn('agent_token_rejected', {});
    throw new AppError(ErrorCode.UNAUTHORIZED, '接入令牌无效');
  }

  const headers: Record<string, string> = {
    [ROLE_HEADER]: ROLE_HOST,
    [TUNNEL_ID_HEADER]: tunnel.id,
    [TUNNEL_PORTS_HEADER]: JSON.stringify(tunnel.ports.map((item) => item.port)),
  };
  // 主机名与版本仅用于后台展示，属于非关键信息，缺失不影响接入。
  const hostname = request.headers.get(HOSTNAME_HEADER);
  if (hostname !== null) {
    headers[HOSTNAME_HEADER] = hostname;
  }
  const version = request.headers.get(VERSION_HEADER);
  if (version !== null) {
    headers[VERSION_HEADER] = version;
  }

  return forwardToRoom(request, env, tunnel.id, headers);
}

/**
 * 访客信令接入。
 *
 * 访客只需要知道自己要访问的路由 slug（就是它正在访问的 URL 前缀），
 * 不需要任何凭据 —— 访问权限由「路由是否启用」决定，
 * 这与其他 Web 服务的公开可访问性预期一致。
 */
export async function handleVisitorConnect(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const slug = (url.searchParams.get('slug') ?? '').trim().toLowerCase();
  if (slug === '') {
    throw new AppError(ErrorCode.INVALID_REQUEST, '缺少 slug 参数');
  }

  const route = await findEnabledRouteBySlug(env, slug);
  if (route === undefined) {
    throw new AppError(ErrorCode.NOT_FOUND, `路由 ${slug} 不存在或已禁用`);
  }

  return forwardToRoom(request, env, route.tunnelId, {
    [ROLE_HEADER]: ROLE_VISITOR,
    [TUNNEL_ID_HEADER]: route.tunnelId,
    [ROUTE_SLUG_HEADER]: slug,
  });
}

/**
 * 把请求转发给对应 tunnel 的房间。
 *
 * 用 stub.fetch 而不是直接构造响应：WebSocket 升级必须由 DO 完成，
 * 只有它持有 acceptWebSocket 的能力。
 */
async function forwardToRoom(
  request: Request,
  env: Env,
  tunnelId: string,
  headers: Record<string, string>,
): Promise<Response> {
  const room = env.SIGNALING_ROOM.getByName(signalingRoomName(tunnelId));

  const forwarded = new Request(request.url, request);
  for (const [name, value] of Object.entries(headers)) {
    forwarded.headers.set(name, value);
  }

  try {
    return await room.fetch(forwarded);
  } catch (error) {
    logger.error('signaling_forward_failed', { tunnelId, error: String(error) });
    throw new AppError(ErrorCode.AGENT_OFFLINE, '信令房间当前不可用');
  }
}

/** 从 Authorization 头读取 Bearer 令牌。 */
function readBearerToken(request: Request): string | undefined {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}
