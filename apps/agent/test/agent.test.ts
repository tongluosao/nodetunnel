import { describe, expect, it } from 'vitest';
import { parseArgs, toWebSocketUrl } from '../src/config.ts';
import { isForwardError, forwardLocal } from '../src/local-forward.ts';

/**
 * agent 的纯逻辑测试。
 *
 * 重点是安全边界：agent 直连用户内网，是「能否访问本机某个端口」
 * 的最终决定者，因此它的白名单判断必须独立成立，不能依赖服务端。
 */

describe('参数解析', () => {
  it('缺少 --server 时报错', () => {
    const result = parseArgs(['--token', 'nt_x']);
    expect(result.ok).toBe(false);
  });

  it('缺少 --token 时报错', () => {
    const result = parseArgs(['--server', 'https://example.workers.dev']);
    expect(result.ok).toBe(false);
  });

  it('解析 --key=value 写法', () => {
    const result = parseArgs([
      '--server=https://example.workers.dev',
      '--token=nt_abc',
      '--ports=8080,3000',
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.server).toBe('https://example.workers.dev');
      expect(result.config.allowedPorts).toEqual([3000, 8080]);
    }
  });

  it('解析 --key value 写法', () => {
    const result = parseArgs(['--server', 'https://example.workers.dev', '--token', 'nt_abc']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.token).toBe('nt_abc');
    }
  });

  it('未指定端口时白名单为空，而不是默认全开', () => {
    // 默认拒绝是安全不变式：配置漏填的后果应是「用不了」而非「内网暴露」。
    const result = parseArgs(['--server', 'https://x.dev', '--token', 'nt_a']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.allowedPorts).toEqual([]);
    }
  });

  it('端口去重并排序', () => {
    const result = parseArgs([
      '--server',
      'https://x.dev',
      '--token',
      'nt_a',
      '--ports',
      '8080,3000,8080, 80',
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.allowedPorts).toEqual([80, 3000, 8080]);
    }
  });

  it('拒绝越界端口', () => {
    for (const bad of ['0', '65536', '-1', 'abc']) {
      const result = parseArgs(['--server', 'https://x.dev', '--token', 'nt_a', '--ports', bad]);
      expect(result.ok).toBe(false);
    }
  });

  it('拒绝非 http(s) 的 server', () => {
    const result = parseArgs(['--server', 'ws://x.dev', '--token', 'nt_a']);
    expect(result.ok).toBe(false);
  });

  it('server 末尾斜杠被规范化', () => {
    const result = parseArgs(['--server', 'https://x.dev/', '--token', 'nt_a']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.server).toBe('https://x.dev');
    }
  });

  it('--p2p=false 关闭 P2P', () => {
    const result = parseArgs(['--server', 'https://x.dev', '--token', 'nt_a', '--p2p=false']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.enableP2P).toBe(false);
    }
  });
});

describe('WebSocket 地址推导', () => {
  it('https 转 wss', () => {
    expect(toWebSocketUrl('https://x.dev', '/agent')).toBe('wss://x.dev/agent');
  });

  it('http 转 ws', () => {
    expect(toWebSocketUrl('http://127.0.0.1:8787', '/agent')).toBe('ws://127.0.0.1:8787/agent');
  });
});

describe('本地转发：安全边界', () => {
  it('端口不在白名单时拒绝，且不发起任何连接', async () => {
    // 这是最关键的一条：即使 Worker 判错、或将来出现绕过 Worker 的
    // 入站路径，这里也必须独立拦住。
    const result = await forwardLocal(
      { method: 'GET', path: '/', port: 9999, headers: {}, body: new Uint8Array(0) },
      [8080, 3000],
    );
    expect(isForwardError(result)).toBe(true);
    if (isForwardError(result)) {
      expect(result.code).toBe('port_not_allowed');
    }
  });

  it('空白名单拒绝一切端口', async () => {
    const result = await forwardLocal(
      { method: 'GET', path: '/', port: 8080, headers: {}, body: new Uint8Array(0) },
      [],
    );
    expect(isForwardError(result)).toBe(true);
  });
});
