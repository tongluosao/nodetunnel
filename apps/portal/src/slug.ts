/**
 * 路由 slug 校验。
 *
 * 门户从 URL 里读取 slug（例如访问 `/t/my-app/` 时 slug 为 `my-app`），
 * 在拿去建立信令连接之前先做一次本地校验：
 * 一个明显非法的 slug 没必要发起一次注定失败的 WebSocket 连接，
 * 本地就能给出更快的反馈。
 *
 * 规则必须与服务端 `validateSlug` 保持一致（小写字母/数字/短横线，
 * 1–63 字符，不能以短横线开头或结尾）—— 两边不一致会导致
 * 「本地放行但服务端拒绝」这种难查的情况。
 */

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

/**
 * 从当前页面路径解析 slug。
 *
 * 支持两种访问形态：
 *   - `/t/my-app/`：门户自身部署在 /t 前缀下；
 *   - `?slug=my-app`：查询参数显式指定，便于本地开发。
 *
 * 找不到时返回 undefined，由调用方给出明确提示而不是猜测。
 */
export function resolveSlugFromLocation(pathname: string, search: string): string | undefined {
  const params = new URLSearchParams(search);
  const fromQuery = params.get('slug');
  if (fromQuery !== null && fromQuery.trim() !== '') {
    const value = fromQuery.trim().toLowerCase();
    return isValidSlug(value) ? value : undefined;
  }

  const match = /^\/t\/([^/]+)/.exec(pathname);
  if (match === null) {
    return undefined;
  }
  const value = (match[1] ?? '').toLowerCase();
  return isValidSlug(value) ? value : undefined;
}
