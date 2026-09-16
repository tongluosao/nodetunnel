/**
 * P2P 对端管理（agent 侧）。
 *
 * 每个访客会话对应一条 RTCPeerConnection。角色是 answerer：
 * 浏览器发 offer，本端建 answer。
 *
 * werift 的 API 与浏览器有差异，实测确认（见 scripts/poc/verify-datachannel.mjs）：
 *   - DataChannel 事件用 EventEmitter 风格 `dc.on(name, fn)`，事件名小写；
 *   - `dc.onopen` / `dc.onmessage` 在订阅前是 undefined，不能直接赋值；
 *   - 收到的 message 载荷是包装对象而非裸 Buffer，必须显式适配字段；
 *   - 单条消息超过 64 KiB 会被拒绝（max-message-size exceeded），必须自行分片。
 */

import { SignalType, type SignalMessage } from '@nodetunnel/shared';
import { forwardLocal, isForwardError, type ForwardRequest } from './local-forward.ts';
import type { LogLevel } from './log.ts';

/** 国内 STUN。与门户侧保持一致，避免两边各用一套导致候选不匹配。 */
const ICE_SERVERS = [
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
  { urls: 'stun:stun.hitv.com:3478' },
  { urls: 'stun:stun.douyucdn.cn:18000' },
];

/** 单条消息的分片上限。实测 64 KiB 是硬上限，取 16 KiB 留出余量。 */
const CHUNK_BYTES = 16 * 1024;

/**
 * werift 的最小接口面。
 *
 * 只声明实际用到的成员：完整类型会随库版本变动，
 * 而这里关心的是「有没有这些方法」，不是库的完整形状。
 */
interface WeriftDataChannel {
  on(event: string, handler: (payload: unknown) => void): void;
  send(data: Buffer | string): void;
  close(): void;
  readyState: string;
}

interface WeriftPeerConnection {
  onDataChannel: { subscribe: (handler: (channel: WeriftDataChannel) => void) => void };
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void>;
  setLocalDescription(description: unknown): Promise<void>;
  createAnswer(): Promise<{ sdp?: string }>;
  onIceCandidate: { subscribe: (handler: (candidate: unknown) => void) => void };
  close(): void;
}

interface WeriftModule {
  RTCPeerConnection: new (config: { iceServers: { urls: string }[] }) => WeriftPeerConnection;
}

export interface PeerManagerOptions {
  enabled: boolean;
  allowedPorts: number[];
  onLog: (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;
}

/** 一个访客会话的 P2P 状态。 */
interface PeerSession {
  peer: WeriftPeerConnection;
  channel?: WeriftDataChannel;
  /** 远端描述是否已设置。werift 要求先有 offer 才能建 answer。 */
  hasRemoteOffer: boolean;
}

export class PeerManager {
  private readonly sessions = new Map<string, PeerSession>();
  /** 显式字段而非构造函数参数属性，原因见 signaling-client.ts 的同类注释。 */
  private readonly options: PeerManagerOptions;
  private sendSignal: (message: SignalMessage) => void = () => undefined;
  private werift: WeriftModule | undefined;

  constructor(options: PeerManagerOptions) {
    this.options = options;
  }

  /** 绑定信令发送通道。P2P 产生的 SDP/候选需要经它发回访客。 */
  bindSignaling(send: (message: SignalMessage) => void): void {
    this.sendSignal = send;
  }

  /** 处理访客的 SDP。 */
  async handleDescription(sessionId: string, message: SignalMessage): Promise<void> {
    if (!this.options.enabled || sessionId === '' || message.sdp === undefined) {
      return;
    }

    const session = await this.ensureSession(sessionId);
    if (session === undefined) {
      return;
    }

    try {
      await session.peer.setRemoteDescription({
        type: message.sdpType ?? 'offer',
        sdp: message.sdp,
      });
      session.hasRemoteOffer = true;

      const answer = await session.peer.createAnswer();
      await session.peer.setLocalDescription(answer);

      this.sendSignal({
        type: SignalType.Description,
        sessionId,
        sdp: answer.sdp ?? '',
        sdpType: 'answer',
      });
    } catch (error) {
      // P2P 失败不是错误路径：访客会自动回落到中继。
      this.options.onLog('info', 'P2P 协商未成功，访客将使用中继', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.closeSession(sessionId);
    }
  }

  /** 处理访客的 ICE 候选。 */
  async handleCandidate(sessionId: string, message: SignalMessage): Promise<void> {
    if (!this.options.enabled || sessionId === '' || message.candidate === undefined) {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      // 候选可能先于 SDP 到达，此时还没有会话可写入，丢弃即可 ——
      // ICE 会重试，且中继路径始终可用。
      return;
    }

    const peer = session.peer as unknown as {
      addIceCandidate?: (candidate: unknown) => Promise<void>;
    };
    if (peer.addIceCandidate === undefined) {
      return;
    }

    try {
      await peer.addIceCandidate({
        candidate: message.candidate,
        sdpMid: message.sdpMid ?? null,
        sdpMLineIndex: message.sdpMLineIndex ?? null,
      });
    } catch {
      // 单个候选失败不影响整体；其余候选仍可能打通。
    }
  }

  /** 关闭一个会话。 */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return;
    }
    try {
      session.channel?.close();
      session.peer.close();
    } catch {
      // 已关闭可忽略。
    }
    this.sessions.delete(sessionId);
  }

  /** 关闭全部会话。 */
  closeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.closeSession(sessionId);
    }
  }

  /** 建立会话（若不存在）。 */
  private async ensureSession(sessionId: string): Promise<PeerSession | undefined> {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }

    const module = await this.loadWerift();
    if (module === undefined) {
      return undefined;
    }

    const peer = new module.RTCPeerConnection({ iceServers: ICE_SERVERS });
    const session: PeerSession = { peer, hasRemoteOffer: false };
    this.sessions.set(sessionId, session);

    // 浏览器侧创建通道，本端通过 onDataChannel 拿到。
    peer.onDataChannel.subscribe((channel) => {
      session.channel = channel;
      channel.on('message', (payload) => {
        void this.handleChannelMessage(sessionId, payload);
      });
    });

    // 本端候选经信令发回访客。
    peer.onIceCandidate.subscribe((candidate) => {
      const value = candidate as { candidate?: string; sdpMid?: string; sdpMLineIndex?: number };
      if (value.candidate === undefined) {
        return;
      }
      this.sendSignal({
        type: SignalType.Candidate,
        sessionId,
        candidate: value.candidate,
        sdpMid: value.sdpMid ?? null,
        sdpMLineIndex: value.sdpMLineIndex ?? null,
      });
    });

    return session;
  }

  /** 动态加载 werift。未安装或加载失败时返回 undefined。 */
  private async loadWerift(): Promise<WeriftModule | undefined> {
    if (this.werift !== undefined) {
      return this.werift;
    }
    try {
      const module = (await import('werift')) as unknown as WeriftModule;
      this.werift = module;
      return module;
    } catch (error) {
      this.options.onLog('warn', '未能加载 werift，P2P 不可用（中继仍然可用）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * 处理 DataChannel 上收到的一条消息。
   *
   * 与中继路径共用同一种报文格式，因此请求处理逻辑完全复用。
   */
  private async handleChannelMessage(sessionId: string, payload: unknown): Promise<void> {
    const text = extractText(payload);
    if (text === null) {
      return;
    }

    // 一条消息可能是多行，逐行处理。
    for (const line of text.split('\n')) {
      if (line === '') {
        continue;
      }
      await this.handleChannelLine(sessionId, line);
    }
  }

  private async handleChannelLine(sessionId: string, line: string): Promise<void> {
    let parsed: {
      requestId?: string;
      method?: string;
      path?: string;
      targetPort?: number;
      headers?: Record<string, string>;
      bodyBase64?: string;
    };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return;
    }

    const requestId = parsed.requestId;
    const channel = this.sessions.get(sessionId)?.channel;
    if (requestId === undefined || channel === undefined) {
      return;
    }

    const request: ForwardRequest = {
      method: parsed.method ?? 'GET',
      path: parsed.path ?? '/',
      port: parsed.targetPort ?? 0,
      headers: parsed.headers ?? {},
      body: parsed.bodyBase64 === undefined ? new Uint8Array(0) : fromBase64(parsed.bodyBase64),
    };

    const result = await forwardLocal(request, this.options.allowedPorts);

    if (isForwardError(result)) {
      this.sendLine(channel, {
        requestId,
        status: result.code === 'upstream_timeout' ? 504 : 502,
        statusText: result.code,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        bodyBase64: toBase64(new TextEncoder().encode(result.message)),
        last: true,
      });
      return;
    }

    const chunks =
      result.body.byteLength === 0 ? [new Uint8Array(0)] : splitBytes(result.body, CHUNK_BYTES);

    for (let index = 0; index < chunks.length; index += 1) {
      const bytes = chunks[index] as Uint8Array;
      this.sendLine(channel, {
        requestId,
        status: result.status,
        statusText: result.statusText,
        headers: index === 0 ? result.headers : undefined,
        bodyBase64: bytes.byteLength > 0 ? toBase64(bytes) : undefined,
        chunkIndex: index,
        last: index === chunks.length - 1,
      });
    }
  }

  private sendLine(channel: WeriftDataChannel, payload: unknown): void {
    try {
      channel.send(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.options.onLog('warn', 'DataChannel 发送失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * 从 werift 的 message 载荷中取出文本。
 *
 * 实测该事件的载荷是包装对象而非裸值，因此逐个候选字段尝试；
 * 全部失败时返回 null 而不是抛错 —— 单个畸形消息不该让会话崩溃。
 */
function extractText(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return payload;
  }
  if (Buffer.isBuffer(payload)) {
    return payload.toString('utf8');
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload).toString('utf8');
  }
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8');
  }
  if (typeof payload === 'object' && payload !== null) {
    for (const key of ['data', 'message', 'buffer', 'payload', 'value', 'chunk']) {
      const candidate = (payload as Record<string, unknown>)[key];
      const text = candidate === undefined ? null : extractText(candidate);
      if (text !== null) {
        return text;
      }
    }
  }
  return null;
}

function splitBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    chunks.push(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
  }
  return chunks;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function fromBase64(value: string): Uint8Array {
  const buffer = Buffer.from(value, 'base64');
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
