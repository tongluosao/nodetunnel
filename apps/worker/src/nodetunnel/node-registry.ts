import type { NodeRecord } from '@nodetunnel/shared';

import type { Env } from '../env.js';
import * as queries from '../db/queries.js';
import { logger } from '../lib/logger.js';

/**
 * 节点注册表（业务层）。
 *
 * 配置服务器收到心跳后调用 recordHeartbeat，把节点信息落库。
 * 组网归属通过「客户端上报的 network_name」反查 tunnel 得到。
 */

export interface HeartbeatInput {
  machine_id: string;
  inst_id: string;
  easytier_version?: string;
  hostname?: string;
  running_network_instances?: string[];
}

/**
 * 记录一次节点心跳。
 *
 * 归属判定：客户端心跳里可能同时上报多个运行中的实例，
 * 这里取第一个能匹配到本系统 tunnel 的网络名作为归属。
 * 匹配不到时 tunnelId 记为 null —— 节点仍会被记录，
 * 便于管理员排查「客户端连上了但组网名配置错误」的情况。
 */
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

/**
 * 由心跳推断节点所属 tunnel。
 *
 * 心跳里的 running_network_instances 是实例 UUID 列表而非网络名，
 * 因此优先用 hostname 降级匹配不成立；这里改为遍历本系统所有 tunnel，
 * 找出「客户端声明的实例 id 与某 tunnel 的 network_name 相关」的情形不可行，
 * 故采用保守策略：仅当配置服务器明确知道 inst_id → tunnel 的映射时才归属。
 *
 * 该映射来自节点首次通过 REST 拉取配置时建立的关联（见 admin/handlers/config-pull）。
 */
async function resolveTunnelId(env: Env, input: HeartbeatInput): Promise<string | null> {
  const mapped = await queries.findNodeTunnelMapping(env.DB, input.inst_id);
  if (mapped !== undefined) {
    return mapped;
  }

  // 未建立映射：尝试用 hostname 匹配 tunnel 名称（管理员常用主机名命名 tunnel）。
  if (input.hostname !== undefined && input.hostname !== '') {
    const byHostname = await queries.findTunnelByName(env.DB, input.hostname);
    if (byHostname !== undefined) {
      return byHostname.id;
    }
  }

  return null;
}

export async function listNodes(env: Env, limit?: number): Promise<NodeRecord[]> {
  return queries.listNodes(env.DB, limit);
}
