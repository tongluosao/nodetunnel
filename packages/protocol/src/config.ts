import type { TunnelPort } from '@nodetunnel/shared';
import { buildBrowserAcl, buildTunnelAcl, renderAclToml } from './acl.js';

/**
 * EasyTier 配置渲染。
 *
 * 渲染两份配置：
 *  1. 隧道节点（服务方）配置：由 nodetunnel 配置服务器下发，
 *     自动填入初始节点（中继）、组网名、组网密钥，并按端口白名单收紧 ACL。
 *  2. 浏览器节点（访问方）配置：由 portal 使用 easytier-js 在浏览器内启动，
 *     接入同一组网，ACL 全禁止入站。
 *
 * 字段与 easytier-core/src/config/toml.rs 的 schema 对应。
 */

export interface TunnelNodeConfigInput {
  /** EasyTier 实例 ID（UUID），客户端首次生成后应保持稳定。 */
  instanceId: string;
  /** 实例展示名，通常为主机名。 */
  instanceName: string;
  networkName: string;
  networkSecret: string;
  /** 中继 WebSocket 地址，形如 wss://nodetunnel.example.workers.dev/relay。 */
  relayUrl: string;
  /** 暴露的端口白名单。 */
  ports: TunnelPort[];
  /** 本节点在虚拟局域网中的 IPv4（含前缀），留空则由 EasyTier 自动分配。 */
  ipv4?: string;
  /** 是否启用加密。默认 true。 */
  encryption?: boolean;
  /** 是否注册为子网代理。默认关闭，避免跨隧道访问。 */
  enableSubnetProxy?: boolean;
}

export interface BrowserNodeConfigInput {
  instanceId: string;
  instanceName: string;
  networkName: string;
  networkSecret: string;
  relayUrl: string;
  /** 浏览器节点在虚拟局域网中的 IPv4（含前缀）。 */
  ipv4: string;
  encryption?: boolean;
}

/**
 * 渲染隧道节点配置。
 *
 * 关键点：
 *  - `listeners = []`：隧道节点不自行监听端口，全部连接由中继/打洞建立；
 *  - 只把中继作为初始节点，客户端的实际可达地址由 EasyTier 自行发现；
 *  - ACL 默认拒绝入站，仅放行 ports。
 */
export function renderTunnelNodeConfig(input: TunnelNodeConfigInput): string {
  const lines: string[] = [];

  lines.push(`instance_name = ${toml(input.instanceName)}`);
  lines.push(`instance_id = ${toml(input.instanceId)}`);
  lines.push('');
  lines.push('listeners = []');
  lines.push('');
  lines.push('[network_identity]');
  lines.push(`network_name = ${toml(input.networkName)}`);
  lines.push(`network_secret = ${toml(input.networkSecret)}`);
  lines.push('');
  lines.push('[[peer]]');
  lines.push(`uri = ${toml(input.relayUrl)}`);
  lines.push('');

  if (input.ipv4 !== undefined && input.ipv4 !== '') {
    lines.push(`ipv4 = ${toml(input.ipv4)}`);
    lines.push('');
  }

  if (input.enableSubnetProxy === true) {
    // 显式开启时才写入；默认不代理任何子网，减少暴露面。
    lines.push('[flags]');
    lines.push('enable_subnet_proxy = true');
    lines.push('');
  }

  lines.push('[flags]');
  lines.push('no_tun = false');
  lines.push('bind_device = false');
  lines.push('enable_encryption = ' + String(input.encryption ?? true));
  lines.push('latency_first = true');
  lines.push('');

  lines.push(renderAclToml(buildTunnelAcl(input.ports)));
  lines.push('');

  return lines.join('\n');
}

/**
 * 渲染浏览器节点配置。
 *
 * 与 browser profile 的差异：easytier-js 的 runtime 会自行拼装固定的
 * 头部字段（profile/instanceId/networkName），此处提供的是等价的可读配置，
 * 用于协议展示、管理后台预览与测试对照。
 */
export function renderBrowserNodeConfig(input: BrowserNodeConfigInput): string {
  const lines: string[] = [];

  lines.push(`instance_name = ${toml(input.instanceName)}`);
  lines.push(`instance_id = ${toml(input.instanceId)}`);
  lines.push('');
  lines.push(`ipv4 = ${toml(input.ipv4)}`);
  lines.push('listeners = []');
  lines.push('');
  lines.push('[network_identity]');
  lines.push(`network_name = ${toml(input.networkName)}`);
  lines.push(`network_secret = ${toml(input.networkSecret)}`);
  lines.push('');
  lines.push('[[peer]]');
  lines.push(`uri = ${toml(input.relayUrl)}`);
  lines.push('');
  lines.push('[flags]');
  lines.push('no_tun = true');
  lines.push('use_smoltcp = true');
  lines.push('bind_device = false');
  lines.push('enable_encryption = ' + String(input.encryption ?? true));
  lines.push('');
  lines.push(renderAclToml(buildBrowserAcl()));
  lines.push('');

  return lines.join('\n');
}

/** 生成一份随机但可读的隧道组网密钥。 */
export function generateNetworkSecret(): string {
  return randomBase64Url(32);
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toml(value: string): string {
  return JSON.stringify(value);
}
