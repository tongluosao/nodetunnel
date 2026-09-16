/** 项目级常量。三端（Worker / agent / portal）共用，避免各处硬编码不一致。 */

/** 路由 URL 前缀。用户通过 `https://<worker>/t/<slug>/...` 访问被暴露的服务。 */
export const ROUTE_PREFIX = '/t';

/** 管理 API 前缀。 */
export const ADMIN_API_PREFIX = '/api/v1';

/**
 * 信令 WebSocket 路径。
 *
 * 主机端 agent 与浏览器访客都连到这里，由服务端按 tunnel 分房间。
 * 信令与中继回落复用同一条连接，用消息类型区分，不再开第二条通道。
 */
export const SIGNALING_PATH = '/signal';

/** 主机端 agent 专用路径（同样是 WebSocket，但是 agent 的接入点）。 */
export const AGENT_PATH = '/agent';

/** 会话 Cookie 名。 */
export const SESSION_COOKIE = 'nt_session';

/** 会话有效期（秒）：12 小时。 */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** agent 视为「在线」的最近心跳窗口（秒）。 */
export const AGENT_ONLINE_WINDOW_SECONDS = 120;

/** 上游 HTTP 请求默认超时（毫秒）。本地服务通常很快，超过即视为异常。 */
export const UPSTREAM_TIMEOUT_MS = 30_000;

/** 单次隧道响应允许的最大字节数。 */
export const MAX_TUNNEL_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * 单条信令消息允许的最大字节数。
 *
 * 信令报文（SDP/ICE/中继帧）都不应该很大；限制上限是为了避免
 * 单个客户端用超大消息把 Durable Object 的内存吃满。
 * 中继帧的响应体会被分片成多条消息传输。
 */
export const MAX_SIGNALING_MESSAGE_BYTES = 1024 * 1024;

/**
 * 中继帧的分片大小。
 *
 * 实测（scripts/poc/verify-datachannel.mjs）：单条 SCTP 消息上限为 64 KiB，
 * 超过会被库直接拒绝（max-message-size exceeded）。这里取 16 KiB，
 * 既留出足够余量，又让 WebSocket 与 DataChannel 两条路径可以共用同一套分片逻辑。
 */
export const RELAY_CHUNK_BYTES = 16 * 1024;

/** 访客连接等待主机端上线的超时（毫秒）。 */
export const HOST_WAIT_TIMEOUT_MS = 10_000;

/** 管理后台来源默认值，仅本地开发使用。 */
export const DEFAULT_ADMIN_ORIGIN = 'http://127.0.0.1:5173';
