import { describe, expect, it } from 'vitest';
import { renderBrowserNodeConfig, renderTunnelNodeConfig } from '../src/config.js';

describe('renderTunnelNodeConfig', () => {
  const base = {
    instanceId: '11111111-1111-4111-8111-111111111111',
    instanceName: 'my-host',
    networkName: 'tunnel-a',
    networkSecret: 'a-very-secret-network-key',
    relayUrl: 'wss://nodetunnel.example.workers.dev/relay',
    ports: [{ port: 8080, protocol: 'tcp' as const }],
  };

  it('自动填入初始节点（中继）', () => {
    const toml = renderTunnelNodeConfig(base);
    expect(toml).toContain('[[peer]]');
    expect(toml).toContain('uri = "wss://nodetunnel.example.workers.dev/relay"');
  });

  it('自动填入组网名与组网密钥', () => {
    const toml = renderTunnelNodeConfig(base);
    expect(toml).toContain('network_name = "tunnel-a"');
    expect(toml).toContain('network_secret = "a-very-secret-network-key"');
  });

  it('不自行监听端口', () => {
    const toml = renderTunnelNodeConfig(base);
    expect(toml).toContain('listeners = []');
  });

  it('默认拒绝入站，只放行声明的端口', () => {
    const toml = renderTunnelNodeConfig(base);
    expect(toml).toContain('default_action = 2');
    expect(toml).toContain('ports = ["8080"]');
  });

  it('默认不开启子网代理，减少暴露面', () => {
    const toml = renderTunnelNodeConfig(base);
    expect(toml).not.toContain('enable_subnet_proxy = true');
  });

  it('显式要求时才开启子网代理', () => {
    const toml = renderTunnelNodeConfig({ ...base, enableSubnetProxy: true });
    expect(toml).toContain('enable_subnet_proxy = true');
  });

  it('默认启用加密', () => {
    const toml = renderTunnelNodeConfig(base);
    expect(toml).toContain('enable_encryption = true');
  });

  it('可显式关闭加密', () => {
    const toml = renderTunnelNodeConfig({ ...base, encryption: false });
    expect(toml).toContain('enable_encryption = false');
  });

  it('包含 ipv4 时输出该字段', () => {
    const toml = renderTunnelNodeConfig({ ...base, ipv4: '10.144.144.5/24' });
    expect(toml).toContain('ipv4 = "10.144.144.5/24"');
  });
});

describe('renderBrowserNodeConfig', () => {
  const base = {
    instanceId: '22222222-2222-4222-8222-222222222222',
    instanceName: 'browser',
    networkName: 'tunnel-a',
    networkSecret: 'a-very-secret-network-key',
    relayUrl: 'wss://nodetunnel.example.workers.dev/relay',
    ipv4: '10.144.144.9/24',
  };

  it('浏览器节点禁止入站', () => {
    const toml = renderBrowserNodeConfig(base);
    expect(toml).toContain('default_action = 2');
    expect(toml).not.toContain('[[acl.acl_v1.chains.rules]]');
  });

  it('使用 smoltcp 且不接管 TUN', () => {
    const toml = renderBrowserNodeConfig(base);
    expect(toml).toContain('no_tun = true');
    expect(toml).toContain('use_smoltcp = true');
  });

  it('填入浏览器节点的 ipv4', () => {
    const toml = renderBrowserNodeConfig(base);
    expect(toml).toContain('ipv4 = "10.144.144.9/24"');
  });
});
