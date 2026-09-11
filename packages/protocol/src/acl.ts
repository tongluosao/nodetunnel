import {
  AclAction,
  AclChainType,
  AclProtocol,
  type TunnelPort,
  type PortProtocol,
} from '@nodetunnel/shared';

/**
 * ACL 渲染。
 *
 * 安全模型（默认拒绝）：这是本项目最重要的安全控制，改动前必须确认以下不变式：
 *
 *   1. Inbound 链的 default_action 恒为 Drop —— 未被显式放行的端口一律不可达；
 *   2. Outbound 链用于浏览器/隧道节点的出站方向，浏览器节点额外收敛；
 *   3. Forward 链（子网代理）默认 Drop —— 隧道节点不得借此访问其他 tunnel；
 *   4. 只有 tunnel 配置里显式声明的端口才会生成 Allow 规则。
 *
 * 枚举取值来源：easytier-proto/proto/acl.proto。
 * TOML 结构来源：easytier-core/src/config/toml.rs（[acl.acl_v1.*]）。
 */

export interface AclRule {
  name: string;
  /** 数值越大优先级越高，0–65535。 */
  priority: number;
  protocol: AclProtocolValue;
  /** 端口字符串，支持单端口与区间，如 "8080" 或 "8000-8100"。 */
  ports: string[];
  action: AclActionValue;
  sourceIps: string[];
  destinationIps: string[];
  enabled: boolean;
}

export interface AclChain {
  name: string;
  chainType: AclChainTypeValue;
  defaultAction: AclActionValue;
  enabled: boolean;
  rules: AclRule[];
}

export interface AclConfig {
  chains: AclChain[];
}

type AclProtocolValue = (typeof AclProtocol)[keyof typeof AclProtocol];
type AclActionValue = (typeof AclAction)[keyof typeof AclAction];
type AclChainTypeValue = (typeof AclChainType)[keyof typeof AclChainType];

const PROTOCOL_VALUE: Record<PortProtocol, AclProtocolValue> = {
  tcp: AclProtocol.TCP,
  udp: AclProtocol.UDP,
};

/**
 * 为「隧道节点」（被访问的一方）构建 ACL。
 *
 * - Inbound：默认 Drop，仅放行 ports 中声明的端口。
 * - Outbound：允许（隧道节点需要主动出站做健康检查等）。
 * - Forward：默认 Drop，禁止把本节点当子网代理跳板。
 */
export function buildTunnelAcl(ports: TunnelPort[]): AclConfig {
  const allowRules: AclRule[] = ports.map((entry, index) => ({
    name: `allow-${entry.protocol}-${entry.port}`,
    // 优先级从高到低递减，保证顺序稳定且可读。
    priority: 1000 - index,
    protocol: PROTOCOL_VALUE[entry.protocol],
    ports: [String(entry.port)],
    action: AclAction.Allow,
    sourceIps: [],
    destinationIps: [],
    enabled: true,
  }));

  return {
    chains: [
      {
        name: 'tunnel-inbound',
        chainType: AclChainType.Inbound,
        // 不变式 1：默认拒绝所有入站。
        defaultAction: AclAction.Drop,
        enabled: true,
        rules: allowRules,
      },
      {
        name: 'tunnel-outbound',
        chainType: AclChainType.Outbound,
        defaultAction: AclAction.Allow,
        enabled: true,
        rules: [],
      },
      {
        name: 'tunnel-forward',
        chainType: AclChainType.Forward,
        // 不变式 3：禁止作为转发跳板访问其他隧道。
        defaultAction: AclAction.Drop,
        enabled: true,
        rules: [],
      },
    ],
  };
}

/**
 * 为「浏览器节点」（访问者）构建 ACL。
 *
 * 需求 3 明确要求浏览器节点的 ACL 为「禁止入站」：
 * 浏览器节点只作为客户端主动发起连接，不接受任何入站流量。
 * 因此 Inbound 与 Forward 均为默认 Drop 且无任何 Allow 规则。
 */
export function buildBrowserAcl(): AclConfig {
  return {
    chains: [
      {
        name: 'browser-inbound',
        chainType: AclChainType.Inbound,
        defaultAction: AclAction.Drop,
        enabled: true,
        rules: [],
      },
      {
        name: 'browser-outbound',
        chainType: AclChainType.Outbound,
        defaultAction: AclAction.Allow,
        enabled: true,
        rules: [],
      },
      {
        name: 'browser-forward',
        chainType: AclChainType.Forward,
        defaultAction: AclAction.Drop,
        enabled: true,
        rules: [],
      },
    ],
  };
}

/** 把 ACL 配置渲染为 easytier TOML 片段（不含结尾空行）。 */
export function renderAclToml(acl: AclConfig): string {
  const lines: string[] = [];
  for (const chain of acl.chains) {
    lines.push('[[acl.acl_v1.chains]]');
    lines.push(`name = ${tomlString(chain.name)}`);
    lines.push(`chain_type = ${chain.chainType}`);
    lines.push(`enabled = ${chain.enabled}`);
    lines.push(`default_action = ${chain.defaultAction}`);
    for (const rule of chain.rules) {
      lines.push('');
      lines.push('[[acl.acl_v1.chains.rules]]');
      lines.push(`name = ${tomlString(rule.name)}`);
      lines.push(`priority = ${rule.priority}`);
      lines.push(`protocol = ${rule.protocol}`);
      lines.push(`action = ${rule.action}`);
      lines.push(`enabled = ${rule.enabled}`);
      if (rule.ports.length > 0) {
        lines.push(`ports = ${tomlStringArray(rule.ports)}`);
      }
      if (rule.sourceIps.length > 0) {
        lines.push(`source_ips = ${tomlStringArray(rule.sourceIps)}`);
      }
      if (rule.destinationIps.length > 0) {
        lines.push(`destination_ips = ${tomlStringArray(rule.destinationIps)}`);
      }
    }
    lines.push('');
  }
  // 去掉最后一个元素为空的占位，交由调用方统一控制空行。
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}
