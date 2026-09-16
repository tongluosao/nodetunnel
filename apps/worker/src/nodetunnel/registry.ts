import type { Tunnel, TunnelPort, TunnelWithToken } from '@nodetunnel/shared';

import type { Env } from '../env.js';
import * as queries from '../db/queries.js';
import { generateTunnelToken, hashToken, tokenPrefix } from '../lib/crypto.js';
import { AppError, ErrorCode, err, ok, type Result } from '../lib/errors.js';

/**
 * 隧道注册表（业务层）。
 *
 * 对上层屏蔽 D1 与令牌哈希细节，只暴露领域操作。
 * 所有写操作在此处做唯一性冲突检测，避免把数据库约束错误泄漏成 500。
 *
 * 令牌处理原则：
 *   - 明文令牌只在「创建」与「轮换」两个时刻返回，此后不可再取回；
 *   - 库里只存 SHA-256 摘要与前缀，即使数据库泄露也无法直接冒用；
 *   - 因此没有「读取令牌」这个操作，需要明文就说明该轮换了。
 */

export async function listTunnels(env: Env): Promise<Tunnel[]> {
  return queries.listTunnels(env.DB);
}

export async function findTunnel(env: Env, id: string): Promise<Tunnel | undefined> {
  return queries.findTunnelById(env.DB, id);
}

/**
 * 校验接入令牌并返回对应隧道。
 *
 * 信令握手使用。返回 undefined 表示令牌无效或隧道已禁用 ——
 * 调用方不得向客户端区分这两者，避免通过响应差异枚举令牌。
 */
export async function authenticateTunnelToken(
  env: Env,
  token: string,
): Promise<Tunnel | undefined> {
  const hash = await hashToken(token);
  const tunnel = await queries.findTunnelByTokenHash(env.DB, hash);
  if (tunnel === undefined || !tunnel.enabled) {
    return undefined;
  }
  return tunnel;
}

export interface CreateTunnelInput {
  name: string;
  ports: TunnelPort[];
  enabled?: boolean;
}

/**
 * 创建隧道并生成接入令牌。
 *
 * 冲突检测前置到应用层，返回明确的 CONFLICT 错误而非数据库异常；
 * 唯一索引仍然保留，作为并发写入的最后防线。
 */
export async function createTunnel(
  env: Env,
  input: CreateTunnelInput,
): Promise<Result<TunnelWithToken, AppError>> {
  const byName = await queries.findTunnelByName(env.DB, input.name);
  if (byName !== undefined) {
    return err(new AppError(ErrorCode.CONFLICT, '同名隧道已存在', { field: 'name' }));
  }

  const token = generateTunnelToken();
  const now = Date.now();
  const tunnel: Tunnel = {
    id: crypto.randomUUID(),
    name: input.name,
    tokenPrefix: tokenPrefix(token),
    enabled: input.enabled ?? true,
    ports: input.ports,
    createdAt: now,
    updatedAt: now,
  };

  await queries.insertTunnel(env.DB, tunnel, await hashToken(token));
  // 唯一一次返回明文令牌的机会。
  return ok({ ...tunnel, token });
}

export interface UpdateTunnelInput {
  name?: string;
  ports?: TunnelPort[];
  enabled?: boolean;
}

/** 更新隧道。未提供的字段保持原值。 */
export async function updateTunnel(
  env: Env,
  id: string,
  input: UpdateTunnelInput,
): Promise<Result<Tunnel, AppError>> {
  const existing = await queries.findTunnelById(env.DB, id);
  if (existing === undefined) {
    return err(new AppError(ErrorCode.NOT_FOUND, '隧道不存在'));
  }

  // 唯一性冲突检测（排除自身）。
  if (input.name !== undefined && input.name !== existing.name) {
    const byName = await queries.findTunnelByName(env.DB, input.name);
    if (byName !== undefined && byName.id !== id) {
      return err(new AppError(ErrorCode.CONFLICT, '同名隧道已存在', { field: 'name' }));
    }
  }

  const updated: Tunnel = {
    ...existing,
    name: input.name ?? existing.name,
    enabled: input.enabled ?? existing.enabled,
    ports: input.ports ?? existing.ports,
    updatedAt: Date.now(),
  };

  await queries.updateTunnel(env.DB, updated, undefined);
  return ok(updated);
}

/**
 * 轮换接入令牌。
 *
 * 旧令牌立即失效：主机端会因此掉线，需要用新令牌重连。
 * 这是设计内的行为 —— 轮换的语义就是「把旧凭据作废」。
 */
export async function rotateTunnelToken(
  env: Env,
  id: string,
): Promise<Result<TunnelWithToken, AppError>> {
  const existing = await queries.findTunnelById(env.DB, id);
  if (existing === undefined) {
    return err(new AppError(ErrorCode.NOT_FOUND, '隧道不存在'));
  }

  const token = generateTunnelToken();
  const updated: Tunnel = {
    ...existing,
    tokenPrefix: tokenPrefix(token),
    updatedAt: Date.now(),
  };

  await queries.updateTunnel(env.DB, updated, await hashToken(token));
  return ok({ ...updated, token });
}

export async function deleteTunnel(env: Env, id: string): Promise<Result<true, AppError>> {
  const existing = await queries.findTunnelById(env.DB, id);
  if (existing === undefined) {
    return err(new AppError(ErrorCode.NOT_FOUND, '隧道不存在'));
  }
  // 外键 ON DELETE CASCADE 会一并清理 tunnel_ports、routes 与 agents。
  await queries.deleteTunnel(env.DB, id);
  return ok(true);
}
