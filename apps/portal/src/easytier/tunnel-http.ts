import type { EasyTierTcpStream } from '@easytier/runtime';

/**
 * 通过 EasyTier 的 TCP 流发送 HTTP/1.1 请求。
 *
 * 需求 3 的最终环节：浏览器节点加入虚拟网后，直接与该网内的
 * 目标服务建立 TCP 连接，并在其上手工收发 HTTP/1.1 报文。
 *
 * 为什么手工实现 HTTP 而不复用 fetch：
 *   fetch 无法在浏览器中指定任意源地址的 TCP 连接，
 *   它只能走浏览器自身的网络栈；要穿过虚拟网必须自己控制字节流。
 *
 * 限制与取舍：
 *   1. 只支持 HTTP/1.1：虚拟网内的服务通常是内网明文服务；
 *      HTTPS 需要在隧道侧自行终止 TLS。
 *   2. 使用 Connection: close，读到 EOF 即为报文结束，
 *      避免实现完整的分块传输与 keep-alive 状态机。
 *   3. 不自动跟随重定向：由调用方决定，避免把凭据带到其他主机。
 */

export interface TunnelHttpRequest {
  method: string;
  /** 目标服务上的路径（以 / 开头）。 */
  path: string;
  /** 目标主机名，仅用于 Host 头。 */
  hostHeader: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

export interface TunnelHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** 单次响应的最大字节数，防止恶意服务耗尽浏览器内存。 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** 读取超时（毫秒）。 */
const READ_TIMEOUT_MS = 30_000;

/**
 * 在给定的 TCP 流上执行一次 HTTP/1.1 请求并解析响应。
 *
 * 流在使用后会被关闭（Connection: close 语义）。
 */
export async function requestOverTunnel(
  stream: EasyTierTcpStream,
  request: TunnelHttpRequest,
): Promise<TunnelHttpResponse> {
  try {
    const raw = buildRequestBytes(request);
    await stream.write(raw);
    await stream.shutdownWrite();

    const responseBytes = await readAll(stream);
    return parseResponse(responseBytes);
  } finally {
    await stream.close().catch(() => undefined);
  }
}

/** 组装 HTTP/1.1 请求字节。 */
function buildRequestBytes(request: TunnelHttpRequest): Uint8Array {
  const headers: Record<string, string> = {
    Host: request.hostHeader,
    // 使用短连接：读到 EOF 即为响应结束，无需实现完整的分块状态机。
    Connection: 'close',
    'User-Agent': 'nodetunnel-portal/1.0',
    ...request.headers,
  };

  if (request.body !== undefined && headers['Content-Length'] === undefined) {
    headers['Content-Length'] = String(request.body.byteLength);
  }

  const lines = [`${request.method.toUpperCase()} ${request.path} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`);
  }
  lines.push('', '');

  const headBytes = new TextEncoder().encode(lines.join('\r\n'));
  if (request.body === undefined) {
    return headBytes;
  }

  const combined = new Uint8Array(headBytes.byteLength + request.body.byteLength);
  combined.set(headBytes, 0);
  combined.set(request.body, headBytes.byteLength);
  return combined;
}

/** 持续读取直到 EOF 或超出上限。 */
async function readAll(stream: EasyTierTcpStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + READ_TIMEOUT_MS;

  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`读取隧道响应超时（${READ_TIMEOUT_MS / 1000} 秒）`);
    }

    const result = await stream.read();
    if (result.data.byteLength > 0) {
      chunks.push(result.data);
      total += result.data.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new Error('响应体过大，已中止读取');
      }
    }

    if (result.eof) {
      break;
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * 解析 HTTP/1.1 响应。
 *
 * 支持 Content-Length 与 chunked 两种响应体；两者都不存在时
 * 读取到结尾为止（Connection: close 语义下即为完整响应体）。
 */
export function parseResponse(bytes: Uint8Array): TunnelHttpResponse {
  const separator = findHeaderEnd(bytes);
  if (separator === -1) {
    throw new Error('响应格式错误：未找到 HTTP 头部结束标记');
  }

  const headerText = new TextDecoder('latin1').decode(bytes.subarray(0, separator));
  const lines = headerText.split('\r\n');
  const statusLine = lines[0] ?? '';

  const match = /^HTTP\/\d\.\d\s+(\d{3})\s*(.*)$/.exec(statusLine);
  if (match === null) {
    throw new Error(`响应格式错误：状态行无法解析（${statusLine}）`);
  }

  const status = Number(match[1]);
  const statusText = match[2] ?? '';

  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index === -1) {
      continue;
    }
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    // 同名头以逗号合并，符合 HTTP 语义。
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }

  const bodyStart = separator + 4;
  const rawBody = bytes.subarray(bodyStart);

  const encoding = headers['transfer-encoding']?.toLowerCase() ?? '';
  if (encoding.includes('chunked')) {
    return { status, statusText, headers, body: decodeChunked(rawBody) };
  }

  const contentLength = headers['content-length'];
  if (contentLength !== undefined) {
    const length = Number(contentLength);
    if (Number.isFinite(length) && length >= 0) {
      return { status, statusText, headers, body: rawBody.subarray(0, length) };
    }
  }

  return { status, statusText, headers, body: rawBody };
}

/** 找到 `\r\n\r\n` 的位置。 */
function findHeaderEnd(bytes: Uint8Array): number {
  for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
    if (
      bytes[index] === 0x0d &&
      bytes[index + 1] === 0x0a &&
      bytes[index + 2] === 0x0d &&
      bytes[index + 3] === 0x0a
    ) {
      return index;
    }
  }
  return -1;
}

/** 解码 chunked 传输编码。 */
function decodeChunked(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let total = 0;

  while (offset < bytes.byteLength) {
    const lineEnd = indexOfCrlf(bytes, offset);
    if (lineEnd === -1) {
      break;
    }

    const sizeLine = new TextDecoder('latin1').decode(bytes.subarray(offset, lineEnd));
    // 允许 chunk 扩展（如 "1a;ext=value"）。
    const sizeText = sizeLine.split(';')[0]?.trim() ?? '';
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error('分块响应格式错误：块长度无法解析');
    }
    if (size === 0) {
      break;
    }

    const dataStart = lineEnd + 2;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.byteLength) {
      throw new Error('分块响应格式错误：块数据不完整');
    }

    chunks.push(bytes.subarray(dataStart, dataEnd));
    total += size;
    offset = dataEnd + 2;
  }

  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return merged;
}

function indexOfCrlf(bytes: Uint8Array, from: number): number {
  for (let index = from; index + 1 < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) {
      return index;
    }
  }
  return -1;
}
