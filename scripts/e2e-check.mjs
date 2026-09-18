/**
 * 端到端验证：初始化 → 建隧道 → 建路由 → 起 agent → 经中继取回本机服务。
 *
 * 这是重构后最关键的验收脚本：它证明「访客经 Worker 中继访问到主机端
 * 本机端口」这条主链路真的通，而不只是类型检查通过。
 *
 * 用法（需先启动 Worker 与测试目标服务）：
 *   node scripts/e2e-check.mjs
 *
 * 退出码 0 表示全部通过。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WORKER = process.env.NT_WORKER ?? 'http://127.0.0.1:8787';
const TARGET_PORT = Number(process.env.TARGET_PORT ?? 9911);
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'nodetunnel-2026';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const workerUrl = new URL(WORKER);
const workerHost = workerUrl.hostname;
const workerPort = Number(workerUrl.port || 80);

/**
 * 经专属域名访问隧道。
 *
 * 用 node:http 显式指定 Host 头，而不是 fetch：
 *   1. Host 属于 Fetch 规范的「禁止头」，用 fetch 无法伪造；
 *   2. 顺带绕开 *.localhost 在本机首次解析极慢（实测 17s）导致的连接超时。
 * 隧道已不再提供 /t/<slug>/ 前缀入口，专属域名是唯一的访问方式。
 */
function tunnelGet(hostname, path = '/') {
  return new Promise((resolve) => {
    const req = http.get(
      { host: workerHost, port: workerPort, path, headers: { Host: hostname } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on('error', (error) => resolve({ status: 0, headers: {}, text: String(error) }));
  });
}

const failures = [];
let sessionCookie = '';
const children = [];

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

function check(label, condition) {
  if (condition) {
    console.log(`    OK  ${label}`);
  } else {
    console.log(`    FAIL ${label}`);
    failures.push(label);
  }
}

/** 带会话 Cookie 的 fetch。 */
async function api(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (sessionCookie !== '') {
    headers.set('Cookie', sessionCookie);
  }
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${WORKER}${path}`, { ...init, headers });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie !== null) {
    sessionCookie = setCookie.split(';')[0];
  }
  return response;
}

async function json(path, init) {
  const response = await api(path, init);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

/** 等待某个条件成立。 */
async function waitFor(label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log(`    超时等待：${label}`);
  return false;
}

function cleanup() {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // 已退出可忽略。
    }
  }
}

async function main() {
  console.log('=== NodeTunnel 端到端验证 ===\n');

  // ---------------------------------------------------------- 健康检查
  log('1/7', '健康检查');
  const health = await json('/health');
  check('GET /health 返回 200', health.status === 200);
  check('服务自报为 nodetunnel', health.body.service === 'nodetunnel');

  // ------------------------------------------------------------ 初始化
  log('2/7', '管理员初始化 / 登录');
  const status = await json('/api/v1/auth/status');
  check('auth/status 可访问', status.status === 200);

  if (status.body.initialized !== true) {
    const setup = await json('/api/v1/setup', {
      method: 'POST',
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
    });
    check('初始化成功（或已初始化）', setup.status === 200 || setup.status === 409);
  }

  if (sessionCookie === '') {
    const login = await json('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
    });
    check('登录成功', login.status === 200);
  } else {
    check('初始化时已签发会话', true);
  }

  // -------------------------------------------------------- 未认证被拒
  log('3/7', '安全不变式：未认证必须被拒');
  const saved = sessionCookie;
  sessionCookie = '';
  const denied = await json('/api/v1/tunnels');
  check('未带会话访问 /tunnels 返回 401', denied.status === 401);
  sessionCookie = saved;

  // ---------------------------------------------------------- 建隧道
  log('4/7', '创建隧道（含端口白名单与一次性令牌）');
  const tunnelName = `e2e-${Date.now()}`;
  const created = await json('/api/v1/tunnels', {
    method: 'POST',
    body: JSON.stringify({
      name: tunnelName,
      ports: [{ port: TARGET_PORT, protocol: 'tcp' }],
    }),
  });
  check('创建隧道返回 201', created.status === 201);

  const tunnel = created.body.tunnel;
  check('返回一次性明文令牌', typeof tunnel?.token === 'string' && tunnel.token.startsWith('nt_'));
  check('返回令牌前缀', typeof tunnel?.tokenPrefix === 'string' && tunnel.tokenPrefix.length === 8);

  const token = tunnel?.token ?? '';
  const tunnelId = tunnel?.id ?? '';

  // 列表里绝不能再出现明文令牌。
  const list = await json('/api/v1/tunnels');
  const listed = (list.body.tunnels ?? []).find((item) => item.id === tunnelId);
  check('列表不再返回明文令牌', listed !== undefined && listed.token === undefined);
  check('列表返回令牌前缀', listed?.tokenPrefix === tunnel?.tokenPrefix);

  // ---------------------------------------------------------- 建路由
  log('5/7', '创建路由（专属域名）');
  const slug = `e2e-${Date.now().toString(36)}`;
  // 专属域名用 <slug>.localhost：本机无需配 DNS 即可解析到 127.0.0.1。
  const hostname = `${slug}.localhost`;
  const route = await json('/api/v1/routes', {
    method: 'POST',
    body: JSON.stringify({
      slug,
      tunnelId,
      targetHost: '127.0.0.1',
      targetPort: TARGET_PORT,
      hostname,
    }),
  });
  check('创建路由返回 201', route.status === 201);
  check('路由 slug 正确', route.body.route?.slug === slug);
  check('路由专属域名正确', route.body.route?.hostname === hostname);

  // 公网地址必须被拒绝：否则本系统会变成开放代理。
  const blocked = await json('/api/v1/routes', {
    method: 'POST',
    body: JSON.stringify({
      slug: `${slug}-pub`,
      tunnelId,
      targetHost: '8.8.8.8',
      targetPort: TARGET_PORT,
      hostname: `${slug}-pub.localhost`,
    }),
  });
  check('拒绝公网目标地址', blocked.status === 403);

  // 同一域名不能绑到两条路由，否则分发结果取决于查询顺序。
  const dupHost = await json('/api/v1/routes', {
    method: 'POST',
    body: JSON.stringify({
      slug: `${slug}-dup`,
      tunnelId,
      targetHost: '127.0.0.1',
      targetPort: TARGET_PORT,
      hostname,
    }),
  });
  check('拒绝重复的专属域名', dupHost.status === 409);

  // ------------------------------------------------------- 未上线时拒绝
  log('6/7', '主机端未接入时中继必须明确失败');
  const offline = await tunnelGet(hostname, '/hello');
  check('未接入时返回 503', offline.status === 503);

  // --------------------------------------------------------- 起 agent
  log('7/7', '启动主机端 agent 并验证中继转发');
  const agent = spawn(
    process.execPath,
    [
      // 用打包产物而不是 src：Node 的 strip-types 不重写 `./x.js` → `./x.ts`，
      // 直接跑源码会在解析 @nodetunnel/shared 时找不到模块。
      join(root, 'apps/agent/dist/agent.mjs'),
      '--server',
      WORKER,
      '--token',
      token,
      '--ports',
      String(TARGET_PORT),
      '--p2p',
      'false',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(agent);

  agent.stdout.on('data', (chunk) => {
    process.stdout.write(`    agent| ${chunk}`);
  });
  agent.stderr.on('data', (chunk) => {
    process.stdout.write(`    agent! ${chunk}`);
  });

  const online = await waitFor('agent 上线', async () => {
    const agents = await json('/api/v1/agents');
    return (agents.body.agents ?? []).some((item) => item.tunnelId === tunnelId);
  });
  check('agent 已登记为在线', online);

  // 经专属域名取回本机服务内容。
  const proxied = await tunnelGet(hostname, '/hello');
  check('中继转发返回 200', proxied.status === 200);
  check('响应体来自目标服务', proxied.text.includes('来自隧道内服务的问候'));

  // 前缀入口已移除：/t/<slug>/ 必须不再可用（否则等于两套访问方式并存）。
  const legacy = await json(`/t/${slug}/hello`);
  check('/t/<slug>/ 前缀入口已移除（404）', legacy.status === 404);

  // 未在白名单中的端口必须被拒。
  const denyHost = `${slug}-deny.localhost`;
  const otherRoute = await json('/api/v1/routes', {
    method: 'POST',
    body: JSON.stringify({
      slug: `${slug}-deny`,
      tunnelId,
      targetHost: '127.0.0.1',
      targetPort: 9999,
      hostname: denyHost,
    }),
  });
  if (otherRoute.status === 201) {
    const deniedPort = await tunnelGet(denyHost, '/hello');
    check('非白名单端口被拒（403）', deniedPort.status === 403);
  }

  // ------------------------------------------------------------ 结果
  console.log('');
  if (failures.length > 0) {
    console.log(`=== 结果：失败（${failures.length} 项）===`);
    for (const item of failures) {
      console.log(`  - ${item}`);
    }
    cleanup();
    process.exit(1);
  }
  console.log('=== 结果：全部通过 ===');
  cleanup();
  process.exit(0);
}

main().catch((error) => {
  console.error('\n端到端验证异常：');
  console.error(error);
  cleanup();
  process.exit(1);
});
