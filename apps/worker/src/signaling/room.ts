/**
 * 信令房间 Durable Object（基础层）。
 *
 * 职责：为**一个 tunnel** 维护一条主机端连接与若干访客连接，
 * 并在它们之间转发信令与中继帧。
 *
 * 为什么用 Durable Object：
 *   信令天然是「有状态 + 需要寻址」的 —— 访客必须能找到那台主机，
 *   而主机可能在任何时刻重连。DO 提供单点串行化与稳定的寻址，
 *   不需要引入额外的协调组件。
 *
 * 边界：本类不解析 SDP、不碰 ICE 内容，也不重复做端口白名单校验 ——
 * 白名单在业务层已经校验过，这里只负责投递与在线登记。
 */

import { DurableObject } from 'cloudflare:workers';
import {
  MAX_SIGNALING_MESSAGE_BYTES,
  SignalType,
  errorMessage,
  parseSignalMessage,
  type SignalMessage,
} from '@nodetunnel/shared';

import type { Env } from '../env.js';
import * as queries from '../db/queries.js';
import { logger } from '../lib/logger.js';
import { ROLE_HEADER, ROLE_HOST, ROLE_VISITOR, type ConnectionRole } from './roles.js';
import {
  HOSTNAME_HEADER,
  ROUTE_SLUG_HEADER,
  RELAY_TARGET_HOST_HEADER,
  RELAY_TARGET_PORT_HEADER,
  TUNNEL_ID_HEADER,
  TUNNEL_PORTS_HEADER,
  VERSION_HEADER,
} from './headers.js';

/** 中继请求的等待上限。超过即认为主机端无响应。 */
const RELAY_TIMEOUT_MS = 30_000;

/** 主机端未接入时的轮询等待：主机可能正在重连，短暂等待能避免误报离线。 */
const HOST_WAIT_TIMEOUT_MS = 3_000;
const HOST_WAIT_INTERVAL_MS = 100;

/** 一次中继调用的结果。 */
interface RelayResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** 附着在 WebSocket 上的连接元数据。休眠唤醒后从这里恢复。 */
interface ConnectionMeta {
  role: ConnectionRole;
  tunnelId: string;
  /** 访客的会话 ID；主机此项为空。 */
  sessionId?: string;
  /** 访客请求的路由 slug。 */
  slug?: string;
  /**
   * 该隧道允许入站的端口白名单。
   *
   * 在主机端接入时记录，用于对**访客发起的**中继请求做端口校验。
   * 之所以要在这里也校验一次：浏览器是访客自己控制的，它可以伪造
   * 任意 targetPort。agent 侧会独立再校验一次（真正的安全边界在那边），
   * 但提前在房间拦掉能避免把注定被拒的请求转给用户机器。
   */
  allowedPorts?: number[];
}

export class SignalingRoom extends DurableObject<Env> {
  /**
   * 等待中的中继请求。
   *
   * 键为 requestId。DO 的实例在请求处理期间必然存活（有未完成的
   * Promise 挂着），因此不需要把它持久化到存储。
   */
  private readonly pendingRelays = new Map<
    string,
    {
      chunks: Uint8Array[];
      bytes: number;
      resolve: (value: RelayResult) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * 处理一次接入请求。
   *
   * 两类请求：
   *   1. WebSocket 升级 —— 主机端或访客接入；
   *   2. 普通 HTTP —— 业务层投递来的中继请求，需要转交给主机端。
   *
   * 业务层已在上游完成令牌/路由校验，并把结果放进请求头。
   */
  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade?.toLowerCase() !== 'websocket') {
      return this.handleRelayRequest(request);
    }

    const tunnelId = request.headers.get(TUNNEL_ID_HEADER) ?? '';
    if (tunnelId === '') {
      return new Response('缺少隧道身份', { status: 400 });
    }

    // 角色由业务层显式标注，不从路径推断 —— 路径规则将来可能调整，
    // 而角色决定了完全不同的连接语义，推断错了会静默错投消息。
    const roleHeader = request.headers.get(ROLE_HEADER);
    const role: ConnectionRole = roleHeader === ROLE_HOST ? ROLE_HOST : ROLE_VISITOR;

    const meta: ConnectionMeta = { role, tunnelId };

    if (role === ROLE_VISITOR) {
      meta.sessionId = crypto.randomUUID();
      meta.slug = request.headers.get(ROUTE_SLUG_HEADER) ?? '';
    } else {
      // 主机端接入时记录白名单，供访客发起的中继请求做端口校验。
      meta.allowedPorts = parsePortsHeader(request.headers.get(TUNNEL_PORTS_HEADER));
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment(meta);

    if (role === ROLE_HOST) {
      await this.markHostOnline(tunnelId, {
        hostname: request.headers.get(HOSTNAME_HEADER),
        version: request.headers.get(VERSION_HEADER),
        ports: meta.allowedPorts ?? [],
      });
      this.send(server, { type: SignalType.Ready });
    } else {
      this.send(server, {
        type: SignalType.Connected,
        sessionId: meta.sessionId,
        slug: meta.slug,
      });
      this.notifyHostVisitorJoined(meta);
    }

    // 101 完成升级；引导消息已经先行入队，顺序可靠。
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 收到一条消息。
   *
   * 只做投递与最基础的合法性判断：拒绝超大消息、拒绝无法解析的报文，
   * 不解析业务语义。
   */
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const meta = ws.deserializeAttachment() as ConnectionMeta | null;
    if (meta === null) {
      ws.close(1011, '连接元数据缺失');
      return;
    }

    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    if (text.length > MAX_SIGNALING_MESSAGE_BYTES) {
      this.send(ws, errorMessage('message_too_large', '消息超过大小上限'));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.send(ws, errorMessage('invalid_json', '消息不是合法的 JSON'));
      return;
    }

    const message = parseSignalMessage(parsed);
    if (message === undefined) {
      this.send(ws, errorMessage('invalid_message', '消息结构不合法'));
      return;
    }

    this.routeMessage(ws, meta, message);
  }

  /** 连接关闭：清理角色并通知对端。 */
  async webSocketClose(ws: WebSocket): Promise<void> {
    const meta = ws.deserializeAttachment() as ConnectionMeta | null;
    if (meta === null) {
      return;
    }

    if (meta.role === ROLE_HOST) {
      await this.markHostOffline(meta.tunnelId);
      this.broadcastToVisitors({
        type: SignalType.PeerGone,
        message: '主机端已断开，请稍后重试',
      });
      return;
    }

    this.notifyHostVisitorLeft(meta);
  }

  /** 连接异常。与正常关闭走同样的清理路径。 */
  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /* ------------------------------ 中继回落 ------------------------------ */

  /**
   * 处理业务层投递来的中继请求。
   *
   * 这是 P2P 打洞失败时的回落路径，也是实测环境下最常见的一条：
   * 本机处于对称 NAT，打洞成功率低，因此中继必须在设计内可靠工作。
   *
   * 流程：把 HTTP 请求转成 RelayRequest 发给主机端，等它回 RelayResponse
   * （可能分片），再把结果还原成 HTTP 响应。
   */
  private async handleRelayRequest(request: Request): Promise<Response> {
    const host = await this.waitForHost();
    if (host === undefined) {
      return Response.json(
        { error: { code: 'agent_offline', message: '主机端尚未接入或已离线' } },
        { status: 503 },
      );
    }

    const targetHost = request.headers.get(RELAY_TARGET_HOST_HEADER) ?? '';
    const targetPort = Number(request.headers.get(RELAY_TARGET_PORT_HEADER) ?? '0');
    if (targetHost === '' || !Number.isInteger(targetPort) || targetPort <= 0) {
      return Response.json(
        { error: { code: 'invalid_request', message: '中继请求缺少目标地址' } },
        { status: 400 },
      );
    }

    const requestId = crypto.randomUUID();
    const body = await readRequestBody(request);

    const message: SignalMessage = {
      type: SignalType.RelayRequest,
      requestId,
      method: request.method,
      path: new URL(request.url).pathname + new URL(request.url).search,
      headers: pickForwardHeaders(request.headers),
      targetHost,
      targetPort,
    };
    if (body.byteLength > 0) {
      message.bodyBase64 = bytesToBase64(body);
    }

    const result = await this.dispatchRelay(host, requestId, message);
    if (result === undefined) {
      return Response.json(
        { error: { code: 'upstream_timeout', message: '主机端未在超时内响应' } },
        { status: 504 },
      );
    }

    return new Response(result.body.byteLength > 0 ? result.body : null, {
      status: result.status,
      statusText: result.statusText,
      headers: sanitizeResponseHeaders(result.headers),
    });
  }

  /**
   * 等待主机端出现。
   *
   * 不立即放弃：主机端可能正在重连（网络抖动、Worker 冷启动）。
   * 短暂轮询能显著减少「第一次访问就报离线」的假失败。
   */
  private async waitForHost(): Promise<WebSocket | undefined> {
    const deadline = Date.now() + HOST_WAIT_TIMEOUT_MS;
    for (;;) {
      const host = this.findHost();
      if (host !== undefined) {
        return host;
      }
      if (Date.now() >= deadline) {
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, HOST_WAIT_INTERVAL_MS));
    }
  }

  /** 发出中继请求并等待响应。超时或被中止返回 undefined。 */
  private dispatchRelay(
    host: WebSocket,
    requestId: string,
    message: SignalMessage,
  ): Promise<RelayResult | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRelays.delete(requestId);
        // 通知主机端别再做无用功。
        this.send(host, { type: SignalType.RelayAbort, requestId });
        resolve(undefined);
      }, RELAY_TIMEOUT_MS);

      this.pendingRelays.set(requestId, { chunks: [], bytes: 0, resolve, timer });
      this.send(host, message);
    });
  }

  /**
   * 处理主机端返回的中继响应分片。
   *
   * 分片是必需的：整个响应体可能远大于单条消息上限，
   * 而 WebSocket 与 DataChannel 两条路径共用同一套分片约定。
   */
  private handleRelayResponse(message: SignalMessage): void {
    const requestId = message.requestId;
    if (requestId === undefined) {
      return;
    }
    const pending = this.pendingRelays.get(requestId);
    if (pending === undefined) {
      // 请求已超时或已被取消，丢弃迟到的分片。
      return;
    }

    if (message.bodyBase64 !== undefined && message.bodyBase64 !== '') {
      const chunk = base64ToBytes(message.bodyBase64);
      pending.chunks.push(chunk);
      pending.bytes += chunk.byteLength;
    }

    if (message.last !== true) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRelays.delete(requestId);

    const merged = new Uint8Array(pending.bytes);
    let offset = 0;
    for (const chunk of pending.chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    pending.resolve({
      status: message.status ?? 502,
      statusText: message.statusText ?? '',
      headers: message.headers ?? {},
      body: merged,
    });
  }

  /* ------------------------------ 消息投递 ------------------------------ */

  private routeMessage(ws: WebSocket, meta: ConnectionMeta, message: SignalMessage): void {
    switch (message.type) {
      case SignalType.Ping:
        this.send(ws, { type: SignalType.Pong });
        return;

      case SignalType.Pong:
        // 保活应答无需处理。
        return;

      default:
        break;
    }

    if (meta.role === ROLE_HOST) {
      // 主机发回的中继响应不走信令转发，直接在这里配对请求。
      if (message.type === SignalType.RelayResponse) {
        this.handleRelayResponse(message);
        return;
      }
      this.forwardFromHost(message);
      return;
    }

    this.forwardFromVisitor(meta, message);
  }

  /**
   * 把访客的消息投递给主机。
   *
   * sessionId 由服务端在连接时分配，这里注入到消息上，
   * 让主机能区分是哪个访客 —— 客户端不需要自己编造会话标识。
   */
  private forwardFromVisitor(meta: ConnectionMeta, message: SignalMessage): void {
    const host = this.findHost();
    if (host === undefined) {
      this.send(this.findVisitorSocket(meta.sessionId), {
        type: SignalType.PeerGone,
        sessionId: meta.sessionId,
        message: '主机端尚未接入',
      });
      return;
    }

    // 访客是浏览器，由用户控制，可能伪造任意 targetPort。
    // 这里按主机端声明的白名单拦一道，避免把注定被拒的请求发出去。
    // 真正的安全边界在 agent 侧（它会独立再校验一次）。
    if (
      message.type === SignalType.RelayRequest &&
      !this.isRelayPortAllowed(host, message.targetPort)
    ) {
      this.send(this.findVisitorSocket(meta.sessionId), {
        type: SignalType.RelayResponse,
        requestId: message.requestId,
        sessionId: meta.sessionId,
        status: 403,
        statusText: 'Forbidden',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        bodyBase64: btoa('端口未在隧道白名单中放行'),
        last: true,
      });
      return;
    }

    this.send(host, { ...message, sessionId: meta.sessionId });
  }

  /** 判断访客请求的端口是否在该主机端声明的白名单内。 */
  private isRelayPortAllowed(host: WebSocket, targetPort: number | undefined): boolean {
    if (targetPort === undefined) {
      return false;
    }
    const meta = host.deserializeAttachment() as ConnectionMeta | null;
    const ports = meta?.allowedPorts ?? [];
    return ports.includes(targetPort);
  }

  /** 把主机的消息投递给对应访客。 */
  private forwardFromHost(message: SignalMessage): void {
    const target = this.findVisitorSocket(message.sessionId);
    if (target === undefined) {
      // 访客已离开，丢弃即可 —— 主机侧会自行超时。
      return;
    }
    this.send(target, message);
  }

  /* ------------------------------ 连接查找 ------------------------------ */

  private findHost(): WebSocket | undefined {
    for (const socket of this.ctx.getWebSockets(ROLE_HOST)) {
      return socket;
    }
    return undefined;
  }

  private findVisitorSocket(sessionId: string | undefined): WebSocket | undefined {
    const sockets = this.ctx.getWebSockets(ROLE_VISITOR);
    if (sessionId === undefined) {
      return sockets[0];
    }
    for (const socket of sockets) {
      const meta = socket.deserializeAttachment() as ConnectionMeta | null;
      if (meta !== null && meta.sessionId === sessionId) {
        return socket;
      }
    }
    return undefined;
  }

  private broadcastToVisitors(message: SignalMessage): void {
    for (const socket of this.ctx.getWebSockets(ROLE_VISITOR)) {
      this.send(socket, message);
    }
  }

  private notifyHostVisitorJoined(meta: ConnectionMeta): void {
    const host = this.findHost();
    if (host === undefined) {
      return;
    }
    this.send(host, {
      type: SignalType.Connect,
      sessionId: meta.sessionId,
      slug: meta.slug,
    });
  }

  private notifyHostVisitorLeft(meta: ConnectionMeta): void {
    const host = this.findHost();
    if (host === undefined) {
      return;
    }
    this.send(host, {
      type: SignalType.PeerGone,
      sessionId: meta.sessionId,
      message: '访客已离开',
    });
  }

  /* ------------------------------ 在线状态 ------------------------------ */

  /**
   * 记录主机上线。
   *
   * 写库失败不导致连接失败 —— 在线登记是观测用途，连接本身是功能用途，
   * 后者优先。但必须留下日志，否则「后台看不到节点」会变成难查的问题。
   */
  private async markHostOnline(
    tunnelId: string,
    info: { hostname: string | null; version: string | null; ports: number[] },
  ): Promise<void> {
    try {
      await queries.upsertAgent(this.env.DB, {
        tunnelId,
        hostname: info.hostname,
        version: info.version,
        reportedPorts: info.ports,
        now: Date.now(),
      });
    } catch (error) {
      logger.warn('agent_online_record_failed', { tunnelId, error: String(error) });
    }
  }

  /**
   * 记录主机下线。
   *
   * 不删除记录：保留主机名与版本，后台显示为「离线」更有信息量。
   * 把 last_seen 回拨一天，使在线窗口判定自然失效。
   */
  private async markHostOffline(tunnelId: string): Promise<void> {
    try {
      await queries.touchAgent(this.env.DB, tunnelId, Date.now() - 86_400_000);
    } catch (error) {
      logger.warn('agent_offline_record_failed', { tunnelId, error: String(error) });
    }
  }

  /* -------------------------------- 工具 -------------------------------- */

  private send(ws: WebSocket | undefined, message: SignalMessage): void {
    if (ws === undefined) {
      return;
    }
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      logger.warn('signal_send_failed', { type: message.type, error: String(error) });
    }
  }
}

/** 解析端口白名单请求头。格式为 JSON 数组，非法输入按空处理。 */
function parsePortsHeader(raw: string | null): number[] {
  if (raw === null || raw === '') {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is number => typeof item === 'number');
  } catch {
    return [];
  }
}

/** 读取请求体。空体返回空数组而不是 null，简化后续判断。 */
async function readRequestBody(request: Request): Promise<Uint8Array> {
  if (request.body === null) {
    return new Uint8Array(0);
  }
  const buffer = await request.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * 挑选需要转发给主机端的请求头。
 *
 * 只保留端到端有意义的头，丢弃逐跳头与 Host：
 *   - Host 必须由主机端按目标地址重写，否则内网服务会看到 Worker 的域名；
 *   - Connection / Upgrade 等逐跳头在 WebSocket 转发里没有意义。
 */
function pickForwardHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  const skip = new Set([
    'host',
    'connection',
    'upgrade',
    'keep-alive',
    'transfer-encoding',
    'content-length',
    'x-nt-target-host',
    'x-nt-target-port',
    'x-nt-slug',
  ]);
  headers.forEach((value, name) => {
    if (!skip.has(name.toLowerCase())) {
      result[name] = value;
    }
  });
  return result;
}

/** 剥掉逐跳头，并加入安全响应头。 */
function sanitizeResponseHeaders(headers: Record<string, string>): Headers {
  const result = new Headers();
  const skip = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade']);
  for (const [name, value] of Object.entries(headers)) {
    if (!skip.has(name.toLowerCase())) {
      result.set(name, value);
    }
  }
  // 隧道内容可能来自不可信的内网服务，禁止其提升为同源特权。
  result.set('X-Content-Type-Options', 'nosniff');
  result.set('Referrer-Policy', 'no-referrer');
  return result;
}

/** base64 编码。用于在 JSON 信令消息里承载二进制体。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // 分块拼接，避免超大数组成字符串时触发参数数量上限。
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

/** base64 解码。 */
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
