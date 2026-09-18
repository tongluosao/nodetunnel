/**
 * Worker 运行时绑定的类型定义。
 *
 * 与 wrangler.jsonc 中的 vars / durable_objects / d1_databases / assets 保持一致。
 * 修改 wrangler.jsonc 后应同步更新此文件（或运行 `wrangler types` 重新生成）。
 */

export interface Env {
  /** 信令房间 Durable Object 命名空间。每个 tunnel 一个房间实例。 */
  SIGNALING_ROOM: DurableObjectNamespace;
  /** D1 数据库：管理员、tunnel、路由、主机端 agent。 */
  DB: D1Database;
  /**
   * 管理后台静态资源（apps/admin 的构建产物）。
   *
   * 由 wrangler.jsonc 的 assets 配置注入。必须配合 run_worker_first 使用：
   * 否则 Cloudflare 的静态资源路由会抢在 Worker 之前命中同名文件，
   * 专属域名下的应用请求会被管理后台的资源截胡。
   *
   * 声明为可选是为了让「只跑 API、没构建前端」的本地开发仍然可用，
   * 由 admin/spa.ts 显式降级而不是抛错。
   */
  ASSETS?: Fetcher;

  /** 部署版本号，来自 wrangler vars。 */
  NODETUNNEL_VERSION: string;

  /** 会话令牌签名密钥。缺失即拒绝启动。 */
  ADMIN_SESSION_SECRET: string;
  /**
   * 管理后台来源，仅用于开发期跨端口调试的 CORS。
   * 部署形态下前端与 Worker 同源，无需配置。
   */
  NT_ADMIN_ORIGIN?: string;
}
