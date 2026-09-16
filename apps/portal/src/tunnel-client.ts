/**
 * 浏览器门户的隧道客户端。
 *
 * 把「建立信令 → 尝试 P2P → 失败回落中继 → 发一次 HTTP 请求」这条
 * 完整链路收在一个类里，界面层只调用 `request()`。
 *
 * 关于回落策略的现实预期：
 *   实测本机网络为对称 NAT（单一出口 IP、端口随目标变化），
 *   对端无法预测本端映射端口，打洞成功率低。因此中继是**常态路径**，
 *   不是异常兜底 —— 这也是为什么要给它设一个不长的 P2P 超时：
 *   与其让用户等一个大概率失败的打洞，不如尽快用中继把请求做完。
 */

import { isValidSlug } from './slug.js';
import { SignalingClient } from './signaling/client.js';
import { createP2PTransport } from './transport/p2p.js';
import { RelayTransport } from './transport/relay.js';
import type { TunnelTransport } from './transport/transport.js';
import { base64ToBytes, bytesToBase64, parseResponse, type HttpResponse } from './http/messages.js';

export type TransportMode = 'p2p' | 'relay';

export interface TunnelClientStatus {
  /** 信令连接是否就绪。 */
  signalingReady: boolean;
  /** 当前实际使用的传输方式。 */
  mode: TransportMode | null;
  /** P2P 连接状态，用于界面显示进度。 */
  peerState: RTCPeerConnectionState | null;
  /** 最近一条状态说明。 */
  message: string;
}

export interface TunnelClientOptions {
  /** 信令地址。 */
  signalingUrl: string;
  /** 目标路由 slug。 */
  slug: string;
  /** 状态变化回调。 */
  onStatus?: (status: TunnelClientStatus) => void;
}

export interface PortalRequest {
  method: string;
  path: string;
  targetPort: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

export class TunnelClient {
  private signaling: SignalingClient | undefined;
  private relay: RelayTransport | undefined;
  private transport: TunnelTransport | undefined;
  private status: TunnelClientStatus = {
    signalingReady: false,
    mode: null,
    peerState: null,
    message: '未连接',
  };
  private connecting: Promise<TunnelTransport> | undefined;

  constructor(private readonly options: TunnelClientOptions) {}

  /** 取当前状态。 */
  getStatus(): TunnelClientStatus {
    return this.status;
  }

  /**
   * 确保有一条可用传输。
   *
   * 优先尝试 P2P；失败或超时则用中继。中继永远可用（只要主机端在线），
   * 因此这里不会因为 P2P 失败而整体失败。
   */
  async ensureTransport(): Promise<TunnelTransport> {
    if (this.transport !== undefined) {
      return this.transport;
    }
    // 并发请求共享同一次建连，避免同时发起多次协商。
    this.connecting ??= this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(): Promise<TunnelTransport> {
    if (this.signaling === undefined) {
      this.signaling = new SignalingClient({
        url: this.options.signalingUrl,
        slug: this.options.slug,
        onPeerState: (online, reason) => {
          if (!online) {
            this.update({ message: reason ?? '主机端不可用' });
          }
        },
      });
      this.relay = new RelayTransport(this.signaling);
    }

    this.update({ message: '正在连接信令服务…' });
    await this.signaling.ready;
    this.update({ signalingReady: true, message: '信令已连接' });

    // 先尝试 P2P。失败不是错误，只是走中继。
    this.update({ message: '正在尝试 P2P 直连…' });
    const p2p = await createP2PTransport({
      signaling: this.signaling,
      onStateChange: (state) => this.update({ peerState: state }),
    });

    if (p2p !== undefined) {
      this.transport = p2p;
      this.update({ mode: 'p2p', message: 'P2P 直连已建立' });
      return p2p;
    }

    // 打洞失败：回落到中继。这是设计内的常态路径。
    const relay = this.relay;
    if (relay === undefined) {
      throw new Error('中继通道未初始化');
    }
    this.transport = relay;
    this.update({ mode: 'relay', message: 'P2P 未打通，已回落到中继' });
    return relay;
  }

  /**
   * 发送一次 HTTP 请求并解析响应。
   *
   * 请求在隧道上承载的是「HTTP 报文里的路径 + 目标端口」，
   * 由主机端 agent 负责连到本机端口并转发。
   */
  async request(input: PortalRequest): Promise<HttpResponse> {
    const transport = await this.ensureTransport();

    // 请求以「路径 + 目标端口」的形式交给主机端，由它连到本机端口。
    // 不在这里组装原始 HTTP 报文：主机端会用自己的 HTTP 客户端发起请求，
    // 手工拼报文反而会绕开它对逐跳头的过滤。
    const response = await transport.request({
      method: input.method,
      path: input.path,
      targetPort: input.targetPort,
      headers: { ...input.headers, 'x-nodetunnel-port': String(input.targetPort) },
      // 请求体若为空则不传，避免主机端多一次 base64 解码。
      bodyBase64:
        input.body === undefined || input.body.byteLength === 0
          ? undefined
          : bytesToBase64(input.body),
    });

    // 响应体是 base64 编码的原始字节，直接喂给 HTTP 解析器。
    const raw =
      response.bodyBase64 === undefined ? new Uint8Array(0) : base64ToBytes(response.bodyBase64);
    const parsed = tryParseHttpResponse(response, raw);
    return parsed;
  }

  /** 断开并清理。 */
  dispose(): void {
    this.signaling?.close();
    this.signaling = undefined;
    this.relay = undefined;
    this.transport = undefined;
    this.update({ signalingReady: false, mode: null, message: '已断开' });
  }

  private update(patch: Partial<TunnelClientStatus>): void {
    this.status = { ...this.status, ...patch };
    this.options.onStatus?.(this.status);
  }
}

/**
 * 把传输层的响应还原成 HTTP 响应。
 *
 * 主机端返回的响应体就是完整的 HTTP 报文（含状态行与头部），
 * 因此优先走标准解析；若对端只回了体（例如上游服务响应异常），
 * 则退化为「用传输层给的状态与头构造一个响应」，保证界面仍能显示内容
 * 而不是整片空白。
 */
function tryParseHttpResponse(
  transportResponse: { status: number; statusText: string; headers: Record<string, string> },
  raw: Uint8Array,
): HttpResponse {
  if (raw.byteLength > 0) {
    try {
      return parseResponse(raw).response;
    } catch {
      // 落到下面的退化分支。
    }
  }

  return {
    status: transportResponse.status,
    statusText: transportResponse.statusText,
    headers: transportResponse.headers,
    body: raw,
  };
}

/** 供界面层复用的 slug 校验。 */
export { isValidSlug };
