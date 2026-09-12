import type { NodeRecord } from '@nodetunnel/shared';

import type { Env } from '../env.js';
import * as queries from '../db/queries.js';
import { logger } from '../lib/logger.js';

/**
 * 节点心跳记录（基础层）。
 *
 * 放在基础层而非 nodetunnel/ 业务层，是因为配置服务器（基础层）
 * 需要在收到心跳时直接落库；若放在业务层就会形成
 * 「基础层 -> 业务层」的反向依赖，违反三层边界。
 *
 * 归属判定策略：
 *   1. 优先读取已建立的 inst_id -> tunnel 映射（客户端拉取配置时写入）；
 *   2. 回退到用 hostname 匹配隧道名称（管理员常用主机名命名隧道）；
 *   3. 都无法匹配时记为未归属，仍保留记录，便于排查
 *      「客户端连上了但组网名配错」的情况。
 */

export interface HeartbeatInput {
  machine_id: string;
  inst_id: string;
  easytier_version?: string;
  hostname?: string;
  running_network_instances?: string[];
}

/** 记录一次节点心跳。 */
export async function recordHeartbeat(env: Env, input: HeartbeatInput): Promise<void> {
  const tunnelId = await resolveTunnelId(env, input);
  const now = Date.now();

  await queries.upsertNodeHeartbeat(env.DB, {
    instanceId: input.inst_id,
    machineId: input.machine_id,
    hostname: input.hostname ?? null,
    tunnelId,
    easytierVersion: input.easytier_version ?? null,
    // 虚拟 IP 由 EasyTier 自动分配，心跳协议不携带，留待后续扩展。
    ipv4: null,
    now,
  });

  logger.debug('node_heartbeat_recorded', {
    instanceId: input.inst_id,
    machineId: input.machine_id,
    tunnelId,
  });
}

/** 列出已登记的节点。 */
export async function listNodes(env: Env, limit?: number): Promise<NodeRecord[]> {
  return queries.listNodes(env.DB, limit);
}

/** 由心跳推断节点所属 tunnel。 */
async function resolveTunnelId(env: Env, input: HeartbeatInput): Promise<string | null> {
  const mapped = await queries.findNodeTunnelMapping(env.DB, input.inst_id);
  if (mapped !== undefined) {
    return mapped;
  }

  if (input.hostname !== undefined && input.hostname !== '') {
    const byHostname = await queries.findTunnelByName(env.DB, input.hostname);
    if (byHostname !== undefined) {
      return byHostname.id;
    }
  }

  return null;
}
