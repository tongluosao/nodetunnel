import type { AdminAccount, NodeRecord, Route, Tunnel, TunnelPort } from '@nodetunnel/shared';

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
  network_name: string;
  network_secret_enc: string;
  relay_url: string;
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

interface NodeRow {
  id: string;
  instance_id: string;
  machine_id: string | null;
  hostname: string | null;
  tunnel_id: string | null;
  ipv4: string | null;
  easytier_version: string | null;
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

function toNode(row: NodeRow): NodeRecord {
  return {
    id: row.id,
    instanceId: row.instance_id,
    machineId: row.machine_id,
    hostname: row.hostname,
    tunnelId: row.tunnel_id,
    ipv4: row.ipv4,
    easytierVersion: row.easytier_version,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
  };
}

function toTunnel(row: TunnelRow, ports: TunnelPort[]): Tunnel {
  return {
    id: row.id,
    name: row.name,
    networkName: row.network_name,
    relayUrl: row.relay_url,
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

/** 取出加密的组网密钥。只有渲染客户端配置时才需要调用。 */
export async function findTunnelSecret(db: D1Database, id: string): Promise<string | undefined> {
  const row = await db
    .prepare('SELECT network_secret_enc FROM tunnels WHERE id = ?')
    .bind(id)
    .first<{ network_secret_enc: string }>();
  return row?.network_secret_enc;
}

export async function findTunnelByNetworkName(
  db: D1Database,
  networkName: string,
): Promise<Tunnel | undefined> {
  const row = await db
    .prepare('SELECT * FROM tunnels WHERE network_name = ?')
    .bind(networkName)
    .first<TunnelRow>();
  if (row === null) {
    return undefined;
  }
  const ports = await db
    .prepare('SELECT * FROM tunnel_ports WHERE tunnel_id = ? AND enabled = 1')
    .bind(row.id)
    .all<PortRow>();
  return toTunnel(row, (ports.results ?? []).map(toPort));
}

export async function insertTunnel(
  db: D1Database,
  tunnel: Tunnel,
  secretEnc: string,
): Promise<void> {
  const statements = [
    db
      .prepare(
        `INSERT INTO tunnels (id, name, network_name, network_secret_enc, relay_url, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tunnel.id,
        tunnel.name,
        tunnel.networkName,
        secretEnc,
        tunnel.relayUrl,
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
 */
export async function updateTunnel(
  db: D1Database,
  tunnel: Tunnel,
  secretEnc: string | undefined,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  if (secretEnc === undefined) {
    statements.push(
      db
        .prepare(
          `UPDATE tunnels SET name = ?, network_name = ?, relay_url = ?, enabled = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          tunnel.name,
          tunnel.networkName,
          tunnel.relayUrl,
          tunnel.enabled ? 1 : 0,
          tunnel.updatedAt,
          tunnel.id,
        ),
    );
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE tunnels SET name = ?, network_name = ?, network_secret_enc = ?, relay_url = ?, enabled = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          tunnel.name,
          tunnel.networkName,
          secretEnc,
          tunnel.relayUrl,
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

/* -------------------------------- 节点 -------------------------------- */

export async function listNodes(db: D1Database, limit = 200): Promise<NodeRecord[]> {
  const rows = await db
    .prepare('SELECT * FROM nodes ORDER BY last_seen DESC LIMIT ?')
    .bind(limit)
    .all<NodeRow>();
  return (rows.results ?? []).map(toNode);
}

export async function countNodes(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS total FROM nodes').first<{ total: number }>();
  return row?.total ?? 0;
}

export async function countOnlineNodes(db: D1Database, since: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM nodes WHERE last_seen >= ?')
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
 * 记录节点心跳。
 *
 * 以 instance_id 为唯一键 UPSERT：节点重启后 instance_id 保持稳定，
 * 因此不会产生重复记录。tunnel_id 通过组网名反查得到。
 */
export async function upsertNodeHeartbeat(
  db: D1Database,
  input: {
    instanceId: string;
    machineId: string | null;
    hostname: string | null;
    tunnelId: string | null;
    easytierVersion: string | null;
    ipv4: string | null;
    now: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO nodes (id, instance_id, machine_id, hostname, tunnel_id, ipv4, easytier_version, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(instance_id) DO UPDATE SET
         machine_id = excluded.machine_id,
         hostname = excluded.hostname,
         tunnel_id = excluded.tunnel_id,
         ipv4 = excluded.ipv4,
         easytier_version = excluded.easytier_version,
         last_seen = excluded.last_seen`,
    )
    .bind(
      crypto.randomUUID(),
      input.instanceId,
      input.machineId,
      input.hostname,
      input.tunnelId,
      input.ipv4,
      input.easytierVersion,
      input.now,
      input.now,
    )
    .run();
}

/** 清理长期未上报的节点记录，避免节点表无限增长。 */
export async function pruneStaleNodes(db: D1Database, before: number): Promise<number> {
  const result = await db.prepare('DELETE FROM nodes WHERE last_seen < ?').bind(before).run();
  return result.meta.changes ?? 0;
}

/**
 * 查询某实例已归属的 tunnel。
 *
 * 归属关系在节点首次通过 REST 拉取配置时写入。
 * 心跳只做「读取」，不重新推断，避免误把节点划归到错误的隧道。
 */
export async function findNodeTunnelMapping(
  db: D1Database,
  instanceId: string,
): Promise<string | undefined> {
  const row = await db
    .prepare('SELECT tunnel_id FROM nodes WHERE instance_id = ? AND tunnel_id IS NOT NULL')
    .bind(instanceId)
    .first<{ tunnel_id: string }>();
  return row?.tunnel_id ?? undefined;
}

/**
 * 建立实例与 tunnel 的归属关系。
 *
 * 在客户端拉取配置时调用：能拉到某个 tunnel 的配置，
 * 说明它确实是该隧道的成员。
 */
export async function bindNodeToTunnel(
  db: D1Database,
  instanceId: string,
  tunnelId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO nodes (id, instance_id, machine_id, hostname, tunnel_id, ipv4, easytier_version, last_seen, created_at)
       VALUES (?, ?, NULL, NULL, ?, NULL, NULL, ?, ?)
       ON CONFLICT(instance_id) DO UPDATE SET
         tunnel_id = excluded.tunnel_id,
         last_seen = excluded.last_seen`,
    )
    .bind(crypto.randomUUID(), instanceId, tunnelId, now, now)
    .run();
}
