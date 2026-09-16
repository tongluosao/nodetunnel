-- NodeTunnel D1 数据库结构（初始版本）。
--
-- 应用方式：
--   本地：pnpm db:migrate:local
--   远端：pnpm db:migrate:remote
--
-- 与 src/db/schema.sql 保持一致；schema.sql 供阅读与本地即席使用，
-- 本目录下的文件是本迁移工具链的唯一事实来源。
--
-- 约定：
--   - 时间戳统一为 Unix 毫秒（INTEGER）；
--   - 布尔值用 INTEGER 0/1；
--   - 管理员密码只存 PBKDF2 哈希与盐，绝不存明文或可逆密文；
--   - 接入令牌只存 SHA-256 哈希，明文仅在生成时返回一次。
--
-- 关于令牌为何用 SHA-256 而不是 PBKDF2：
--   PBKDF2 慢是为了对抗「低熵的人类密码」被暴力穷举。接入令牌由服务端
--   用 crypto 随机生成 32 字节，熵已足够，穷举不可行；此时再用慢哈希
--   只会让每次信令握手都付出无谓的代价。故用一次 SHA-256。

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

-- tunnel：一台主机端 agent 的接入登记及其暴露策略。
CREATE TABLE IF NOT EXISTS tunnels (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  -- 接入令牌的 SHA-256 十六进制摘要。明文不落库。
  token_hash    TEXT NOT NULL UNIQUE,
  -- 令牌前 8 位，仅供管理后台辨认，不构成凭据。
  token_prefix  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 暴露端口白名单。agent 只会为这些端口建立本地转发；未列出的端口一律拒绝。
CREATE TABLE IF NOT EXISTS tunnel_ports (
  id        TEXT PRIMARY KEY,
  tunnel_id TEXT NOT NULL REFERENCES tunnels(id) ON DELETE CASCADE,
  port      INTEGER NOT NULL,
  protocol  TEXT NOT NULL DEFAULT 'tcp',
  enabled   INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tunnel_id, port, protocol)
);

-- 路由：/t/<slug> -> 某台主机上的目标服务。
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

-- 已接入的主机端 agent。由信令房间在连接建立与心跳时 UPSERT。
CREATE TABLE IF NOT EXISTS agents (
  id             TEXT PRIMARY KEY,
  tunnel_id      TEXT NOT NULL UNIQUE REFERENCES tunnels(id) ON DELETE CASCADE,
  hostname       TEXT,
  version        TEXT,
  -- 最近一次上报的本地可达端口，JSON 数组文本。用于后台核对白名单。
  reported_ports TEXT NOT NULL DEFAULT '[]',
  last_seen      INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_routes_slug ON routes (slug);
CREATE INDEX IF NOT EXISTS idx_routes_tunnel ON routes (tunnel_id);
CREATE INDEX IF NOT EXISTS idx_tunnel_ports_tunnel ON tunnel_ports (tunnel_id);
CREATE INDEX IF NOT EXISTS idx_tunnels_token ON tunnels (token_hash);
CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents (last_seen);
