import { AGENT_PATH, SignalType, type SignalMessage } from '@nodetunnel/shared';
import { parseArgs, toWebSocketUrl } from './config.ts';
import { AgentClient } from './signaling-client.ts';
import { PeerManager } from './peer.ts';
import { log } from './log.ts';

/**
 * NodeTunnel 主机端桥接服务。
 *
 * 职责：
 *   1. 用接入令牌连上 Worker 的信令房间，保持在线；
 *   2. 把经隧道进来的请求转发到本机的白名单端口；
 *   3. 与浏览器访客尝试 P2P 直连（WebRTC），失败则由中继承载。
 *
 * 安全边界：只有 `--ports` 显式列出的端口会被转发，其余一律拒绝。
 * 这条判断在 agent 侧独立执行一次，不信任服务端的结论。
 */

const VERSION = '0.2.0';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    log('error', parsed.message);
    log(
      'info',
      '用法：nodetunnel-agent --server <Worker 地址> --token <接入令牌> [--ports 8080,3000]',
    );
    process.exit(2);
  }

  const config = parsed.config;

  log('info', 'NodeTunnel 主机端 agent 启动', {
    server: config.server,
    ports: config.allowedPorts.length === 0 ? '(未放行任何端口)' : config.allowedPorts,
    p2p: config.enableP2P,
  });

  if (config.allowedPorts.length === 0) {
    // 不是致命错误，但几乎肯定是配置疏漏，必须提醒。
    log('warn', '未放行任何端口：所有入站请求都会被拒绝。用 --ports 指定要暴露的本地端口。');
  }

  const peers = new PeerManager({
    // 只有启用 P2P 时才初始化 werift；否则连依赖都不加载。
    enabled: config.enableP2P,
    allowedPorts: config.allowedPorts,
    onLog: log,
  });

  const client = new AgentClient({
    url: toWebSocketUrl(config.server, AGENT_PATH),
    token: config.token,
    hostname: config.hostname,
    version: VERSION,
    allowedPorts: config.allowedPorts,
    onLog: log,
    onDescription: (message, sessionId) => {
      void peers.handleDescription(sessionId, message);
    },
    onCandidate: (message, sessionId) => {
      void peers.handleCandidate(sessionId, message);
    },
    onSessionClosed: (sessionId) => {
      peers.closeSession(sessionId);
    },
  });

  // 让 P2P 层能把本端 SDP/候选经信令发回访客。
  peers.bindSignaling((message: SignalMessage) => client.send(message));

  client.start();

  // 优雅退出：关闭信令连接，让 Worker 立刻把本机标记为离线。
  const shutdown = (signal: string): void => {
    log('info', `收到 ${signal}，正在退出`);
    peers.closeAll();
    client.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  log('error', '启动失败', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

// 让 SignalType 的引用不被 tree-shaking 误删，同时集中协议使用点。
export { SignalType };
