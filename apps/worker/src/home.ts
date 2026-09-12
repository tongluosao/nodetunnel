import { ROUTE_PREFIX } from '@nodetunnel/shared';

import type { Env } from './env.js';
import { resolveConfigServerUrl, resolveRelayUrl } from './nodetunnel/endpoints.js';

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
    const relayHealth = await probeRelay(env);
    return Response.json({
      ok: true,
      service: 'nodetunnel',
      version: env.NODETUNNEL_VERSION,
      relay: relayHealth,
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
    '可用于普通 EasyTier 客户端的配置服务器地址：',
    `  ${resolveConfigServerUrl(origin)}`,
    '',
    '中继地址（配合组网名使用）：',
    `  ${resolveRelayUrl(origin, '<组网名>')}`,
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

/** 探测中继健康状态；失败不影响首页与根健康检查的可用性。 */
async function probeRelay(
  env: Env,
): Promise<{ ok: boolean; state: string; connections: number }> {
  try {
    const healthRequest = new Request('https://internal/health', { method: 'GET' });
    const response = await env.EASYTIER_RELAY.getByName('primary').fetch(healthRequest);
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      ok: response.ok,
      state: typeof body.state === 'string' ? body.state : 'unknown',
      connections: typeof body.connections === 'number' ? body.connections : 0,
    };
  } catch {
    return { ok: false, state: 'stopped', connections: 0 };
  }
}
