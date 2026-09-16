/**
 * HTTP/1.1 报文的构造与解析。
 *
 * 为什么手工实现而不复用 fetch：
 *   浏览器的 fetch 只能走浏览器自身的网络栈，无法在 WebRTC DataChannel
 *   上收发字节；要穿过隧道就必须自己控制字节流。
 *
 * 取舍：
 *   1. 只支持 HTTP/1.1：被暴露的服务是内网明文服务，HTTPS 需由主机端终止 TLS；
 *   2. 使用 Connection: close + 显式 Content-Length，读到声明长度即结束，
 *      避免实现完整的 keep-alive 状态机；
 *   3. 不自动跟随重定向：由调用方决定，避免把凭据带到其他主机。
 *
 * 本模块是纯函数，不依赖浏览器 API，因此可以在 node 环境下直接测试。
 */

export interface HttpRequest {
  method: string;
  /** 目标服务上的路径（以 / 开头，可含查询串）。 */
  path: string;
  /** 目标主机名，仅用于 Host 头。 */
  hostHeader: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

const textEncoder = new TextEncoder();
const latin1Decoder = new TextDecoder('latin1');

/** 组装 HTTP/1.1 请求字节。 */
export function buildRequestBytes(request: HttpRequest): Uint8Array {
  const headers: Record<string, string> = {
    Host: request.hostHeader,
    Connection: 'close',
    'User-Agent': 'nodetunnel-portal/2.0',
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

  const headBytes = textEncoder.encode(lines.join('\r\n'));
  if (request.body === undefined) {
    return headBytes;
  }

  const combined = new Uint8Array(headBytes.byteLength + request.body.byteLength);
  combined.set(headBytes, 0);
  combined.set(request.body, headBytes.byteLength);
  return combined;
}

/**
 * 响应解析的结果。
 *
 * `complete` 为 false 表示头部已到齐但体还不完整 —— 调用方应继续读，
 * 而不是把它当成一个残缺的响应去用。
 */
export interface ParseResult {
  response: HttpResponse;
  complete: boolean;
}

/**
 * 解析 HTTP/1.1 响应。
 *
 * 支持 Content-Length 与 chunked 两种响应体。两者都不存在时按
 * Connection: close 语义处理：读到 EOF 才是完整响应体。
 */
export function parseResponse(bytes: Uint8Array, ended = true): ParseResult {
  const separator = findHeaderEnd(bytes);
  if (separator === -1) {
    throw new Error('响应格式错误：未找到 HTTP 头部结束标记');
  }

  const headerText = latin1Decoder.decode(bytes.subarray(0, separator));
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

  const rawBody = bytes.subarray(separator + 4);

  const encoding = headers['transfer-encoding']?.toLowerCase() ?? '';
  if (encoding.includes('chunked')) {
    const decoded = decodeChunked(rawBody);
    return {
      response: { status, statusText, headers, body: decoded.body },
      complete: decoded.complete,
    };
  }

  const contentLength = headers['content-length'];
  if (contentLength !== undefined) {
    const length = Number(contentLength);
    if (Number.isFinite(length) && length >= 0) {
      if (rawBody.byteLength < length) {
        // 体还没收全，先返回已收到的部分并标记未完成。
        return {
          response: { status, statusText, headers, body: rawBody },
          complete: false,
        };
      }
      return {
        response: { status, statusText, headers, body: rawBody.subarray(0, length) },
        complete: true,
      };
    }
  }

  // 无长度声明：只有在连接结束时才能确认响应完整。
  return { response: { status, statusText, headers, body: rawBody }, complete: ended };
}

/** 找到 `\r\n\r\n` 的位置。 */
export function findHeaderEnd(bytes: Uint8Array): number {
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
function decodeChunked(bytes: Uint8Array): { body: Uint8Array; complete: boolean } {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let total = 0;

  for (;;) {
    if (offset >= bytes.byteLength) {
      // 块长度行还没到齐。
      return { body: merge(chunks, total), complete: false };
    }

    const lineEnd = indexOfCrlf(bytes, offset);
    if (lineEnd === -1) {
      return { body: merge(chunks, total), complete: false };
    }

    const sizeLine = latin1Decoder.decode(bytes.subarray(offset, lineEnd));
    // 允许 chunk 扩展（如 "1a;ext=value"）。
    const sizeText = sizeLine.split(';')[0]?.trim() ?? '';
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error('分块响应格式错误：块长度无法解析');
    }
    if (size === 0) {
      // 结束块；尾部头（trailer）不解析，直接视为完成。
      return { body: merge(chunks, total), complete: true };
    }

    const dataStart = lineEnd + 2;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.byteLength) {
      return { body: merge(chunks, total), complete: false };
    }

    chunks.push(bytes.subarray(dataStart, dataEnd));
    total += size;
    // 跳过块数据后面的 CRLF。
    offset = dataEnd + 2;
  }
}

function merge(chunks: Uint8Array[], total: number): Uint8Array {
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

/** base64 → 字节。用于信令消息里的二进制体。 */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** 字节 → base64。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // 分块拼接，避免超大数组触发参数数量上限。
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}
