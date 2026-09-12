/**
 * EasyTier 配置服务器协议。
 *
 * 依据 easytier-proto/proto/web.proto 的 `WebServerService`：
 *
 *   service WebServerService {
 *     rpc Heartbeat(HeartbeatRequest) returns (HeartbeatResponse);
 *     rpc GetFeature(GetFeatureRequest) returns (GetFeatureResponse);
 *   }
 *
 * 客户端实现见 easytier-core/src/management/full/web_client.rs：
 *  - 连接 `wss://<host>/<path>`，保持长连接；
 *  - 通过 RPC 发送 Heartbeat，报告 machine_id / inst_id / 运行中的实例；
 *  - 通过 GetFeature 探测服务端能力。
 *
 * 传输采用 JSON-RPC 2.0 over WebSocket。字段名使用 proto 的 snake_case，
 * 以贴近 Rust 侧的 serde 序列化结果，减少转换层。
 */

/** 配置服务器 RPC 方法名。 */
export const RpcMethod = {
  Heartbeat: 'Heartbeat',
  GetFeature: 'GetFeature',
} as const;

export type RpcMethodValue = (typeof RpcMethod)[keyof typeof RpcMethod];

export interface DeviceOsInfo {
  os_type: string;
  version: string;
  distribution: string;
}

export interface HeartbeatRequest {
  machine_id: string;
  inst_id: string;
  user_token: string;
  easytier_version: string;
  report_time: string;
  hostname: string;
  running_network_instances: string[];
  device_os?: DeviceOsInfo;
  support_config_source: boolean;
}

export interface HeartbeatResponse {
  /** 服务端返回给客户端的指令：是否需要重新拉取配置。 */
  config_revision?: string;
}

/**
 * GetFeature 请求。
 *
 * 该 RPC 按协议不带参数，因此这里用 `Record<string, never>` 明确表达
 * 「不接受任何字段」，而不是空接口——空接口在 TypeScript 中会允许
 * 任意非空值，从而放过本应被拒绝的请求。
 */
export type GetFeatureRequest = Record<string, never>;

export interface GetFeatureResponse {
  support_encryption: boolean;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcSuccess | JsonRpcFailure;

/** JSON-RPC 错误码，遵循规范保留段。 */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const candidate = message as Record<string, unknown>;
  return (
    candidate.jsonrpc === '2.0' &&
    typeof candidate.method === 'string' &&
    (typeof candidate.id === 'string' || typeof candidate.id === 'number')
  );
}

export function rpcSuccess(id: string | number, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export function rpcFailure(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: '2.0', id, error };
}

/**
 * 归一化心跳请求：容忍客户端省略可选字段，并把下划线命名统一为内部命名。
 * 客户端版本差异较大，宽松解析可避免因缺字段而断连。
 */
export function normalizeHeartbeat(params: unknown): HeartbeatRequest | undefined {
  if (typeof params !== 'object' || params === null) {
    return undefined;
  }
  const raw = params as Record<string, unknown>;
  const machineId = readString(raw, 'machine_id');
  const instId = readString(raw, 'inst_id');
  if (machineId === undefined || instId === undefined) {
    return undefined;
  }
  const instances = Array.isArray(raw.running_network_instances)
    ? raw.running_network_instances.filter((item): item is string => typeof item === 'string')
    : [];
  const request: HeartbeatRequest = {
    machine_id: machineId,
    inst_id: instId,
    user_token: readString(raw, 'user_token') ?? '',
    easytier_version: readString(raw, 'easytier_version') ?? '',
    report_time: readString(raw, 'report_time') ?? '',
    hostname: readString(raw, 'hostname') ?? '',
    running_network_instances: instances,
    support_config_source: raw.support_config_source === true,
  };
  const os = raw.device_os;
  if (typeof os === 'object' && os !== null) {
    const osRaw = os as Record<string, unknown>;
    request.device_os = {
      os_type: readString(osRaw, 'os_type') ?? '',
      version: readString(osRaw, 'version') ?? '',
      distribution: readString(osRaw, 'distribution') ?? '',
    };
  }
  return request;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}
