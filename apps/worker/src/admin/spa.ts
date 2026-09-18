import type { Env } from '../env.js';

/**
 * 管理后台 SPA 的静态资源分发。
 *
 * 部署形态下 Worker 自身的域名就是管理后台入口：静态资源由 assets 绑定提供，
 * 前端与 /api/v1 同源，因此不再需要 CORS，也不需要开发期的 Vite 代理。
 *
 * 返回 undefined 表示「这个请求不该由管理后台接管」，交给调用方继续兜底 ——
 * 本地开发还没构建 apps/admin 时，仍然能拿到纯文本运行信息页。
 */
export async function serveAdminSpa(request: Request, env: Env): Promise<Response | undefined> {
  const url = new URL(request.url);

  // 未配置 assets 时（例如本地只想跑纯 API），交回上层走纯文本页，
  // 而不是抛 TypeError 让整个请求变成 500。
  if (env.ASSETS === undefined) {
    return undefined;
  }

  // 只有读取类方法才可能是静态资源请求。其余方法直接交回上层，
  // 避免一个误发的 POST 被静默变成 200 的 index.html 而掩盖问题。
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return undefined;
  }

  const asset = await env.ASSETS.fetch(request);
  if (asset.status !== 404) {
    return asset;
  }

  // 未命中时只对「浏览器导航」回退到 index.html（vue-router 深链刷新）。
  // 若对一切 404 都回退，缺失的脚本/样式也会返回 HTML，
  // 浏览器会因 MIME 不匹配拒绝执行，反而掩盖真实的 404。
  if (!isNavigationRequest(request)) {
    return undefined;
  }

  // 取目录根而不是 /index.html：assets 默认的 html_handling 会把
  // /index.html 重定向到 /，直接取根可以少一次跳转且语义更稳。
  const index = await env.ASSETS.fetch(new URL('/', url).toString());
  return index.status === 404 ? undefined : index;
}

/** 地址栏导航（含 vue-router 深链刷新）的 Accept 头必然包含 text/html。 */
function isNavigationRequest(request: Request): boolean {
  const accept = request.headers.get('Accept') ?? '';
  return accept.includes('text/html');
}
