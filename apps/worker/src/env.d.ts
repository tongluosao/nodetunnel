/**
 * Worker 运行时绑定的类型定义。
 *
 * 与 wrangler.jsonc 中的 vars / durable_objects / d1_databases 保持一致。
 * 修改 wrangler.jsonc 后应同步更新此文件（或运行 `wrangler types` 重新生成）。
 */

export interface Env {
  /** EasyTier 中继 Durable Object 命名空间。 */
  EASYTIER_RELAY: DurableObjectNamespace;
  /** D1 数据库：管理员、tunnel、路由、节点。 */
  DB: D1Database;

  /** 部署版本号，来自 wrangler vars。 */
  NODETUNNEL_VERSION: string;

  /** 会话令牌签名密钥。缺失即拒绝启动。 */
  ADMIN_SESSION_SECRET: string;
  /** 组网密码加密密钥（base64，32 字节）。缺失即拒绝启动。 */
  NT_MASTER_KEY: string;
  /** 中继专用组网名称。 */
  NT_RELAY_NETWORK_NAME: string;
  /** 中继专用组网密钥。 */
  NT_RELAY_NETWORK_SECRET: string;
  /** 管理后台来源，用于 CORS。 */
  NT_ADMIN_ORIGIN?: string;
}
