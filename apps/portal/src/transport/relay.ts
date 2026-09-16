/**
 * 中继传输：浏览器 --(Worker 信令房间)--> 主机端 agent。
 *
 * 这是打洞失败时的回落路径，也是实测环境（对称 NAT）下的常态路径。
 * 实现上与 P2P 承载同一种报文（RelayRequest / RelayResponse），
 * 区别只在于字节经 Worker 转发而不是走 DataChannel。
 *
 * 为什么是「浏览器主动经 Worker」而不是「Worker 主动连主机」：
 *   主机端在内网、没有公网入口，Worker 无法主动连它。主机端主动
 *   连上 Worker 并保持长连接，请求才能顺着这条已建立的连接下发。
 */

import { SignalType, type SignalMessage } from '@nodetunnel/shared';
import {
  mergeChunks,
  type TransportRequest,
  type TransportResponse,
  type TunnelTransport,
} from './transport.js';
import { base64ToBytes, bytesToBase64 } from '../http/messages.js';
import type { SignalingClient } from '../signaling/client.js';

/** 单次请求超时。 */
const REQUEST_TIMEOUT_MS = 30_000;

/** 等待中的请求。 */
interface Pending {
  chunks: Uint8Array[];
  bytes: number;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  resolve: (value: TransportResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RelayTransport implements TunnelTransport {
  readonly kind = 'relay' as const;

  private readonly pending = new Map<string, Pending>();

  constructor(private readonly signaling: SignalingClient) {
    // 接管中继响应的处理。信令层只负责把消息送到这里。
    this.signaling.onRelayResponse = (message) => this.handleResponse(message);
  }

  request(input: TransportRequest, signal?: AbortSignal): Promise<TransportResponse> {
    const requestId = crypto.randomUUID();

    return new Promise<TransportResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.signaling.send({ type: SignalType.RelayAbort, requestId });
        reject(new Error('中继请求超时'));
      }, REQUEST_TIMEOUT_MS);

      const abort = (): void => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        this.signaling.send({ type: SignalType.RelayAbort, requestId });
        reject(new Error('请求已取消'));
      };
      signal?.addEventListener('abort', abort, { once: true });

      this.pending.set(requestId, {
        chunks: [],
        bytes: 0,
        status: 0,
        statusText: '',
        headers: {},
        resolve: (value) => {
          signal?.removeEventListener('abort', abort);
          resolve(value);
        },
        reject,
        timer,
      });

      this.signaling.send({
        type: SignalType.RelayRequest,
        requestId,
        method: input.method,
        path: input.path,
        targetPort: input.targetPort,
        headers: input.headers,
        bodyBase64: input.bodyBase64,
      });
    });
  }

  /** 处理一个响应分片。 */
  private handleResponse(message: SignalMessage): void {
    const requestId = message.requestId;
    if (requestId === undefined) {
      return;
    }
    const entry = this.pending.get(requestId);
    if (entry === undefined) {
      // 已超时或被取消，丢弃迟到的分片。
      return;
    }

    if (message.headers !== undefined) {
      entry.headers = message.headers;
    }
    if (message.status !== undefined) {
      entry.status = message.status;
      entry.statusText = message.statusText ?? '';
    }

    if (message.bodyBase64 !== undefined && message.bodyBase64 !== '') {
      const bytes = base64ToBytes(message.bodyBase64);
      entry.chunks.push(bytes);
      entry.bytes += bytes.byteLength;
    }

    if (message.last !== true) {
      return;
    }

    clearTimeout(entry.timer);
    this.pending.delete(requestId);

    const merged = mergeChunks(entry.chunks, entry.bytes);
    entry.resolve({
      status: entry.status,
      statusText: entry.statusText,
      headers: entry.headers,
      bodyBase64: merged.byteLength > 0 ? bytesToBase64(merged) : undefined,
    });
  }
}
