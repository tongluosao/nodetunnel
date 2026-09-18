import { ADMIN_API_PREFIX } from '@nodetunnel/shared';

import type { Env } from './env.js';
import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { handleAdminApi } from './admin/router.js';
import { serveAdminSpa } from './admin/spa.js';
import { handleHostRequest } from './http-tunnel/proxy.js';
import { normalizeHostname, resolveRouteForHost } from './nodetunnel/host-routing.js';
import {
  handleAgentConnect,
  handleVisitorConnect,
  isAgentPath,
  isSignalingPath,
} from './nodetunnel/signaling-gateway.js';
import { handleHealth, handleHome } from './home.js';

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
      //    信令路径在所有域名上都必须保留：否则把 agent 指向某个专属域名时，
      //    隧道会因为「域名被应用占用」而自己把自己挡掉。
      if (isAgentPath(path)) {
        return await handleAgentConnect(request, env);
      }

      // 2. 浏览器访客的信令接入（按路由 slug）。
      if (isSignalingPath(path)) {
        return await handleVisitorConnect(request, env);
      }

      // 3. 专属域名：该域名整站交给这条路由，应用跑在根路径上。
      //    必须排在管理 API 之前 —— 一个被占用的域名是「专用」的，
      //    若先匹配 /api/v1，应用自己的 /api/v1/* 就会被管理 API 截胡。
      const hostname = normalizeHostname(request.headers.get('Host') ?? url.hostname);
      const hostRoute = await resolveRouteForHost(env, hostname);
      if (hostRoute !== undefined) {
        return await handleHostRequest(request, env, hostRoute);
      }

      // 4. 运行状态接口。
      //    必须排在 SPA 之前：监控脚本与 e2e 脚本按 JSON 解析 /health，
      //    一旦被 index.html 吞掉就会静默失效。
      if (path === '/health') {
        return await handleHealth(env);
      }

      // 5. 管理 API。
      if (path.startsWith(ADMIN_API_PREFIX)) {
        return await handleAdminApi(request, env, ctx);
      }

      // 6. 其余路径交给管理后台 SPA。
      //    部署形态下「Worker 自身的域名 = 管理后台入口」，
      //    而各专属域名已在第 3 步被应用接管，两者互不干扰。
      //    没有第 7 步的 /t/<slug>/：前缀入口已移除，隧道只能经专属域名访问。
      const spa = await serveAdminSpa(request, env);
      if (spa !== undefined) {
        return spa;
      }

      // 7. 降级：静态资源缺失时（本地尚未 pnpm build）返回纯文本运行信息。
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
