import { describe, expect, it } from 'vitest';
import {
  AclAction,
  AclChainType,
  validateNetworkName,
  validatePassword,
  validateSlug,
  validateTargetHost,
  validateTunnelPorts,
  validateUsername,
} from '@nodetunnel/shared';
import { buildBrowserAcl, buildTunnelAcl, renderTunnelNodeConfig } from '@nodetunnel/protocol';

/**
 * 端到端的安全不变式：从「管理员配置的端口白名单」到「下发给客户端的 TOML」，
 * 必须始终保持「默认拒绝入站、仅放行白名单端口」。
 *
 * 这组测试是需求 1.3 与需求 3 的核心验收依据。
 */
describe('隧道配置下发的安全不变式', () => {
  it('未配置任何端口时，下发的配置不含任何 Allow 规则', () => {
    const config = renderTunnelNodeConfig({
      instanceId: '11111111-1111-4111-8111-111111111111',
      instanceName: 'host-1',
      networkName: 'tunnel-a',
      networkSecret: 'a-sufficiently-long-secret',
      relayUrl: 'wss://example.workers.dev/relay?network=tunnel-a',
      ports: [],
    });

    expect(config).toContain('default_action = 2');
    expect(config).not.toContain('[[acl.acl_v1.chains.rules]]');
  });

  it('只放行被声明的端口，其余端口默认拒绝', () => {
    const config = renderTunnelNodeConfig({
      instanceId: '11111111-1111-4111-8111-111111111111',
      instanceName: 'host-1',
      networkName: 'tunnel-a',
      networkSecret: 'a-sufficiently-long-secret',
      relayUrl: 'wss://example.workers.dev/relay?network=tunnel-a',
      ports: [{ port: 8080, protocol: 'tcp' }],
    });

    expect(config).toContain('ports = ["8080"]');
    expect(config).toContain('action = 1');
    // 未声明的端口不得出现在任何 Allow 规则中。
    expect(config).not.toContain('ports = ["80"]');
    expect(config).not.toContain('ports = ["443"]');
  });

  it('转发链默认拒绝，隧道节点不能作为访问其他隧道的跳板', () => {
    const acl = buildTunnelAcl([{ port: 8080, protocol: 'tcp' }]);
    const forward = acl.chains.find((chain) => chain.chainType === AclChainType.Forward);
    expect(forward?.defaultAction).toBe(AclAction.Drop);
  });

  it('浏览器节点不接受任何入站连接', () => {
    const acl = buildBrowserAcl();
    const inbound = acl.chains.find((chain) => chain.chainType === AclChainType.Inbound);
    expect(inbound?.defaultAction).toBe(AclAction.Drop);
    expect(inbound?.rules).toHaveLength(0);
  });
});

/**
 * 管理 API 的输入校验。
 * 这些规则直接决定「什么样的配置能进入数据库」。
 */
describe('管理后台输入校验', () => {
  it('拒绝包含非法字符或位置错误的 slug', () => {
    expect(validateSlug('-leading').ok).toBe(false);
    expect(validateSlug('trailing-').ok).toBe(false);
    expect(validateSlug('with space').ok).toBe(false);
    expect(validateSlug('under_score').ok).toBe(false);
  });

  it('接受大写 slug 并规范化为小写', () => {
    const result = validateSlug('MyApp');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('myapp');
    }
  });

  it('接受合法的 slug 并统一转为小写', () => {
    const result = validateSlug('My-App-2');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('my-app-2');
    }
  });

  it('拒绝过短的密码', () => {
    expect(validatePassword('short1').ok).toBe(false);
  });

  it('拒绝纯字母或纯数字的密码', () => {
    expect(validatePassword('abcdefghijklmn').ok).toBe(false);
    expect(validatePassword('123456789012345').ok).toBe(false);
  });

  it('接受足够强度的密码', () => {
    expect(validatePassword('nodetunnel-2026').ok).toBe(true);
  });

  it('拒绝带路径或端口的目标主机', () => {
    expect(validateTargetHost('10.0.0.1:8080').ok).toBe(false);
    expect(validateTargetHost('host/path').ok).toBe(false);
  });

  it('接受 IPv4 与域名形式的目标主机', () => {
    expect(validateTargetHost('10.144.144.5').ok).toBe(true);
    expect(validateTargetHost('my-host.internal').ok).toBe(true);
  });

  it('端口白名单去重并按协议与端口排序', () => {
    const result = validateTunnelPorts([
      { port: 8080, protocol: 'tcp' },
      { port: 80, protocol: 'tcp' },
      { port: 8080, protocol: 'tcp' },
      { port: 53, protocol: 'udp' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { port: 80, protocol: 'tcp' },
        { port: 8080, protocol: 'tcp' },
        { port: 53, protocol: 'udp' },
      ]);
    }
  });

  it('拒绝超出范围的端口', () => {
    expect(validateTunnelPorts([{ port: 0, protocol: 'tcp' }]).ok).toBe(false);
    expect(validateTunnelPorts([{ port: 70000, protocol: 'tcp' }]).ok).toBe(false);
  });

  it('拒绝非法的组网名', () => {
    expect(validateNetworkName('with space').ok).toBe(false);
    expect(validateNetworkName('').ok).toBe(false);
    expect(validateNetworkName('valid-net_1.0').ok).toBe(true);
  });

  it('拒绝过短的用户名', () => {
    expect(validateUsername('ab').ok).toBe(false);
    expect(validateUsername('admin').ok).toBe(true);
  });
});
