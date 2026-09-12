-- NodeTunnel D1 数据库结构。
--
-- 应用方式：
--   本地：pnpm db:migrate:local
--   远端：pnpm db:migrate:remote
--
-- 约定：
--   - 时间戳统一为 Unix 毫秒（INTEGER）；
--   - 布尔值用 INTEGER 0/1；
--   - 密码只存 PBKDF2 哈希与盐，绝不存明文或可逆密文；
--   - network_secret 必须能回传给客户端，故用 AES-GCM 加密后存 network_secret_enc。

-- 管理员。首启时表为空，触发管理后台的初始化流程。
CREATE TABLE IF NOT EXISTS admins (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  iterations    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- tunnel：一个 EasyTier 组网及其暴露策略。
CREATE TABLE IF NOT EXISTS tunnels (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  network_name       TEXT NOT NULL UNIQUE,
  -- AES-GCM 密文，格式 v1:<iv>:<ciphertext>
  network_secret_enc TEXT NOT NULL,
  relay_url          TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- 暴露端口白名单。渲染为 ACL 的 Allow 规则；未列出的端口一律拒绝。
CREATE TABLE IF NOT EXISTS tunnel_ports (
  id        TEXT PRIMARY KEY,
  tunnel_id TEXT NOT NULL REFERENCES tunnels(id) ON DELETE CASCADE,
  port      INTEGER NOT NULL,
  protocol  TEXT NOT NULL DEFAULT 'tcp',
  enabled   INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tunnel_id, port, protocol)
);

-- 路由：/t/<slug> -> tunnel 内的目标服务。
CREATE TABLE IF NOT EXISTS routes (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  tunnel_id   TEXT NOT NULL REFERENCES tunnels(id) ON DELETE CASCADE,
  target_host TEXT NOT NULL,
  target_port INTEGER NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 已接入的 EasyTier 节点，由配置服务器心跳 UPSERT。
CREATE TABLE IF NOT EXISTS nodes (
  id               TEXT PRIMARY KEY,
  instance_id      TEXT NOT NULL UNIQUE,
  machine_id       TEXT,
  hostname         TEXT,
  tunnel_id        TEXT REFERENCES tunnels(id) ON DELETE SET NULL,
  ipv4             TEXT,
  easytier_version TEXT,
  last_seen        INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_routes_slug ON routes (slug);
CREATE INDEX IF NOT EXISTS idx_routes_tunnel ON routes (tunnel_id);
CREATE INDEX IF NOT EXISTS idx_tunnel_ports_tunnel ON tunnel_ports (tunnel_id);
CREATE INDEX IF NOT EXISTS idx_nodes_instance ON nodes (instance_id);
CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes (last_seen);
