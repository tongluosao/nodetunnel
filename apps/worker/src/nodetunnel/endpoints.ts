import { DEFAULT_RELAY_NETWORK_NAME } from '@nodetunnel/shared';

import type { Env } from '../env.js';

/**
 * 环境派生值。
 *
 * 集中放置「由环境变量推导出的地址」，避免各处重复拼接，
 * 也确保浏览器节点、隧道节点与配置服务器看到的是同一个中继地址。
 */

/** 从请求推断本 Worker 的对外来源（协议 + 主机）。 */
export function resolveOrigin(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

/**
 * 中继 WebSocket 地址。
 *
 * 浏览器强制要求安全上下文，因此非本地地址一律使用 wss。
 * 组网名作为查询参数传给中继，用于选择对应的 Durable Object。
 */
export function resolveRelayUrl(origin: string, networkName: string): string {
  const url = new URL('/relay', origin);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.searchParams.set('network', networkName);
  return url.toString();
}

/** 配置服务器 WebSocket 地址，供普通 EasyTier 客户端 `--config-server` 使用。 */
export function resolveConfigServerUrl(origin: string): string {
  const url = new URL('/api/v1/config-server', origin);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return url.toString();
}

/** 中继自身使用的组网名（与业务隧道隔离）。 */
export function relayNetworkName(env: Env): string {
  return env.NT_RELAY_NETWORK_NAME || DEFAULT_RELAY_NETWORK_NAME;
}
