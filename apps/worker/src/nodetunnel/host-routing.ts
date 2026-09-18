import type { Route } from '@nodetunnel/shared';

import type { Env } from '../env.js';
import { logger } from '../lib/logger.js';
import { findEnabledRouteByHostname, findEnabledRouteBySlug } from './routes.js';

/**
 * 专属域名解析（业务层）。
 *
 * 把「请求落在哪个域名上」翻译成「该用哪条路由」，供接入层按 Host 分发。
 * 放在业务层而不是接入层：这里要读数据库并套用「路由必须启用」这条业务规则，
 * 接入层只应做分发与展示。
 */

/**
 * 从 Host 头取出可比较的域名。
 *
 * 必须剥掉端口：`project1.example.com:8787` 与 `project1.example.com`
 * 是同一条路由，带上端口会让匹配静默失效（表现为「配了域名却还是首页」）。
 */
export function normalizeHostname(host: string): string {
  const value = host.trim().toLowerCase();
  if (value === '') {
    return '';
  }
  // IPv6 字面量形如 [::1]:8787，这里不支持专属域名，直接放弃匹配。
  if (value.startsWith('[')) {
    return '';
  }
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

/**
 * 解析请求域名对应的路由。
 *
 * 两条来源，按优先级：
 *   1. 管理后台显式配置的专属域名（hostname 字段）——用于真实域名；
 *   2. `<slug>.localhost` 约定 —— 本地开发时无需配 DNS 与数据库即可验证，
 *      因为 *.localhost 在多数系统上由解析器直接指向 127.0.0.1。
 *
 * 显式配置优先：约定只是本地便利，不应该覆盖管理员的真实配置。
 */
export async function resolveRouteForHost(env: Env, hostname: string): Promise<Route | undefined> {
  if (hostname === '' || hostname === 'localhost') {
    return undefined;
  }

  try {
    const explicit = await findEnabledRouteByHostname(env, hostname);
    if (explicit !== undefined) {
      return explicit;
    }

    if (hostname.endsWith('.localhost')) {
      const slug = hostname.slice(0, -'.localhost'.length);
      // 只接受单层标签，避免 a.b.localhost 这类无意义输入触发查询。
      if (slug !== '' && !slug.includes('.')) {
        return findEnabledRouteBySlug(env, slug);
      }
    }
  } catch (error) {
    // 数据库不可用（表缺失、D1 限额、迁移未应用……）时**不能**让整站 500。
    // 这一步排在管理 API 之前，抛出去会让 /setup、/login 一并挂掉 ——
    // 数据库出问题时恰恰最需要能进后台看一眼，那才是排查入口。
    //
    // 这里按「没有匹配到路由」继续：请求随后落到管理后台或 /health，
    // 而不会进入隧道转发。也就是 fail-closed —— 宁可隧道在这期间不可用，
    // 也绝不在「不知道该域名属于谁」的情况下把流量放出去。
    logger.error('host_route_lookup_failed', {
      hostname,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  return undefined;
}
