import type { PortProtocol, TunnelPort } from './types.js';

/**
 * 边界校验。所有外部输入（HTTP 请求体、URL 参数、配置服务器消息）
 * 都必须经过此处的函数，禁止在业务代码里散落临时判断。
 *
 * 每个函数返回 `{ ok: true, value }` 或 `{ ok: false, message }`，
 * 消息为中文，可直接展示给用户。
 */

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

function valid<T>(value: T): Validated<T> {
  return { ok: true, value };
}

function invalid<T>(message: string): Validated<T> {
  return { ok: false, message };
}

/** 端口范围：1–65535，且避开 Workers 自身常用端口。 */
export const MIN_PORT = 1;
export const MAX_PORT = 65_535;

/** slug：小写字母/数字/短横线，1–63 字符，不能以短横线开头或结尾。 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** 网络名：字母/数字/下划线/短横线/点，1–64 字符。 */
const NETWORK_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;

export function validateSlug(input: unknown): Validated<string> {
  if (typeof input !== 'string') {
    return invalid('slug 必须是字符串');
  }
  const value = input.trim().toLowerCase();
  if (!SLUG_PATTERN.test(value)) {
    return invalid('slug 只能包含小写字母、数字和短横线，长度 1–63，且不能以短横线开头或结尾');
  }
  return valid(value);
}

export function validateNetworkName(input: unknown): Validated<string> {
  if (typeof input !== 'string') {
    return invalid('网络名称必须是字符串');
  }
  const value = input.trim();
  if (!NETWORK_NAME_PATTERN.test(value)) {
    return invalid('网络名称只能包含字母、数字、下划线、短横线和点，长度 1–64');
  }
  return valid(value);
}

export function validateUsername(input: unknown): Validated<string> {
  if (typeof input !== 'string') {
    return invalid('用户名必须是字符串');
  }
  const value = input.trim();
  if (!USERNAME_PATTERN.test(value)) {
    return invalid('用户名只能包含字母、数字、下划线、短横线和点，长度 3–32');
  }
  return valid(value);
}

/**
 * 密码强度：至少 12 位，且必须同时包含字母与数字。
 * 管理员密码是系统唯一凭据，标准高于普通应用。
 */
export function validatePassword(input: unknown): Validated<string> {
  if (typeof input !== 'string') {
    return invalid('密码必须是字符串');
  }
  if (input.length < 12) {
    return invalid('密码长度至少 12 位');
  }
  if (input.length > 256) {
    return invalid('密码长度不能超过 256 位');
  }
  if (!/[A-Za-z]/.test(input) || !/[0-9]/.test(input)) {
    return invalid('密码必须同时包含字母和数字');
  }
  return valid(input);
}

/** 组网密钥：至少 16 位，允许任意可见字符。 */
export function validateNetworkSecret(input: unknown): Validated<string> {
  if (typeof input !== 'string') {
    return invalid('组网密钥必须是字符串');
  }
  if (input.length < 16) {
    return invalid('组网密钥长度至少 16 位');
  }
  if (input.length > 256) {
    return invalid('组网密钥长度不能超过 256 位');
  }
  return valid(input);
}

export function validatePort(input: unknown): Validated<number> {
  const value = typeof input === 'string' ? Number(input) : input;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return invalid('端口必须是整数');
  }
  if (value < MIN_PORT || value > MAX_PORT) {
    return invalid(`端口必须在 ${MIN_PORT}–${MAX_PORT} 之间`);
  }
  return valid(value);
}

export function validatePortProtocol(input: unknown): Validated<PortProtocol> {
  if (input !== 'tcp' && input !== 'udp') {
    return invalid('协议必须是 tcp 或 udp');
  }
  return valid(input);
}

/** 目标主机：IPv4 地址、域名或主机名；不接受 URL 与端口。 */
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/;

export function validateTargetHost(input: unknown): Validated<string> {
  if (typeof input !== 'string') {
    return invalid('目标主机必须是字符串');
  }
  const value = input.trim();
  if (value === '') {
    return invalid('目标主机不能为空');
  }
  if (value.includes('/') || value.includes(':')) {
    return invalid('目标主机不能包含路径或端口，请分别填写 host 与 port');
  }
  if (!HOST_PATTERN.test(value)) {
    return invalid('目标主机格式不正确');
  }
  return valid(value);
}

/** 中继地址：必须是 ws:// 或 wss:// 的 WebSocket URL。 */
export function validateRelayUrl(input: unknown): Validated<string> {
  if (typeof input !== 'string') {
    return invalid('中继地址必须是字符串');
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return invalid('中继地址不是合法的 URL');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return invalid('中继地址必须使用 ws:// 或 wss:// 协议');
  }
  return valid(url.toString());
}

/** 端口白名单：去重、排序，最多 64 条。 */
export function validateTunnelPorts(input: unknown): Validated<TunnelPort[]> {
  if (!Array.isArray(input)) {
    return invalid('端口列表必须是数组');
  }
  if (input.length > 64) {
    return invalid('端口白名单最多允许 64 条');
  }
  const seen = new Set<string>();
  const ports: TunnelPort[] = [];
  for (const item of input) {
    if (typeof item !== 'object' || item === null) {
      return invalid('端口条目必须是对象');
    }
    const record = item as Record<string, unknown>;
    const port = validatePort(record.port);
    if (!port.ok) {
      return invalid(port.message);
    }
    const protocol = validatePortProtocol(record.protocol ?? 'tcp');
    if (!protocol.ok) {
      return invalid(protocol.message);
    }
    const key = `${protocol.value}:${port.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ports.push({ port: port.value, protocol: protocol.value });
  }
  ports.sort((a, b) => (a.protocol === b.protocol ? a.port - b.port : a.protocol.localeCompare(b.protocol)));
  return valid(ports);
}

/** 实例 ID：必须是 UUID（客户端上报的 instance_id）。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUuid(input: unknown): Validated<string> {
  if (typeof input !== 'string' || !UUID_PATTERN.test(input)) {
    return invalid('必须是合法的 UUID');
  }
  return valid(input);
}

/** IPv4 地址。 */
export function validateIpv4(input: unknown): Validated<string> {
  if (typeof input !== 'string') {
    return invalid('IPv4 地址必须是字符串');
  }
  const octets = input.split('.');
  if (octets.length !== 4) {
    return invalid('IPv4 地址必须包含 4 段');
  }
  for (const octet of octets) {
    const value = Number(octet);
    if (!Number.isInteger(value) || value < 0 || value > 255 || octet === '') {
      return invalid('IPv4 地址每段必须是 0–255 的整数');
    }
  }
  return valid(input);
}
