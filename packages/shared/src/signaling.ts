/**
 * 信令协议（Worker ↔ agent ↔ portal 的唯一线协议）。
 *
 * 设计要点：
 *   1. 一条连接两用。agent 到 Worker 只维持一条 WebSocket，既走信令
 *      （SDP/ICE 交换）也走中继回落（请求/响应帧），用 `type` 区分，
 *      不再为「中继」另开一条通道。少一条连接就少一处需要保活与鉴权的地方。
 *   2. 信令只做转发。Worker 不解析 SDP，也不碰 ICE 候选内容 ——
 *      它只负责把消息投递给同一房间内的对端。P2P 由浏览器与 agent
 *      各自的 ICE 栈自行完成。
 *   3. 中继回落是常态而非异常。实测本机所处网络为对称 NAT，
 *      打洞成功率低，因此中继路径必须是设计内的一等公民。
 */

/** 消息类型。字符串字面量便于日志阅读与跨语言实现。 */
export const SignalType = {
  /** agent -> Worker：宣告自己接入，携带令牌。 */
  Hello: 'hello',
  /** Worker -> agent：接入被接受。 */
  Ready: 'ready',
  /** 双向：连接保活。 */
  Ping: 'ping',
  /** 双向：保活应答。 */
  Pong: 'pong',

  /** portal -> Worker：请求与某 tunnel 建立会话。 */
  Connect: 'connect',
  /** Worker -> portal：已建立会话，可以开始交换 SDP。 */
  Connected: 'connected',
  /** Worker -> portal/agent：对端已离开或连接被拒。 */
  PeerGone: 'peer-gone',

  /** 双向：WebRTC SDP 描述，透传给对端。 */
  Description: 'description',
  /** 双向：单个 ICE 候选，透传给对端。 */
  Candidate: 'candidate',

  /** portal -> agent：经中继发起一次 HTTP 请求。 */
  RelayRequest: 'relay-request',
  /** agent -> portal：中继响应（可能分片）。 */
  RelayResponse: 'relay-response',
  /** 双向：中止一个进行中的中继请求。 */
  RelayAbort: 'relay-abort',

  /** 双向：协议级错误。 */
  Error: 'error',
} as const;

export type SignalTypeValue = (typeof SignalType)[keyof typeof SignalType];

/**
 * 信令消息的统一信封。
 *
 * 每个消息都带 `type`；其余字段按类型而定。用宽松的可选字段而非
 * 联合类型，是为了让「收到未知类型」这一情况能被显式处理而不是崩溃。
 */
export interface SignalMessage {
  type: SignalTypeValue | string;
  /** 会话 ID，由 Worker 在 Connected 时分配。信令与中继帧都带它。 */
  sessionId?: string;
  /** 请求 ID，中继请求/响应配对用；与 sessionId 相互独立。 */
  requestId?: string;

  /* --- hello / ready --- */
  /** agent 接入令牌（仅 hello）。 */
  token?: string;
  /** agent 上报的本地可达端口，供管理后台核对白名单。 */
  reportedPorts?: number[];
  hostname?: string;
  version?: string;

  /* --- connect --- */
  /** portal 请求接入的路由 slug。 */
  slug?: string;

  /* --- description / candidate --- */
  /** SDP 内容（仅 description）。 */
  sdp?: string;
  /** SDP 类型：offer / answer。 */
  sdpType?: 'offer' | 'answer';
  /** ICE 候选（仅 candidate）。 */
  candidate?: string;
  /** 候选所属的媒体行索引。 */
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;

  /* --- relay-request / relay-response --- */
  /** 中继请求的方法与路径。 */
  method?: string;
  path?: string;
  /** 目标服务地址，agent 侧据此建立本地连接。 */
  targetHost?: string;
  targetPort?: number;
  headers?: Record<string, string>;
  /** 请求/响应体。base64 编码，空体为省略。 */
  bodyBase64?: string;
  /** 响应状态码（仅 relay-response）。 */
  status?: number;
  statusText?: string;
  /** 分片序号与是否最后一片（仅 relay-response）。 */
  chunkIndex?: number;
  last?: boolean;

  /* --- error --- */
  code?: string;
  message?: string;
}

/** 构造 hello 消息。 */
export function helloMessage(input: {
  token: string;
  hostname?: string;
  version?: string;
  reportedPorts?: number[];
}): SignalMessage {
  const message: SignalMessage = { type: SignalType.Hello, token: input.token };
  if (input.hostname !== undefined) message.hostname = input.hostname;
  if (input.version !== undefined) message.version = input.version;
  if (input.reportedPorts !== undefined) message.reportedPorts = input.reportedPorts;
  return message;
}

/** 构造错误消息。 */
export function errorMessage(code: string, message: string): SignalMessage {
  return { type: SignalType.Error, code, message };
}

/**
 * 校验一条收到的消息是不是结构合法的信令消息。
 *
 * 只做结构校验，不做语义校验：解析边界必须拒绝畸形输入，
 * 但不应该因为多了未知字段就丢弃消息（便于将来平滑扩展）。
 */
export function parseSignalMessage(raw: unknown): SignalMessage | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.type !== 'string' || record.type === '') {
    return undefined;
  }
  // 结构已确认有非空 type；其余字段按类型可选，交由各处理分支自行收窄。
  return { ...record, type: record.type };
}
