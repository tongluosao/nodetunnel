import type { AgentRecord } from '@nodetunnel/shared';

import type { Env } from '../env.js';
import * as queries from '../db/queries.js';

/**
 * 主机端 agent 注册表（业务层）。
 *
 * agent 的在线状态由信令房间在连接建立/断开时写入 D1，
 * 本模块只做查询与展示，不参与连接生命周期。
 */

export async function listAgents(env: Env, limit = 200): Promise<AgentRecord[]> {
  return queries.listAgents(env.DB, limit);
}

export async function findAgentByTunnelId(
  env: Env,
  tunnelId: string,
): Promise<AgentRecord | undefined> {
  return queries.findAgentByTunnelId(env.DB, tunnelId);
}

export async function countAgents(env: Env): Promise<number> {
  return queries.countAgents(env.DB);
}

export async function countOnlineAgents(env: Env, since: number): Promise<number> {
  return queries.countOnlineAgents(env.DB, since);
}
