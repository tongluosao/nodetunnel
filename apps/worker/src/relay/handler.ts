import { RELAY_PATH } from '@nodetunnel/shared';

import type { Env } from '../env.js';
import { logger } from '../lib/logger.js';
import { easytierRelay } from './app.js';

/**
 * 中继请求处理。
 *
 * 客户端（隧道节点与浏览器节点）通过
 *   wss://<worker-host>/relay?network=<组网名>
 * 接入中继。Worker 把请求转发给对应组网的 Durable Object。
 *
 * 职责边界：
 *   - 本函数只做「路径匹配 + 组网参数注入 + 转发」；
 *   - 中继协议本身（WebSocket 升级、EasyTier 帧）由上游实现处理。
 */
export async function handleRelay(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname !== RELAY_PATH && !url.pathname.startsWith(`${RELAY_PATH}/`)) {
    return new Response('Not found', { status: 404 });
  }

  // 构造交给 Durable Object 的请求：把组网名写入查询参数，
  // 供 app.ts 的 objectName 决定路由到哪个 DO 实例。
  const forwarded = new Request(url.toString(), request);

  try {
    return await easytierRelay.fetch(forwarded, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext);
  } catch (error) {
    logger.error('relay_forward_failed', {
      network: url.searchParams.get('network'),
      error: String(error),
    });
    // 与上游 app.ts 的错误语义保持一致：中继不可用时返回 503。
    return new Response('EasyTier 中继当前不可用', { status: 503 });
  }
}

/**
 * 中继健康检查。
 *
 * 直接询问对应组网的 Durable Object，返回 EasyTier 实例状态与连接数。
 * 返回值不会泄露组网密钥等敏感信息。
 */
export async function handleRelayHealth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const network = url.searchParams.get('network') ?? '';
  const healthUrl = new URL(request.url);
  healthUrl.pathname = '/health';

  try {
    const response = await easytierRelay.fetch(
      new Request(healthUrl.toString(), { method: 'GET' }),
      env,
      {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    );
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return Response.json({ ok: response.ok, network, ...body }, { status: response.status });
  } catch (error) {
    logger.error('relay_health_failed', { network, error: String(error) });
    return Response.json({ ok: false, state: 'stopped', connections: 0, network }, { status: 503 });
  }
}
