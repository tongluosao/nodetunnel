import { describe, expect, it } from 'vitest';
import { AclAction, AclChainType, AclProtocol } from '@nodetunnel/shared';
import { buildBrowserAcl, buildTunnelAcl, renderAclToml } from '../src/acl.js';

/**
 * ACL 是本项目的核心安全控制。
 * 这些测试锁定「默认拒绝」不变式，任何放宽都必须让测试失败。
 */
describe('buildTunnelAcl', () => {
  it('入站链默认动作必须是 Drop', () => {
    const acl = buildTunnelAcl([]);
    const inbound = acl.chains.find((chain) => chain.chainType === AclChainType.Inbound);
    expect(inbound).toBeDefined();
    expect(inbound?.defaultAction).toBe(AclAction.Drop);
  });

  it('转发链默认动作必须是 Drop，防止作为跳板访问其他隧道', () => {
    const acl = buildTunnelAcl([]);
    const forward = acl.chains.find((chain) => chain.chainType === AclChainType.Forward);
    expect(forward?.defaultAction).toBe(AclAction.Drop);
  });

  it('未声明端口时不生成任何 Allow 规则', () => {
    const acl = buildTunnelAcl([]);
    const allRules = acl.chains.flatMap((chain) => chain.rules);
    expect(allRules).toHaveLength(0);
  });

  it('只为显式声明的端口生成 Allow 规则', () => {
    const acl = buildTunnelAcl([
      { port: 8080, protocol: 'tcp' },
      { port: 5353, protocol: 'udp' },
    ]);
    const inbound = acl.chains.find((chain) => chain.chainType === AclChainType.Inbound);
    expect(inbound?.rules).toHaveLength(2);

    const tcpRule = inbound?.rules.find((rule) => rule.protocol === AclProtocol.TCP);
    expect(tcpRule?.ports).toEqual(['8080']);
    expect(tcpRule?.action).toBe(AclAction.Allow);

    const udpRule = inbound?.rules.find((rule) => rule.protocol === AclProtocol.UDP);
    expect(udpRule?.ports).toEqual(['5353']);
  });

  it('优先级随规则序号递减，保证匹配顺序稳定', () => {
    const acl = buildTunnelAcl([
      { port: 80, protocol: 'tcp' },
      { port: 443, protocol: 'tcp' },
    ]);
    const inbound = acl.chains.find((chain) => chain.chainType === AclChainType.Inbound);
    const priorities = inbound?.rules.map((rule) => rule.priority) ?? [];
    expect(priorities).toEqual([1000, 999]);
  });
});

describe('buildBrowserAcl', () => {
  it('浏览器节点禁止一切入站', () => {
    const acl = buildBrowserAcl();
    const inbound = acl.chains.find((chain) => chain.chainType === AclChainType.Inbound);
    expect(inbound?.defaultAction).toBe(AclAction.Drop);
    expect(inbound?.rules).toHaveLength(0);
  });

  it('浏览器节点同样禁止转发', () => {
    const acl = buildBrowserAcl();
    const forward = acl.chains.find((chain) => chain.chainType === AclChainType.Forward);
    expect(forward?.defaultAction).toBe(AclAction.Drop);
    expect(forward?.rules).toHaveLength(0);
  });

  it('浏览器节点允许出站，以便主动连接隧道服务', () => {
    const acl = buildBrowserAcl();
    const outbound = acl.chains.find((chain) => chain.chainType === AclChainType.Outbound);
    expect(outbound?.defaultAction).toBe(AclAction.Allow);
  });
});

describe('renderAclToml', () => {
  it('生成合法的 TOML 结构，字段名与 easytier-core schema 一致', () => {
    const toml = renderAclToml(buildTunnelAcl([{ port: 8080, protocol: 'tcp' }]));
    expect(toml).toContain('[[acl.acl_v1.chains]]');
    expect(toml).toContain('chain_type = 1');
    expect(toml).toContain('default_action = 2');
    expect(toml).toContain('[[acl.acl_v1.chains.rules]]');
    expect(toml).toContain('action = 1');
    expect(toml).toContain('ports = ["8080"]');
    expect(toml).toContain('protocol = 1');
  });

  it('默认拒绝链不输出任何 rules 段', () => {
    const toml = renderAclToml(buildBrowserAcl());
    expect(toml).not.toContain('[[acl.acl_v1.chains.rules]]');
  });

  it('输出不以多余空行结尾', () => {
    const toml = renderAclToml(buildTunnelAcl([{ port: 80, protocol: 'tcp' }]));
    expect(toml.endsWith('\n')).toBe(false);
  });
});
