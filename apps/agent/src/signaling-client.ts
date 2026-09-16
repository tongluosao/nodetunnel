/**
 * agent 的信令客户端。
 *
 * 与 Worker 维持一条 WebSocket，双向承载：
 *   - 信令（SDP / ICE），用于与浏览器访客协商 P2P；
 *   - 中继请求/响应，用于打洞失败时回落。
 *
 * 只有一条连接：少一条连接就少一处保活、重连与鉴权逻辑。
 */

import {
  RELAY_CHUNK_BYTES,
  SignalType,
  parseSignalMessage,
  type SignalMessage,
} from '@nodetunnel/shared';
import { forwardLocal, isForwardError, type ForwardRequest } from './local-forward.ts';

/** 保活间隔。Cloudflare 会回收长时间空闲的连接。 */
const PING_INTERVAL_MS = 30_000;

/** 断线后的重连基数与上限。采用指数退避，避免服务端重启时被同时冲击。 */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface AgentClientOptions {
  url: string;
  token: string;
  hostname: string;
  version: string;
  allowedPorts: number[];
  onLog: (
    level: 'info' | 'warn' | 'error',
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  /** 收到访客 SDP/候选时的回调，用于驱动 P2P。 */
  onDescription?: (message: SignalMessage, sessionId: string) => void;
  onCandidate?: (message: SignalMessage, sessionId: string) => void;
  onSessionClosed?: (sessionId: string) => void;
}

export class AgentClient {
  /**
   * 显式声明字段而不用构造函数参数属性（`constructor(private readonly x)`）：
   * agent 用 `node --experimental-strip-types` 直接运行 TS，而 strip-only
   * 模式只删除类型注解、不做代码生成；参数属性需要生成赋值语句，
   * 因此不被支持（ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）。
   */
  private readonly options: AgentClientOptions;
  private socket: WebSocket | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectAttempts = 0;
  private stopped = false;

  constructor(options: AgentClientOptions) {
    this.options = options;
  }

  /** 启动连接。失败会自动重连，直到 stop()。 */
  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** 停止并清理。 */
  stop(): void {
    this.stopped = true;
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
  }

  /** 发送一条消息。连接不可用则静默丢弃。 */
  send(message: SignalMessage): void {
    if (this.socket === undefined || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }

    this.options.onLog('info', '正在连接信令服务', { url: this.options.url });
    const socket = new WebSocket(this.options.url, {
      // 令牌放在握手头而不是 URL：URL 会进入各级访问日志与浏览器历史。
      headers: { Authorization: `Bearer ${this.options.token}` },
    } as unknown as string[]);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      this.options.onLog('info', '信令连接已建立');

      // 宣告接入并上报本地端口白名单，供后台核对。
      this.send({
        type: SignalType.Hello,
        token: this.options.token,
        hostname: this.options.hostname,
        version: this.options.version,
        reportedPorts: this.options.allowedPorts,
      });

      this.startPing();
    });

    socket.addEventListener('message', (event) => {
      void this.handleMessage(String(event.data));
    });

    socket.addEventListener('close', () => {
      this.stopPing();
      this.options.onLog('warn', '信令连接已断开');
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // 具体原因由 close 事件统一处理，这里只记录。
      this.options.onLog('warn', '信令连接出错');
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    this.reconnectAttempts += 1;
    // 指数退避，封顶 30 秒。
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS);
    this.options.onLog('info', `将在 ${delay}ms 后重连`, {
      attempt: this.reconnectAttempts,
    });
    setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: SignalType.Ping });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private async handleMessage(text: string): Promise<void> {
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
      case SignalType.Pong:
        return;

      case SignalType.Connect: {
        // 有访客进入房间。P2P 由上层按 sessionId 建立。
        const sessionId = message.sessionId ?? '';
        if (sessionId !== '') {
          this.options.onLog('info', '访客已接入', { sessionId });
        }
        return;
      }

      case SignalType.PeerGone: {
        const sessionId = message.sessionId;
        if (sessionId !== undefined) {
          this.options.onSessionClosed?.(sessionId);
        }
        return;
      }

      case SignalType.Description: {
        const sessionId = message.sessionId ?? '';
        this.options.onDescription?.(message, sessionId);
        return;
      }

      case SignalType.Candidate: {
        const sessionId = message.sessionId ?? '';
        this.options.onCandidate?.(message, sessionId);
        return;
      }

      case SignalType.RelayRequest:
        await this.handleRelayRequest(message);
        return;

      default:
        return;
    }
  }

  /**
   * 处理一次中继请求。
   *
   * 转发到本机服务后，把响应按分片发回。分片是必需的：
   * 响应体可能远大于单条消息上限。
   */
  private async handleRelayRequest(message: SignalMessage): Promise<void> {
    const requestId = message.requestId;
    // sessionId 允许缺失：经 /t/<slug>/ 的 HTTP 转发没有「访客会话」概念，
    // 房间只是把它当成一次房间内转发。它只用于把响应投回正确的发起方，
    // 房间侧本来就能按 requestId 配对，因此不作为必填项。
    const sessionId = message.sessionId;
    if (requestId === undefined) {
      this.options.onLog('warn', '收到缺少 requestId 的中继请求，已忽略');
      return;
    }

    const port = message.targetPort ?? 0;
    const request: ForwardRequest = {
      method: message.method ?? 'GET',
      path: message.path ?? '/',
      port,
      headers: message.headers ?? {},
      body:
        message.bodyBase64 !== undefined && message.bodyBase64 !== ''
          ? base64ToBytes(message.bodyBase64)
          : new Uint8Array(0),
    };

    const result = await forwardLocal(request, this.options.allowedPorts);

    if (isForwardError(result)) {
      this.options.onLog('warn', '中继请求被拒绝或失败', {
        requestId,
        port,
        code: result.code,
      });
      this.send({
        type: SignalType.RelayResponse,
        requestId,
        sessionId,
        status: result.code === 'upstream_timeout' ? 504 : 502,
        statusText: result.code,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        bodyBase64: bytesToBase64(new TextEncoder().encode(result.message)),
        last: true,
      });
      return;
    }

    // 分片发送响应体。即使体为空也要发一个 last 帧，让对端知道可以收尾。
    const chunks: Uint8Array[] =
      result.body.byteLength === 0 ? [new Uint8Array(0)] : chunk(result.body, RELAY_CHUNK_BYTES);

    for (let index = 0; index < chunks.length; index += 1) {
      const chunkBytes = chunks[index] as Uint8Array;
      this.send({
        type: SignalType.RelayResponse,
        requestId,
        sessionId,
        status: result.status,
        statusText: result.statusText,
        headers: index === 0 ? result.headers : undefined,
        bodyBase64: chunkBytes.byteLength > 0 ? bytesToBase64(chunkBytes) : undefined,
        chunkIndex: index,
        last: index === chunks.length - 1,
      });
    }
  }
}

/** 按固定大小切分。 */
function chunk(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    chunks.push(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
  }
  return chunks;
}

/** base64 → 字节。 */
function base64ToBytes(value: string): Uint8Array {
  const buffer = Buffer.from(value, 'base64');
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** 字节 → base64。 */
function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
