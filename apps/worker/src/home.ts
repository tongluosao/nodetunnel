import { ROUTE_PREFIX } from '@nodetunnel/shared';

import type { Env } from './env.js';
import { countOnlineAgents } from './nodetunnel/agent-registry.js';
import { resolveAgentUrl, resolveSignalingUrl } from './nodetunnel/endpoints.js';

/**
 * 首页与运行状态页。
 *
 * 不渲染任何管理界面：管理后台是独立部署的 SPA（apps/admin）。
 * 这里只返回纯文本运行信息，便于部署后快速确认服务可用。
 */
export async function handleHome(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  if (url.pathname === '/health') {
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

  if (url.pathname !== '/') {
    return new Response('Not found', { status: 404 });
  }

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
    '隧道访问前缀：',
    `  ${ROUTE_PREFIX}/<slug>/`,
    '',
    '管理后台由 apps/admin 单独部署，接口前缀为 /api/v1。',
  ];

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
