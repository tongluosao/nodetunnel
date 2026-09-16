import { AGENT_PATH, SIGNALING_PATH } from '@nodetunnel/shared';

/**
 * 环境派生值。
 *
 * 集中放置「由环境变量推导出的地址」，避免各处重复拼接，
 * 也确保主机端 agent 与浏览器门户看到的是同一个信令地址。
 */

/** 从请求推断本 Worker 的对外来源（协议 + 主机）。 */
export function resolveOrigin(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

/**
 * 把 HTTP 来源转换为 WebSocket 来源。
 *
 * 浏览器强制要求安全上下文，因此非本地地址一律使用 wss。
 */
export function toWebSocketOrigin(origin: string): string {
  const url = new URL(origin);
  const protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return `${protocol}//${url.host}`;
}

/** 主机端 agent 的信令地址。 */
export function resolveAgentUrl(origin: string): string {
  return `${toWebSocketOrigin(origin)}${AGENT_PATH}`;
}

/** 浏览器访客的信令地址。 */
export function resolveSignalingUrl(origin: string): string {
  return `${toWebSocketOrigin(origin)}${SIGNALING_PATH}`;
}
