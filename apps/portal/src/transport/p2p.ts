/**
 * P2P 传输：浏览器 ←→ 主机端 agent，走 WebRTC DataChannel。
 *
 * 分工：
 *   - 浏览器侧是 offerer，创建 DataChannel 并产生 offer；
 *   - agent 侧是 answerer，收到 offer 后建立对应的通道；
 *   - 双方通过 Worker 的信令房间交换 SDP 与 ICE 候选。
 *
 * 承载的报文与中继路径完全相同（RelayRequest / RelayResponse 的 JSON），
 * 因此主机端只需要一份请求处理逻辑，分片约定也共用。
 *
 * ICE 只用国内 STUN。国外 STUN 在国内常被 DNS 劫持或代理 TUN 接管，
 * 表现为解析到 198.18.x.x 保留地址且 UDP 无响应，用它只会拖慢协商。
 */

import { SignalType, type SignalMessage } from '@nodetunnel/shared';
import {
  mergeChunks,
  type TransportRequest,
  type TransportResponse,
  type TunnelTransport,
} from './transport.js';
import { base64ToBytes, bytesToBase64 } from '../http/messages.js';
import { LineSplitter } from './line-framing.js';
import type { SignalingClient } from '../signaling/client.js';

/** 国内 STUN 服务器。实测可用性会随时间变化，多配几个互为备份。 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
  { urls: 'stun:stun.hitv.com:3478' },
  { urls: 'stun:stun.douyucdn.cn:18000' },
];

/** DataChannel 标签，两端必须一致。 */
const CHANNEL_LABEL = 'nodetunnel';

/** 建连超时。打洞失败时要尽快回落到中继，不能让用户干等。 */
const CONNECT_TIMEOUT_MS = 8_000;

/** 单次请求超时。 */
const REQUEST_TIMEOUT_MS = 30_000;

export interface P2POptions {
  signaling: SignalingClient;
  /** 连接状态变化，用于界面上显示进度。 */
  onStateChange?: (state: RTCPeerConnectionState) => void;
  iceServers?: RTCIceServer[];
}

/**
 * 建立一条 P2P 传输。
 *
 * 成功返回可用的 transport；超时或协商失败返回 undefined，
 * 由调用方回落到中继 —— 这正是设计内的预期路径，不是错误。
 */
export async function createP2PTransport(
  options: P2POptions,
): Promise<TunnelTransport | undefined> {
  const { signaling, onStateChange, iceServers = DEFAULT_ICE_SERVERS } = options;

  const peer = new RTCPeerConnection({ iceServers });

  // 浏览器侧创建通道，agent 侧通过 DataChannel 事件收到。
  const channel = peer.createDataChannel(CHANNEL_LABEL, { ordered: true });
  channel.binaryType = 'arraybuffer';

  const opened = waitForChannelOpen(channel, CONNECT_TIMEOUT_MS);

  // 本端候选就绪即转发；逐个转发而不是等收集完成，
  // 可以更早开始连通性检查，缩短建连时间。
  peer.onicecandidate = (event) => {
    if (event.candidate !== null) {
      signaling.sendCandidate(
        event.candidate.candidate,
        event.candidate.sdpMid,
        event.candidate.sdpMLineIndex,
      );
    }
  };

  peer.onconnectionstatechange = () => {
    onStateChange?.(peer.connectionState);
  };

  // 对端的 SDP/候选经信令到达后写入本端连接。
  signaling.onDescription = (message: SignalMessage) => {
    if (message.sdp === undefined || message.sdpType === undefined) {
      return;
    }
    void peer
      .setRemoteDescription({ type: message.sdpType, sdp: message.sdp })
      .catch(() => undefined);
  };

  signaling.onCandidate = (message: SignalMessage) => {
    if (message.candidate === undefined) {
      return;
    }
    void peer
      .addIceCandidate({
        candidate: message.candidate,
        sdpMid: message.sdpMid ?? null,
        sdpMLineIndex: message.sdpMLineIndex ?? null,
      })
      .catch(() => undefined);
  };

  // 发起协商。
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  signaling.sendDescription(offer.sdp ?? '', 'offer');

  const open = await opened;
  if (!open) {
    // 打洞失败：清理连接，让调用方走中继。
    peer.close();
    return undefined;
  }

  return new DataChannelTransport(channel, peer);
}

/** 等待 DataChannel 打开。超时返回 false 而不是抛错。 */
function waitForChannelOpen(channel: RTCDataChannel, timeoutMs: number): Promise<boolean> {
  if (channel.readyState === 'open') {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    channel.onopen = () => {
      clearTimeout(timer);
      resolve(true);
    };
    // 连接失败时不必等满超时，立刻放弃以便尽快回落到中继。
    channel.onclose = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
}

/**
 * 基于 DataChannel 的传输。
 *
 * 报文按行分隔的 JSON 发送（DataChannel 的 message 边界不可靠，
 * 因此用一个极简的换行分帧），响应分片按行流式到达，收到 last 收尾。
 */
class DataChannelTransport implements TunnelTransport {
  readonly kind = 'p2p' as const;

  /** 行缓冲：DataChannel 不保证「一次 send 对应一次 message」。 */
  private readonly splitter = new LineSplitter();
  private readonly pending = new Map<
    string,
    {
      chunks: Uint8Array[];
      bytes: number;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      resolve: (value: TransportResponse) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly channel: RTCDataChannel,
    private readonly peer: RTCPeerConnection,
  ) {
    this.channel.onmessage = (event) => this.handleMessage(event.data);
  }

  request(input: TransportRequest, signal?: AbortSignal): Promise<TransportResponse> {
    if (this.channel.readyState !== 'open') {
      return Promise.reject(new Error('DataChannel 未处于打开状态'));
    }

    const requestId = crypto.randomUUID();

    return new Promise<TransportResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('等待 P2P 响应超时'));
      }, REQUEST_TIMEOUT_MS);

      const abort = (): void => {
        clearTimeout(timer);
        this.pending.delete(requestId);
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

      this.channel.send(
        `${JSON.stringify({
          type: SignalType.RelayRequest,
          requestId,
          method: input.method,
          path: input.path,
          targetPort: input.targetPort,
          headers: input.headers,
          bodyBase64: input.bodyBase64,
        })}\n`,
      );
    });
  }

  /** 按行切分收到的字节，逐条处理。 */
  private handleMessage(data: unknown): void {
    const text =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : '';

    for (const line of this.splitter.push(text)) {
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    const message = parsed as {
      requestId?: string;
      status?: number;
      statusText?: string;
      headers?: Record<string, string>;
      bodyBase64?: string;
      last?: boolean;
    };

    const requestId = message.requestId;
    if (requestId === undefined) {
      return;
    }
    const entry = this.pending.get(requestId);
    if (entry === undefined) {
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

  /** 关闭连接。 */
  close(): void {
    try {
      this.channel.close();
    } catch {
      // 已关闭可忽略。
    }
    this.peer.close();
  }
}
