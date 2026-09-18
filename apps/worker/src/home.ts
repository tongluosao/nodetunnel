import type { Env } from './env.js';
import { countOnlineAgents } from './nodetunnel/agent-registry.js';
import { resolveAgentUrl, resolveSignalingUrl } from './nodetunnel/endpoints.js';

/**
 * 运行状态接口。
 *
 * 单独暴露而不是让它落进管理后台的 SPA 回退：监控脚本与 e2e 脚本依赖
 * /health 返回 JSON，一旦被 SPA 的 index.html 吞掉就会静默失效。
 */
export async function handleHealth(env: Env): Promise<Response> {
  const online = await countOnlineAgents(env, Date.now() - 120_000).catch(() => 0);
  return Response.json({
    ok: true,
    service: 'nodetunnel',
    version: env.NODETUNNEL_VERSION,
    // 保持与旧版 /health 的字段形状兼容，便于既有监控脚本继续工作。
    relay: {
      ok: true,
      state: 'running',
      onlineAgents: online,
    },
  });
}

/**
 * 纯文本兜底页。
 *
 * 只在静态资源不可用时才会被访问到（例如本地开发还没构建 apps/admin）。
 * 部署形态下 `/` 由管理后台 SPA 接管，这里仅作为降级路径保留。
 */
export async function handleHome(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname !== '/') {
    return new Response('Not found', { status: 404 });
  }

  const origin = `${url.protocol}//${url.host}`;
  const lines = [
    'NodeTunnel',
    '',
    `版本: ${env.NODETUNNEL_VERSION}`,
    '',
    '主机端接入地址（用接入令牌认证）：',
    `  ${resolveAgentUrl(origin)}`,
    '',
    '浏览器门户信令地址：',
    `  ${resolveSignalingUrl(origin)}`,
    '',
    '隧道访问方式：专属域名。',
    '  在管理后台的「路由管理」中给某条路由填写完整域名后，',
    '  访问该域名即直接打开对应应用（应用发出的绝对路径无需改写）。',
    '',
    '管理后台：本 Worker 自身的域名即入口，接口前缀为 /api/v1。',
    '  （当前未检测到静态资源，请先执行 pnpm build 生成 apps/admin/dist。）',
  ];

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
