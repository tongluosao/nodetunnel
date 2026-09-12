import { CONFIG_SERVER_PATH, NODE_ONLINE_WINDOW_SECONDS, ROUTE_PREFIX } from '@nodetunnel/shared';

import type { Env } from './env.js';
import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { handleAdminApi } from './admin/router.js';
import { handleConfigServer } from './config-server/handler.js';
import { handleTunnelRequest } from './http-tunnel/proxy.js';
import { handleRelay, handleRelayHealth } from './relay/handler.js';
import { handleHome } from './home.js';

/**
 * Worker 入口（接入层）。
 *
 * 职责仅限于：
 *   1. 路径分发；
 *   2. WebSocket 升级请求与普通 HTTP 请求的分流；
 *   3. 顶层异常兜底，把 AppError 转为结构化 JSON 响应。
 *
 * 具体业务逻辑一律下沉到 src/nodetunnel、src/admin、src/http-tunnel。
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 1. 中继健康检查（必须先于中继本身，避免被当作 WebSocket 升级处理）。
      if (path === '/relay/health') {
        return await handleRelayHealth(request, env);
      }

      // 2. EasyTier 中继：WebSocket 升级请求。
      if (path === '/relay' || path.startsWith('/relay/')) {
        return await handleRelay(request, env);
      }

      // 3. 配置服务器：EasyTier 客户端通过 WebSocket 上报心跳。
      if (path === CONFIG_SERVER_PATH) {
        return await handleConfigServer(request, env);
      }

      // 4. 管理 API。
      if (path.startsWith('/api/v1')) {
        return await handleAdminApi(request, env, ctx);
      }

      // 5. 隧道访问：/t/<slug>/...
      if (path === ROUTE_PREFIX || path.startsWith(`${ROUTE_PREFIX}/`)) {
        return await handleTunnelRequest(request, env);
      }

      // 6. 首页与运行状态。
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

/** 供测试与文档引用：节点在线判定窗口。 */
export const onlineWindowSeconds = NODE_ONLINE_WINDOW_SECONDS;
