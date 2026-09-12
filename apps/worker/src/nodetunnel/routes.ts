import type { Route } from '@nodetunnel/shared';

import type { Env } from '../env.js';
import * as queries from '../db/queries.js';
import { AppError, ErrorCode, err, ok, type Result } from '../lib/errors.js';

/**
 * 路由注册表（业务层）。
 *
 * 路由把 URL 前缀 `/t/<slug>` 映射到某个隧道内的目标服务。
 * 一个隧道可以有多个路由（例如同一台机器上的不同 Web 服务）。
 */

export async function listRoutes(env: Env): Promise<Route[]> {
  return queries.listRoutes(env.DB);
}

export async function listRoutesForTunnel(env: Env, tunnelId: string): Promise<Route[]> {
  return queries.listRoutesByTunnel(env.DB, tunnelId);
}

/** 按 slug 查找已启用的路由。访问入口使用此函数。 */
export async function findEnabledRouteBySlug(
  env: Env,
  slug: string,
): Promise<Route | undefined> {
  const route = await queries.findRouteBySlug(env.DB, slug);
  if (route === undefined || !route.enabled) {
    return undefined;
  }
  return route;
}

export interface CreateRouteInput {
  slug: string;
  tunnelId: string;
  targetHost: string;
  targetPort: number;
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

  const now = Date.now();
  const route: Route = {
    id: crypto.randomUUID(),
    slug: input.slug,
    tunnelId: input.tunnelId,
    targetHost: input.targetHost,
    targetPort: input.targetPort,
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

  const updated: Route = {
    ...existing,
    slug: input.slug ?? existing.slug,
    tunnelId: input.tunnelId ?? existing.tunnelId,
    targetHost: input.targetHost ?? existing.targetHost,
    targetPort: input.targetPort ?? existing.targetPort,
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
