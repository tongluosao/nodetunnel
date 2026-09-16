/**
 * 隧道传输抽象。
 *
 * 门户对「怎么把请求送到主机端」有两条路：
 *   1. P2P：WebRTC DataChannel，经 ICE 打洞直连；
 *   2. 中继：经 Worker 信令房间转发。
 *
 * 两条路对上层暴露同一个接口，调用方不需要知道当前走的是哪条。
 *
 * **两条路承载同一种报文格式**：中继协议的 JSON 消息
 * （RelayRequest / RelayResponse）。这样设计的好处是主机端只需要
 * 一份请求处理逻辑，不必为 P2P 再写一套 HTTP 解析；分片也复用同一套约定。
 *
 * 关于两者关系的现实预期：
 *   实测本机网络为对称 NAT（单一出口 IP、端口随目标变化），打洞成功率低。
 *   因此中继是常态路径。这不影响架构成立，但意味着 P2P 只是可选优化。
 */

import { RELAY_CHUNK_BYTES } from '@nodetunnel/shared';

/** 一次隧道请求。 */
export interface TransportRequest {
  method: string;
  /** 目标服务上的路径（含查询串）。 */
  path: string;
  /** 目标端口。主机端据此决定连本机哪个端口。 */
  targetPort: number;
  headers: Record<string, string>;
  /** 请求体，base64 编码；空体为 undefined。 */
  bodyBase64?: string;
}

/** 一次隧道响应。 */
export interface TransportResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** 响应体，base64 编码。 */
  bodyBase64?: string;
}

/** 隧道传输接口。 */
export interface TunnelTransport {
  /** 人类可读的路径名，用于界面上显示「当前是直连还是中继」。 */
  readonly kind: 'p2p' | 'relay';
  /** 发送一次请求并等待完整响应。 */
  request(input: TransportRequest, signal?: AbortSignal): Promise<TransportResponse>;
}

/**
 * 分片常量。
 *
 * 与 WebSocket 中继路径共用 16 KiB：实测该尺寸既能安全低于
 * SCTP 的 64 KiB 单消息上限，又不会因分片过多而放大开销。
 */
export const CHUNK_BYTES = RELAY_CHUNK_BYTES;

/**
 * 按固定大小切分字节流。
 *
 * 空输入返回空数组（不产生任何分片，调用方据此判断「无体」）。
 */
export function chunkBytes(bytes: Uint8Array, size = CHUNK_BYTES): Uint8Array[] {
  if (bytes.byteLength === 0) {
    return [];
  }
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    chunks.push(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
  }
  return chunks;
}

/** 把分片按顺序合并。 */
export function mergeChunks(chunks: Uint8Array[], totalBytes?: number): Uint8Array {
  const total = totalBytes ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
