/**
 * 测试用的目标 HTTP 服务。
 *
 * 模拟「隧道节点上被暴露的服务」，用于验证 Worker 的 /t/<slug>/ 转发链路。
 * 仅用于本地测试，不参与构建产物。
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.TARGET_PORT ?? 9911);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);

  // 回显请求信息，便于确认转发是否保留了方法、路径、查询串与请求头。
  if (url.pathname === '/echo') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(
      JSON.stringify({
        service: 'nodetunnel-test-target',
        method: request.method,
        path: url.pathname,
        query: url.search,
        forwardedHost: request.headers['x-forwarded-host'] ?? null,
        route: request.headers['x-nodentunnel-route'] ?? null,
      }),
    );
    return;
  }

  if (url.pathname === '/hello') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>目标服务</title><h1>来自隧道内服务的问候</h1>');
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('目标服务：未找到该路径');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`测试目标服务已启动: http://127.0.0.1:${PORT}`);
});
