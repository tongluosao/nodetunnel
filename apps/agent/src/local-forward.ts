/**
 * 本地请求转发。
 *
 * 把隧道请求转成对 127.0.0.1:<port> 的 HTTP 请求，并读回完整响应。
 *
 * 这是本项目的安全边界所在，因此执行两件事：
 *   1. **再次校验端口白名单**。Worker 已经校验过一次，这里不信任它。
 *      agent 才是真正持有「能否连到本机某个端口」这一能力的一方，
 *      若只有 Worker 判断，一旦 Worker 校验被绕过、或将来出现不经过
 *      Worker 的入站路径（如 P2P 直连），攻击面就直接落到用户内网。
 *   2. **只连回环地址**。转发目标地址由 agent 自己固定为 127.0.0.1，
 *      不采用请求里传来的 host —— 否则这套系统会变成开放的匿名代理。
 */

import { isPortAllowed, type TunnelPort } from '@nodetunnel/shared';

export interface ForwardRequest {
  method: string;
  /** 目标服务上的路径（以 / 开头）。 */
  path: string;
  /** 目标端口。 */
  port: number;
  /** 请求头（已由 Worker 过滤过逐跳头与 Host）。 */
  headers: Record<string, string>;
  /** 请求体。 */
  body: Uint8Array;
}

export interface ForwardResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface ForwardError {
  code: string;
  message: string;
}

/** 单次响应的最大字节数，防止把本机内存吃满。 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** 请求超时。 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 执行一次本地转发。
 *
 * 端口不在白名单时返回错误对象而不是抛异常 —— 「端口未放行」是
 * 一个预期内的业务拒绝，调用方需要把它转成明确的错误响应。
 */
export async function forwardLocal(
  request: ForwardRequest,
  allowedPorts: number[],
): Promise<ForwardResponse | ForwardError> {
  // 安全边界：不信任 Worker 的结论，独立再判一次。
  const ports: TunnelPort[] = allowedPorts.map((port) => ({ port, protocol: 'tcp' }));
  if (!isPortAllowed(ports, request.port, 'tcp')) {
    return {
      code: 'port_not_allowed',
      message: `端口 ${request.port} 未在本地白名单中放行`,
    };
  }

  // 目标固定为回环地址：不接受请求方指定主机。
  const url = `http://127.0.0.1:${request.port}${normalizePath(request.path)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase();
      // Host 必须按本地目标重写，否则本机服务会看到 Worker 的域名；
      // 逐跳头在此路径上没有意义。
      if (lower === 'host' || lower === 'connection' || lower === 'transfer-encoding') {
        continue;
      }
      headers.set(name, value);
    }
    headers.set('X-Forwarded-Proto', 'http');
    headers.set('X-Nodentunnel', '1');

    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: 'manual',
      signal: controller.signal,
    };
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body.byteLength > 0) {
      init.body = request.body;
      headers.set('Content-Length', String(request.body.byteLength));
    }

    const response = await fetch(url, init);
    const buffer = await response.arrayBuffer();

    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
      return {
        code: 'response_too_large',
        message: `目标服务响应体过大（${buffer.byteLength} 字节）`,
      };
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (lower === 'connection' || lower === 'transfer-encoding' || lower === 'content-length') {
        return;
      }
      responseHeaders[name] = value;
    });

    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: new Uint8Array(buffer),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = controller.signal.aborted;
    return {
      code: aborted ? 'upstream_timeout' : 'upstream_error',
      message: aborted
        ? `访问本机服务超时（端口 ${request.port}）`
        : `无法连接本机服务 127.0.0.1:${request.port}：${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 规范化路径，确保以 / 开头且不包含协议或主机。 */
function normalizePath(path: string): string {
  const value = path.trim();
  if (value === '') {
    return '/';
  }
  // 防止把绝对 URL 塞进路径造成请求被引导到其他主机。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return '/';
  }
  return value.startsWith('/') ? value : `/${value}`;
}

/** 判断返回值是错误对象还是正常响应。 */
export function isForwardError(result: ForwardResponse | ForwardError): result is ForwardError {
  return 'code' in result;
}
