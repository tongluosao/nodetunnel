import { ADMIN_API_PREFIX, ROUTE_PREFIX } from '@nodetunnel/shared';

import type { Env } from './env.js';
import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { handleAdminApi } from './admin/router.js';
import { handleTunnelRequest } from './http-tunnel/proxy.js';
import {
  handleAgentConnect,
  handleVisitorConnect,
  isAgentPath,
  isSignalingPath,
} from './nodetunnel/signaling-gateway.js';
import { handleHome } from './home.js';

/**
 * Durable Object 类必须从入口文件导出，Wrangler 才会生成对应绑定。
 * 类名需与 wrangler.jsonc 中 durable_objects.bindings[].class_name 一致。
 */
export { SignalingRoom } from './signaling/room.js';

/**
 * Worker 入口（接入层）。
 *
 * 职责仅限于：
 *   1. 路径分发；
 *   2. WebSocket 升级请求与普通 HTTP 请求的分流；
 *   3. 顶层异常兜底，把 AppError 转为结构化 JSON 响应。
 *
 * 具体业务逻辑一律下沉到 src/nodetunnel、src/admin、src/http-tunnel、src/signaling。
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 1. 主机端 agent 的信令接入（需令牌）。
      if (isAgentPath(path)) {
        return await handleAgentConnect(request, env);
      }

      // 2. 浏览器访客的信令接入（按路由 slug）。
      if (isSignalingPath(path)) {
        return await handleVisitorConnect(request, env);
      }

      // 3. 管理 API。
      if (path.startsWith(ADMIN_API_PREFIX)) {
        return await handleAdminApi(request, env, ctx);
      }

      // 4. 隧道访问：/t/<slug>/...，经中继转发到主机端服务。
      if (path === ROUTE_PREFIX || path.startsWith(`${ROUTE_PREFIX}/`)) {
        return await handleTunnelRequest(request, env);
      }

      // 5. 首页与运行状态。
      return await handleHome(request, env);
    } catch (error) {
      return handleTopLevelError(error, path);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * 顶层异常兜底。
 *
 * - AppError：可预期的业务错误，返回其自带状态码与错误码；
 * - 其他异常：记录完整信息到日志，但只向客户端返回通用错误，
 *   避免泄露堆栈或内部结构。
 */
function handleTopLevelError(error: unknown, path: string): Response {
  if (error instanceof AppError) {
    if (error.status >= 500) {
      logger.error('request_failed', { path, code: error.code, message: error.message });
    } else {
      logger.warn('request_rejected', { path, code: error.code, message: error.message });
    }
    return Response.json(error.toBody(), { status: error.status });
  }

  logger.error('unhandled_error', {
    path,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return Response.json(
    { error: { code: 'internal_error', message: '服务内部错误' } },
    { status: 500 },
  );
}
