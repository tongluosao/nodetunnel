/**
 * 信令接入使用的请求头名称。
 *
 * 单独成模块而不是放在 room.ts 里：业务层（src/nodetunnel/signaling-gateway.ts）
 * 需要在构造请求头时引用这些常量，但它不应该为了拿一个字符串常量
 * 就去导入 Durable Object 的实现文件 —— 那会让业务层在类型层面
 * 依赖 cloudflare:workers，也会让分层边界变得含糊。
 */

/** 隧道 id。由业务层在完成令牌/路由校验后填入。 */
export const TUNNEL_ID_HEADER = 'X-NT-Tunnel-Id';

/** 主机端上报的端口白名单（JSON 数组文本）。 */
export const TUNNEL_PORTS_HEADER = 'X-NT-Tunnel-Ports';

/** 主机端主机名与版本，仅用于后台展示。 */
export const HOSTNAME_HEADER = 'X-NT-Hostname';
export const VERSION_HEADER = 'X-NT-Version';

/** 访客请求的路由 slug。 */
export const ROUTE_SLUG_HEADER = 'X-NT-Route-Slug';

/** 中继请求的目标地址，由业务层解析路由后填入。 */
export const RELAY_TARGET_HOST_HEADER = 'X-NT-Target-Host';
export const RELAY_TARGET_PORT_HEADER = 'X-NT-Target-Port';
export const RELAY_SLUG_HEADER = 'X-NT-Slug';
