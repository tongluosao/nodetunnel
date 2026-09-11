/** 项目级常量。三端共用，避免各处硬编码不一致。 */

/** 路由 URL 前缀。用户通过 `https://<worker>/t/<slug>/...` 访问隧道服务。 */
export const ROUTE_PREFIX = '/t';

/** 管理 API 前缀。 */
export const ADMIN_API_PREFIX = '/api/v1';

/** 配置服务器 WebSocket 路径（EasyTier 客户端 `--config-server` 使用）。 */
export const CONFIG_SERVER_PATH = '/api/v1/config-server';

/** EasyTier 中继 WebSocket 路径。 */
export const RELAY_PATH = '/relay';

/** 会话 Cookie 名。 */
export const SESSION_COOKIE = 'nt_session';

/** 会话有效期（秒）：12 小时。 */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** 节点视为「在线」的最近心跳窗口（秒）。 */
export const NODE_ONLINE_WINDOW_SECONDS = 300;

/** 上游请求默认超时（毫秒）。 */
export const UPSTREAM_TIMEOUT_MS = 30_000;

/** 单次隧道响应允许的最大字节数。 */
export const MAX_TUNNEL_RESPONSE_BYTES = 32 * 1024 * 1024;

/** 中继组网默认网络名。 */
export const DEFAULT_RELAY_NETWORK_NAME = 'nodetunnel-relay';
