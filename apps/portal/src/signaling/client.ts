/**
 * 信令客户端。
 *
 * 负责与 Worker 的信令房间维持一条 WebSocket，并在这条连接上：
 *   1. 交换 SDP 与 ICE 候选（P2P 协商）；
 *   2. 承载中继请求/响应（打洞失败时的回落路径）。
 *
 * 两条路复用一条连接是刻意的设计：少一条连接就少一处需要保活、
 * 鉴权与错误处理的地方。区分靠消息类型。
 *
 * 本类只做「连接的收发与分发」，不理解中继语义 ——
 * 中继的请求配对与分片重组由 RelayTransport 负责。
 */

import { SignalType, parseSignalMessage, type SignalMessage } from '@nodetunnel/shared';

export interface SignalingClientOptions {
  url: string;
  /** 路由 slug，用于让 Worker 找到对应的隧道房间。 */
  slug: string;
  /** 主机端上下线通知。 */
  onPeerState?: (online: boolean, reason?: string) => void;
}

export class SignalingClient {
  private readonly socket: WebSocket;
  private readonly options: SignalingClientOptions;
  private closed = false;

  /**
   * 回调在构造后赋值（而不是构造参数），因为 P2P 与中继两层需要
   * 在自己初始化完成后才能接管 —— 而信令连接必须先建立才能协商，
   * 两者存在先后依赖。
   */
  onDescription: (message: SignalMessage) => void = () => undefined;
  onCandidate: (message: SignalMessage) => void = () => undefined;
  onRelayResponse: (message: SignalMessage) => void = () => undefined;

  /** 连接建立的 Promise。 */
  readonly ready: Promise<void>;

  constructor(options: SignalingClientOptions) {
    this.options = options;

    const target = new URL(options.url);
    target.searchParams.set('slug', options.slug);
    this.socket = new WebSocket(target.toString());

    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('信令连接超时')), 10_000);
      this.socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('信令连接失败'));
      };
    });

    this.socket.onmessage = (event) => this.handleMessage(event);
    this.socket.onclose = () => this.handleClose();
  }

  /** 发送一条信令消息。 */
  send(message: SignalMessage): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  /** 转发本端 SDP。 */
  sendDescription(sdp: string, sdpType: 'offer' | 'answer'): void {
    this.send({ type: SignalType.Description, sdp, sdpType });
  }

  /** 转发本端 ICE 候选。 */
  sendCandidate(candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): void {
    this.send({ type: SignalType.Candidate, candidate, sdpMid, sdpMLineIndex });
  }

  /** 主动关闭连接。 */
  close(): void {
    this.closed = true;
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
  }

  private handleMessage(event: MessageEvent): void {
    const text = typeof event.data === 'string' ? event.data : '';
    if (text === '') {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    const message = parseSignalMessage(parsed);
    if (message === undefined) {
      return;
    }

    switch (message.type) {
      case SignalType.Description:
        this.onDescription(message);
        return;

      case SignalType.Candidate:
        this.onCandidate(message);
        return;

      case SignalType.RelayResponse:
        this.onRelayResponse(message);
        return;

      case SignalType.PeerGone:
        // 主机端不可用：通知上层改走中继，而不是让请求悬着。
        this.options.onPeerState?.(false, message.message);
        return;

      case SignalType.Error:
        this.options.onPeerState?.(false, message.message ?? '信令错误');
        return;

      default:
        return;
    }
  }

  private handleClose(): void {
    this.closed = true;
    this.options.onPeerState?.(false, '信令连接已断开');
  }
}
