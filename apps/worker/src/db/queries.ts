import type { AgentRecord, AdminAccount, Route, Tunnel, TunnelPort } from '@nodetunnel/shared';

/**
 * D1 数据访问层（基础层）。
 *
 * 规则：
 *   - 只有本模块可以出现 SQL 语句；业务层必须通过这里的函数访问数据库；
 *   - 所有查询使用 D1 的绑定参数（?），禁止字符串拼接，避免 SQL 注入；
 *   - 返回领域对象，不把 D1 的 Row 类型泄漏到业务层。
 */

/** D1 返回的行类型。字段与 schema.sql 一致。 */
interface AdminRow {
  id: string;
  username: string;
  password_hash: string;
  password_salt: string;
  iterations: number;
  created_at: number;
  updated_at: number;
}

interface TunnelRow {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface PortRow {
  id: string;
  tunnel_id: string;
  port: number;
  protocol: string;
  enabled: number;
}

interface RouteRow {
  id: string;
  slug: string;
  tunnel_id: string;
  target_host: string;
  target_port: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface AgentRow {
  id: string;
  tunnel_id: string;
  hostname: string | null;
  version: string | null;
  reported_ports: string;
  last_seen: number;
  created_at: number;
}

function toAdmin(row: AdminRow): AdminAccount {
  return {
    id: row.id,
    username: row.username,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRoute(row: RouteRow): Route {
  return {
    id: row.id,
    slug: row.slug,
    tunnelId: row.tunnel_id,
    targetHost: row.target_host,
    targetPort: row.target_port,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 解析本地可达端口。
 *
 * 该字段是 agent 上报的 JSON 文本，可能因版本差异或人工改动而损坏，
 * 因此解析失败时回退为空数组而不是抛错 —— 上报信息不可信且非关键路径，
 * 不该让一次坏数据把整个管理后台的节点列表打挂。
 */
function parseReportedPorts(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is number => typeof item === 'number');
  } catch {
    return [];
  }
}

function toAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    tunnelId: row.tunnel_id,
    hostname: row.hostname,
    version: row.version,
    reportedPorts: parseReportedPorts(row.reported_ports),
    lastSeen: row.last_seen,
    createdAt: row.created_at,
  };
}

function toTunnel(row: TunnelRow, ports: TunnelPort[]): Tunnel {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    enabled: row.enabled === 1,
    ports,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPort(row: PortRow): TunnelPort {
  return {
    port: row.port,
    protocol: row.protocol === 'udp' ? 'udp' : 'tcp',
  };
}

/* ------------------------------- 管理员 ------------------------------- */

export interface AdminRowWithSecret extends AdminAccount {
  passwordHash: string;
  passwordSalt: string;
  iterations: number;
}

export async function countAdmins(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS total FROM admins').first<{ total: number }>();
  return row?.total ?? 0;
}

export async function findAdminByUsername(
  db: D1Database,
  username: string,
): Promise<AdminRowWithSecret | undefined> {
  const row = await db
    .prepare(
      `SELECT id, username, password_hash, password_salt, iterations, created_at, updated_at
       FROM admins WHERE username = ?`,
    )
    .bind(username)
    .first<AdminRow>();
  if (row === null) {
    return undefined;
  }
  return {
    ...toAdmin(row),
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    iterations: row.iterations,
  };
}

export async function findAdminById(db: D1Database, id: string): Promise<AdminAccount | undefined> {
  const row = await db
    .prepare('SELECT id, username, created_at, updated_at FROM admins WHERE id = ?')
    .bind(id)
    .first<AdminRow>();
  return row === null ? undefined : toAdmin(row);
}

export async function insertAdmin(
  db: D1Database,
  input: {
    id: string;
    username: string;
    passwordHash: string;
    passwordSalt: string;
    iterations: number;
    now: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admins (id, username, password_hash, password_salt, iterations, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.username,
      input.passwordHash,
      input.passwordSalt,
      input.iterations,
      input.now,
      input.now,
    )
    .run();
}

export async function updateAdminPassword(
  db: D1Database,
  input: {
    id: string;
    passwordHash: string;
    passwordSalt: string;
    iterations: number;
    now: number;
  },
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE admins SET password_hash = ?, password_salt = ?, iterations = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(input.passwordHash, input.passwordSalt, input.iterations, input.now, input.id)
    .run();
  return result.meta.changes ?? 0;
}

/* -------------------------------- 隧道 -------------------------------- */

export async function listTunnels(db: D1Database): Promise<Tunnel[]> {
  const tunnels = await db
    .prepare('SELECT * FROM tunnels ORDER BY created_at ASC')
    .all<TunnelRow>();
  const ports = await db
    .prepare('SELECT * FROM tunnel_ports WHERE enabled = 1 ORDER BY protocol ASC, port ASC')
    .all<PortRow>();

  const portsByTunnel = new Map<string, TunnelPort[]>();
  for (const row of ports.results ?? []) {
    const list = portsByTunnel.get(row.tunnel_id) ?? [];
    list.push(toPort(row));
    portsByTunnel.set(row.tunnel_id, list);
  }

  return (tunnels.results ?? []).map((row) => toTunnel(row, portsByTunnel.get(row.id) ?? []));
}

export async function findTunnelById(db: D1Database, id: string): Promise<Tunnel | undefined> {
  const row = await db.prepare('SELECT * FROM tunnels WHERE id = ?').bind(id).first<TunnelRow>();
  if (row === null) {
    return undefined;
  }
  const ports = await db
    .prepare(
      'SELECT * FROM tunnel_ports WHERE tunnel_id = ? AND enabled = 1 ORDER BY protocol ASC, port ASC',
    )
    .bind(id)
    .all<PortRow>();
  return toTunnel(row, (ports.results ?? []).map(toPort));
}

export async function findTunnelByName(db: D1Database, name: string): Promise<Tunnel | undefined> {
  const row = await db
    .prepare('SELECT * FROM tunnels WHERE name = ?')
    .bind(name)
    .first<TunnelRow>();
  if (row === null) {
    return undefined;
  }
  const ports = await db
    .prepare(
      'SELECT * FROM tunnel_ports WHERE tunnel_id = ? AND enabled = 1 ORDER BY protocol ASC, port ASC',
    )
    .bind(row.id)
    .all<PortRow>();
  return toTunnel(row, (ports.results ?? []).map(toPort));
}

/**
 * 按令牌哈希查找隧道。信令握手时使用。
 *
 * 返回 undefined 表示令牌无效 —— 调用方不得区分「不存在」与「已禁用」，
 * 避免通过响应差异枚举令牌。
 */
export async function findTunnelByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<Tunnel | undefined> {
  const row = await db
    .prepare('SELECT * FROM tunnels WHERE token_hash = ?')
    .bind(tokenHash)
    .first<TunnelRow>();
  if (row === null) {
    return undefined;
  }
  const ports = await db
    .prepare(
      'SELECT * FROM tunnel_ports WHERE tunnel_id = ? AND enabled = 1 ORDER BY protocol ASC, port ASC',
    )
    .bind(row.id)
    .all<PortRow>();
  return toTunnel(row, (ports.results ?? []).map(toPort));
}

export async function insertTunnel(
  db: D1Database,
  tunnel: Tunnel,
  tokenHash: string,
): Promise<void> {
  const statements = [
    db
      .prepare(
        `INSERT INTO tunnels (id, name, token_hash, token_prefix, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tunnel.id,
        tunnel.name,
        tokenHash,
        tunnel.tokenPrefix,
        tunnel.enabled ? 1 : 0,
        tunnel.createdAt,
        tunnel.updatedAt,
      ),
    ...tunnel.ports.map((port) =>
      db
        .prepare(
          `INSERT INTO tunnel_ports (id, tunnel_id, port, protocol, enabled) VALUES (?, ?, ?, ?, 1)`,
        )
        .bind(crypto.randomUUID(), tunnel.id, port.port, port.protocol),
    ),
  ];
  await db.batch(statements);
}

/**
 * 更新隧道。ports 为 undefined 时保持端口白名单不变；
 * 传入数组时全量替换（先删后插，在同一个 batch 中保证原子性）。
 *
 * tokenHash 仅在轮换令牌时提供。
 */
export async function updateTunnel(
  db: D1Database,
  tunnel: Tunnel,
  tokenHash: string | undefined,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  if (tokenHash === undefined) {
    statements.push(
      db
        .prepare(
          `UPDATE tunnels SET name = ?, token_prefix = ?, enabled = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(tunnel.name, tunnel.tokenPrefix, tunnel.enabled ? 1 : 0, tunnel.updatedAt, tunnel.id),
    );
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE tunnels SET name = ?, token_hash = ?, token_prefix = ?, enabled = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          tunnel.name,
          tokenHash,
          tunnel.tokenPrefix,
          tunnel.enabled ? 1 : 0,
          tunnel.updatedAt,
          tunnel.id,
        ),
    );
  }

  if (tunnel.ports.length >= 0) {
    statements.push(
      db.prepare('DELETE FROM tunnel_ports WHERE tunnel_id = ?').bind(tunnel.id),
      ...tunnel.ports.map((port) =>
        db
          .prepare(
            `INSERT INTO tunnel_ports (id, tunnel_id, port, protocol, enabled) VALUES (?, ?, ?, ?, 1)`,
          )
          .bind(crypto.randomUUID(), tunnel.id, port.port, port.protocol),
      ),
    );
  }

  await db.batch(statements);
}

export async function deleteTunnel(db: D1Database, id: string): Promise<number> {
  const result = await db.prepare('DELETE FROM tunnels WHERE id = ?').bind(id).run();
  return result.meta.changes ?? 0;
}

/* -------------------------------- 路由 -------------------------------- */

export async function listRoutes(db: D1Database): Promise<Route[]> {
  const rows = await db.prepare('SELECT * FROM routes ORDER BY slug ASC').all<RouteRow>();
  return (rows.results ?? []).map(toRoute);
}

export async function listRoutesByTunnel(db: D1Database, tunnelId: string): Promise<Route[]> {
  const rows = await db
    .prepare('SELECT * FROM routes WHERE tunnel_id = ? ORDER BY slug ASC')
    .bind(tunnelId)
    .all<RouteRow>();
  return (rows.results ?? []).map(toRoute);
}

export async function findRouteBySlug(db: D1Database, slug: string): Promise<Route | undefined> {
  const row = await db.prepare('SELECT * FROM routes WHERE slug = ?').bind(slug).first<RouteRow>();
  return row === null ? undefined : toRoute(row);
}

export async function insertRoute(db: D1Database, route: Route): Promise<void> {
  await db
    .prepare(
      `INSERT INTO routes (id, slug, tunnel_id, target_host, target_port, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      route.id,
      route.slug,
      route.tunnelId,
      route.targetHost,
      route.targetPort,
      route.enabled ? 1 : 0,
      route.createdAt,
      route.updatedAt,
    )
    .run();
}

export async function updateRoute(db: D1Database, route: Route): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE routes SET slug = ?, tunnel_id = ?, target_host = ?, target_port = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      route.slug,
      route.tunnelId,
      route.targetHost,
      route.targetPort,
      route.enabled ? 1 : 0,
      route.updatedAt,
      route.id,
    )
    .run();
  return result.meta.changes ?? 0;
}

export async function deleteRoute(db: D1Database, id: string): Promise<number> {
  const result = await db.prepare('DELETE FROM routes WHERE id = ?').bind(id).run();
  return result.meta.changes ?? 0;
}

/* ------------------------------ 主机端 agent ------------------------------ */

export async function listAgents(db: D1Database, limit = 200): Promise<AgentRecord[]> {
  const rows = await db
    .prepare('SELECT * FROM agents ORDER BY last_seen DESC LIMIT ?')
    .bind(limit)
    .all<AgentRow>();
  return (rows.results ?? []).map(toAgent);
}

export async function findAgentByTunnelId(
  db: D1Database,
  tunnelId: string,
): Promise<AgentRecord | undefined> {
  const row = await db
    .prepare('SELECT * FROM agents WHERE tunnel_id = ?')
    .bind(tunnelId)
    .first<AgentRow>();
  return row === null ? undefined : toAgent(row);
}

export async function countAgents(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS total FROM agents').first<{ total: number }>();
  return row?.total ?? 0;
}

export async function countOnlineAgents(db: D1Database, since: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM agents WHERE last_seen >= ?')
    .bind(since)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function countTunnels(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS total FROM tunnels').first<{ total: number }>();
  return row?.total ?? 0;
}

export async function countRoutes(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS total FROM routes').first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * 记录 agent 上线或心跳。
 *
 * 以 tunnel_id 为冲突键：一台主机对应一个 tunnel，重连不该产生重复记录。
 */
export async function upsertAgent(
  db: D1Database,
  input: {
    tunnelId: string;
    hostname: string | null;
    version: string | null;
    reportedPorts: number[];
    now: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agents (id, tunnel_id, hostname, version, reported_ports, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tunnel_id) DO UPDATE SET
         hostname = excluded.hostname,
         version = excluded.version,
         reported_ports = excluded.reported_ports,
         last_seen = excluded.last_seen`,
    )
    .bind(
      crypto.randomUUID(),
      input.tunnelId,
      input.hostname,
      input.version,
      JSON.stringify(input.reportedPorts),
      input.now,
      input.now,
    )
    .run();
}

/** 更新心跳时间，不改动其他字段。 */
export async function touchAgent(db: D1Database, tunnelId: string, now: number): Promise<void> {
  await db.prepare('UPDATE agents SET last_seen = ? WHERE tunnel_id = ?').bind(now, tunnelId).run();
}

export async function deleteAgent(db: D1Database, tunnelId: string): Promise<number> {
  const result = await db.prepare('DELETE FROM agents WHERE tunnel_id = ?').bind(tunnelId).run();
  return result.meta.changes ?? 0;
}
