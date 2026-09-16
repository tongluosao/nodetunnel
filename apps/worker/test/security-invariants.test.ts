import { describe, expect, it } from 'vitest';
import { isPortAllowed, isTargetHostAllowed, type TunnelPort } from '@nodetunnel/shared';

/**
 * 安全不变式测试。
 *
 * 本项目的安全边界是「入站默认拒绝 + 只放行白名单端口 + 只允许内网目标」。
 * 这三条一旦被改坏，必须立刻有测试失败 —— 它们不是功能特性，而是
 * 用户内网的唯一屏障。
 */

const PORTS: TunnelPort[] = [
  { port: 8080, protocol: 'tcp' },
  { port: 3000, protocol: 'tcp' },
  { port: 5353, protocol: 'udp' },
];

describe('入站端口白名单', () => {
  it('放行白名单中声明的 TCP 端口', () => {
    expect(isPortAllowed(PORTS, 8080, 'tcp')).toBe(true);
    expect(isPortAllowed(PORTS, 3000, 'tcp')).toBe(true);
  });

  it('未声明的端口一律拒绝', () => {
    // 默认拒绝：这是与重构前 EasyTier ACL 保持一致的核心语义。
    for (const port of [80, 443, 22, 3306, 6379, 8081, 9999]) {
      expect(isPortAllowed(PORTS, port, 'tcp')).toBe(false);
    }
  });

  it('声明为 UDP 的端口不会被 TCP 请求放行', () => {
    // 协议必须严格匹配，否则「只放行 UDP」会意外打开 TCP。
    expect(isPortAllowed(PORTS, 5353, 'udp')).toBe(true);
    expect(isPortAllowed(PORTS, 5353, 'tcp')).toBe(false);
  });

  it('空白名单拒绝一切端口', () => {
    expect(isPortAllowed([], 8080, 'tcp')).toBe(false);
    expect(isPortAllowed([], 80, 'tcp')).toBe(false);
  });
});

describe('目标地址范围', () => {
  it('允许回环地址', () => {
    expect(isTargetHostAllowed('127.0.0.1')).toBe(true);
    expect(isTargetHostAllowed('127.1.2.3')).toBe(true);
    expect(isTargetHostAllowed('localhost')).toBe(true);
  });

  it('允许私有网段', () => {
    expect(isTargetHostAllowed('10.0.0.5')).toBe(true);
    expect(isTargetHostAllowed('192.168.1.10')).toBe(true);
    expect(isTargetHostAllowed('172.16.0.1')).toBe(true);
    expect(isTargetHostAllowed('172.31.255.254')).toBe(true);
  });

  it('拒绝公网 IPv4 地址', () => {
    // 若允许填公网地址，这套系统会变成开放的匿名代理，被用来隐藏攻击来源。
    for (const host of ['8.8.8.8', '1.1.1.1', '203.0.113.5', '104.16.0.1']) {
      expect(isTargetHostAllowed(host)).toBe(false);
    }
  });

  it('拒绝 172 网段中不属于私有的部分', () => {
    // 172.16.0.0/12 的边界容易写错，这里专门钉住两侧。
    expect(isTargetHostAllowed('172.15.0.1')).toBe(false);
    expect(isTargetHostAllowed('172.32.0.1')).toBe(false);
  });
});
