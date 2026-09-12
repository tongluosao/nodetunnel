import type { Env } from '../env.js';

/**
 * 管理 API 路由表（接入层）。
 *
 * 只做「方法 + 路径 -> 处理函数」的分发，并在进入业务处理前完成鉴权。
 * 业务逻辑一律在 src/admin/handlers 与 src/nodetunnel 中实现。
 */

export interface RouteContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  /** 已解析的路径参数。 */
  params: Record<string, string>;
  /** 查询参数。 */
  query: URLSearchParams;
}

export type Handler = (context: RouteContext) => Promise<Response>;

export interface RouteDefinition {
  method: string;
  /** 路径模式，`:name` 表示占位段。 */
  pattern: string;
  handler: Handler;
  /** 是否需要管理员会话。初始化相关端点必须为 false。 */
  requiresAuth: boolean;
}

const routes: RouteDefinition[] = [];

export function route(
  method: string,
  pattern: string,
  requiresAuth: boolean,
  handler: Handler,
): void {
  routes.push({ method: method.toUpperCase(), pattern, handler, requiresAuth });
}

export function getRoutes(): readonly RouteDefinition[] {
  return routes;
}

/**
 * 把请求路径与路由模式匹配，提取路径参数。
 * 返回 undefined 表示不匹配。
 */
export function matchRoute(
  method: string,
  pathname: string,
): { definition: RouteDefinition; params: Record<string, string> } | undefined {
  const segments = splitPath(pathname);

  for (const definition of routes) {
    if (definition.method !== method.toUpperCase()) {
      continue;
    }
    const patternSegments = splitPath(definition.pattern);
    if (patternSegments.length !== segments.length) {
      continue;
    }

    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < patternSegments.length; index += 1) {
      const pattern = patternSegments[index] as string;
      const actual = segments[index] as string;
      if (pattern.startsWith(':')) {
        params[pattern.slice(1)] = decodeURIComponent(actual);
      } else if (pattern !== actual) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return { definition, params };
    }
  }

  return undefined;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}
