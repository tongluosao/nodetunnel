/**
 * Worker 运行时绑定的类型定义。
 *
 * 与 wrangler.jsonc 中的 vars / durable_objects / d1_databases 保持一致。
 * 修改 wrangler.jsonc 后应同步更新此文件（或运行 `wrangler types` 重新生成）。
 */

export interface Env {
  /** 信令房间 Durable Object 命名空间。每个 tunnel 一个房间实例。 */
  SIGNALING_ROOM: DurableObjectNamespace;
  /** D1 数据库：管理员、tunnel、路由、主机端 agent。 */
  DB: D1Database;

  /** 部署版本号，来自 wrangler vars。 */
  NODETUNNEL_VERSION: string;

  /** 会话令牌签名密钥。缺失即拒绝启动。 */
  ADMIN_SESSION_SECRET: string;
  /** 管理后台来源，用于 CORS。 */
  NT_ADMIN_ORIGIN?: string;
}
