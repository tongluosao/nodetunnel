import type { Tunnel, TunnelPort } from '@nodetunnel/shared';

import type { Env } from '../env.js';
import * as queries from '../db/queries.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { AppError, ErrorCode, err, ok, type Result } from '../lib/errors.js';

/**
 * 隧道注册表（业务层）。
 *
 * 对上层屏蔽 D1 与加解密细节，只暴露领域操作。
 * 所有写操作在此处做唯一性冲突检测，避免把数据库约束错误泄漏成 500。
 */

export interface TunnelWithSecret extends Tunnel {
  /** 明文组网密钥。仅在渲染客户端配置时使用，绝不返回给浏览器。 */
  networkSecret: string;
}

/** 读取全部隧道（列表用，不含组网密钥）。 */
export async function listTunnels(env: Env): Promise<Tunnel[]> {
  return queries.listTunnels(env.DB);
}

export async function findTunnel(env: Env, id: string): Promise<Tunnel | undefined> {
  return queries.findTunnelById(env.DB, id);
}

/**
 * 读取隧道并解密其组网密钥。
 *
 * 用于：渲染隧道节点配置、下发给配置服务器。
 * 调用方必须确保结果不进入 HTTP 响应体。
 */
export async function loadTunnelWithSecret(
  env: Env,
  tunnelId: string,
): Promise<Result<TunnelWithSecret, AppError>> {
  const tunnel = await queries.findTunnelById(env.DB, tunnelId);
  if (tunnel === undefined) {
    return err(new AppError(ErrorCode.NOT_FOUND, '隧道不存在'));
  }

  const encrypted = await queries.findTunnelSecret(env.DB, tunnelId);
  if (encrypted === undefined) {
    return err(new AppError(ErrorCode.NOT_FOUND, '隧道密钥不存在'));
  }

  const decrypted = await decryptSecret(encrypted, env.NT_MASTER_KEY);
  if (!decrypted.ok) {
    return err(decrypted.error);
  }

  return ok({ ...tunnel, networkSecret: decrypted.value });
}

/**
 * 按组网名加载隧道及其密钥。
 * 配置服务器心跳需要用组网名反查隧道，以记录节点归属。
 */
export async function loadTunnelByNetworkName(
  env: Env,
  networkName: string,
): Promise<Result<TunnelWithSecret, AppError>> {
  const tunnel = await queries.findTunnelByNetworkName(env.DB, networkName);
  if (tunnel === undefined) {
    return err(new AppError(ErrorCode.NOT_FOUND, '隧道不存在'));
  }
  return loadTunnelWithSecret(env, tunnel.id);
}

export interface CreateTunnelInput {
  name: string;
  networkName: string;
  /** 明文组网密钥，入库前会被加密。 */
  networkSecret: string;
  relayUrl: string;
  ports: TunnelPort[];
  enabled?: boolean;
}

/**
 * 创建隧道。
 *
 * 冲突检测前置到应用层，返回明确的 CONFLICT 错误而非数据库异常：
 *   - name 与 network_name 都必须唯一；
 *   - 唯一索引仍然保留，作为并发写入的最后防线。
 */
export async function createTunnel(
  env: Env,
  input: CreateTunnelInput,
): Promise<Result<Tunnel, AppError>> {
  const byName = await queries.findTunnelByName(env.DB, input.name);
  if (byName !== undefined) {
    return err(new AppError(ErrorCode.CONFLICT, '同名隧道已存在', { field: 'name' }));
  }
  const byNetwork = await queries.findTunnelByNetworkName(env.DB, input.networkName);
  if (byNetwork !== undefined) {
    return err(new AppError(ErrorCode.CONFLICT, '该网络名称已被占用', { field: 'networkName' }));
  }

  const encrypted = await encryptSecret(input.networkSecret, env.NT_MASTER_KEY);
  if (!encrypted.ok) {
    return err(encrypted.error);
  }

  const now = Date.now();
  const tunnel: Tunnel = {
    id: crypto.randomUUID(),
    name: input.name,
    networkName: input.networkName,
    relayUrl: input.relayUrl,
    enabled: input.enabled ?? true,
    ports: input.ports,
    createdAt: now,
    updatedAt: now,
  };

  await queries.insertTunnel(env.DB, tunnel, encrypted.value);
  return ok(tunnel);
}

export interface UpdateTunnelInput {
  name?: string;
  networkName?: string;
  /** 仅在需要更换组网密钥时提供。 */
  networkSecret?: string;
  relayUrl?: string;
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
  if (input.networkName !== undefined && input.networkName !== existing.networkName) {
    const byNetwork = await queries.findTunnelByNetworkName(env.DB, input.networkName);
    if (byNetwork !== undefined && byNetwork.id !== id) {
      return err(
        new AppError(ErrorCode.CONFLICT, '该网络名称已被占用', { field: 'networkName' }),
      );
    }
  }

  let secretEnc: string | undefined;
  if (input.networkSecret !== undefined) {
    const encrypted = await encryptSecret(input.networkSecret, env.NT_MASTER_KEY);
    if (!encrypted.ok) {
      return err(encrypted.error);
    }
    secretEnc = encrypted.value;
  }

  const updated: Tunnel = {
    ...existing,
    name: input.name ?? existing.name,
    networkName: input.networkName ?? existing.networkName,
    relayUrl: input.relayUrl ?? existing.relayUrl,
    enabled: input.enabled ?? existing.enabled,
    ports: input.ports ?? existing.ports,
    updatedAt: Date.now(),
  };

  await queries.updateTunnel(env.DB, updated, secretEnc);
  return ok(updated);
}

export async function deleteTunnel(env: Env, id: string): Promise<Result<true, AppError>> {
  const existing = await queries.findTunnelById(env.DB, id);
  if (existing === undefined) {
    return err(new AppError(ErrorCode.NOT_FOUND, '隧道不存在'));
  }
  // 外键 ON DELETE CASCADE 会一并清理 tunnel_ports 与 routes。
  await queries.deleteTunnel(env.DB, id);
  return ok(true);
}
