import type { Route } from '@nodetunnel/shared';

import type { Env } from '../env.js';
import * as queries from '../db/queries.js';
import { AppError, ErrorCode, err, ok, type Result } from '../lib/errors.js';

/**
 * 路由注册表（业务层）。
 *
 * 路由把 URL 前缀 `/t/<slug>`（或一个专属域名）映射到某个隧道内的目标服务。
 * 一个隧道可以有多个路由（例如同一台机器上的不同 Web 服务）。
 */

/**
 * 拒绝把管理后台自身的域名绑成专属域名。
 *
 * 专属域名会整站接管该域名（只保留 /agent 与 /signal），一旦把管理后台
 * 所在的域名绑上去，管理员会立刻失去登录入口，只能改数据库才能恢复。
 * 这里 fail-closed 地拦住，避免一个配置动作把系统锁死。
 */
function assertNotAdminOrigin(env: Env, hostname: string): void {
  const adminOrigin = env.NT_ADMIN_ORIGIN;
  if (adminOrigin === undefined || adminOrigin === '') {
    return;
  }
  let adminHost: string;
  try {
    adminHost = new URL(adminOrigin).hostname.toLowerCase();
  } catch {
    return;
  }
  if (hostname === adminHost) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      `不能把管理后台自身的域名（${adminHost}）设为专属域名，否则将无法再访问管理后台`,
      { field: 'hostname' },
    );
  }
}

export async function listRoutes(env: Env): Promise<Route[]> {
  return queries.listRoutes(env.DB);
}

export async function listRoutesForTunnel(env: Env, tunnelId: string): Promise<Route[]> {
  return queries.listRoutesByTunnel(env.DB, tunnelId);
}

/** 按 slug 查找已启用的路由。访问入口使用此函数。 */
export async function findEnabledRouteBySlug(env: Env, slug: string): Promise<Route | undefined> {
  const route = await queries.findRouteBySlug(env.DB, slug);
  if (route === undefined || !route.enabled) {
    return undefined;
  }
  return route;
}

/**
 * 按专属域名查找已启用的路由。
 *
 * 域名到路由的映射是公开入口，因此同样要求路由处于启用状态 ——
 * 否则「停用一条路由」只对前缀形式生效，域名形式仍能访问，禁用就形同虚设。
 */
export async function findEnabledRouteByHostname(
  env: Env,
  hostname: string,
): Promise<Route | undefined> {
  return queries.findEnabledRouteByHostname(env.DB, hostname);
}

export interface CreateRouteInput {
  slug: string;
  tunnelId: string;
  targetHost: string;
  targetPort: number;
  hostname?: string | null;
  enabled?: boolean;
}

export async function createRoute(
  env: Env,
  input: CreateRouteInput,
): Promise<Result<Route, AppError>> {
  const existing = await queries.findRouteBySlug(env.DB, input.slug);
  if (existing !== undefined) {
    return err(new AppError(ErrorCode.CONFLICT, '该路径已被占用', { field: 'slug' }));
  }

  // 外键约束要求隧道真实存在；提前校验以返回明确错误。
  const tunnel = await queries.findTunnelById(env.DB, input.tunnelId);
  if (tunnel === undefined) {
    return err(new AppError(ErrorCode.NOT_FOUND, '指定的隧道不存在', { field: 'tunnelId' }));
  }

  if (input.hostname !== undefined && input.hostname !== null) {
    assertNotAdminOrigin(env, input.hostname);
    const byHost = await queries.findEnabledRouteByHostname(env.DB, input.hostname);
    if (byHost !== undefined) {
      return err(
        new AppError(ErrorCode.CONFLICT, '该专属域名已被其他路由使用', { field: 'hostname' }),
      );
    }
  }

  const now = Date.now();
  const route: Route = {
    id: crypto.randomUUID(),
    slug: input.slug,
    tunnelId: input.tunnelId,
    targetHost: input.targetHost,
    targetPort: input.targetPort,
    hostname: input.hostname ?? null,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };

  await queries.insertRoute(env.DB, route);
  return ok(route);
}

export interface UpdateRouteInput {
  slug?: string;
  tunnelId?: string;
  targetHost?: string;
  targetPort?: number;
  /** null 表示清除专属域名，undefined 表示保持原值。 */
  hostname?: string | null;
  enabled?: boolean;
}

export async function updateRoute(
  env: Env,
  id: string,
  input: UpdateRouteInput,
): Promise<Result<Route, AppError>> {
  const rows = await queries.listRoutes(env.DB);
  const existing = rows.find((route) => route.id === id);
  if (existing === undefined) {
    return err(new AppError(ErrorCode.NOT_FOUND, '路由不存在'));
  }

  if (input.slug !== undefined && input.slug !== existing.slug) {
    const bySlug = await queries.findRouteBySlug(env.DB, input.slug);
    if (bySlug !== undefined && bySlug.id !== id) {
      return err(new AppError(ErrorCode.CONFLICT, '该路径已被占用', { field: 'slug' }));
    }
  }

  if (input.tunnelId !== undefined && input.tunnelId !== existing.tunnelId) {
    const tunnel = await queries.findTunnelById(env.DB, input.tunnelId);
    if (tunnel === undefined) {
      return err(new AppError(ErrorCode.NOT_FOUND, '指定的隧道不存在', { field: 'tunnelId' }));
    }
  }

  if (
    input.hostname !== undefined &&
    input.hostname !== null &&
    input.hostname !== existing.hostname
  ) {
    assertNotAdminOrigin(env, input.hostname);
    const byHost = await queries.findEnabledRouteByHostname(env.DB, input.hostname);
    if (byHost !== undefined && byHost.id !== id) {
      return err(
        new AppError(ErrorCode.CONFLICT, '该专属域名已被其他路由使用', { field: 'hostname' }),
      );
    }
  }

  const updated: Route = {
    ...existing,
    slug: input.slug ?? existing.slug,
    tunnelId: input.tunnelId ?? existing.tunnelId,
    targetHost: input.targetHost ?? existing.targetHost,
    targetPort: input.targetPort ?? existing.targetPort,
    // undefined 表示「本次不修改」，null 表示「清除」，两者语义必须区分开。
    hostname: input.hostname === undefined ? existing.hostname : input.hostname,
    enabled: input.enabled ?? existing.enabled,
    updatedAt: Date.now(),
  };

  await queries.updateRoute(env.DB, updated);
  return ok(updated);
}

export async function deleteRoute(env: Env, id: string): Promise<Result<true, AppError>> {
  const changes = await queries.deleteRoute(env.DB, id);
  if (changes === 0) {
    return err(new AppError(ErrorCode.NOT_FOUND, '路由不存在'));
  }
  return ok(true);
}
