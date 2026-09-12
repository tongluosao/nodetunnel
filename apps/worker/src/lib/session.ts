import { SESSION_TTL_SECONDS } from '@nodetunnel/shared';

import { signSession, verifySession } from '../lib/crypto.js';

/**
 * 管理会话令牌。
 *
 * 载荷只包含管理员 id 与用户名，绝不包含密码相关字段。
 * 令牌经 HMAC-SHA256 签名，存放于 HttpOnly Cookie，前端无法读取。
 */

export interface SessionPayload {
  /** 管理员 id。 */
  sub: string;
  /** 用户名，仅用于界面展示。 */
  username: string;
  /** 签发时间（Unix 秒）。 */
  iat: number;
  /** 过期时间（Unix 秒）。 */
  exp: number;
}

export async function createSessionToken(
  admin: { id: string; username: string },
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: SessionPayload = {
    sub: admin.id,
    username: admin.username,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
  };
  return signSession(payload, secret);
}

/** 校验令牌。返回 undefined 表示无效或已过期。 */
export async function readSessionToken(
  token: string | undefined,
  secret: string,
): Promise<SessionPayload | undefined> {
  if (token === undefined || token === '') {
    return undefined;
  }
  const payload = await verifySession<SessionPayload>(token, secret);
  if (payload === undefined) {
    return undefined;
  }
  // 结构校验：防止伪造载荷形状（签名有效但仍需字段自洽）。
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.username !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return undefined;
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    return undefined;
  }
  return payload;
}

/** 构造会话 Cookie。HttpOnly 防止 XSS 读取，SameSite=Lax 兼顾可用性与 CSRF 防护。 */
export function buildSessionCookie(token: string, secure: boolean): string {
  const attributes = [
    `nt_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

/** 构造用于清除会话的 Cookie。 */
export function buildClearSessionCookie(secure: boolean): string {
  const attributes = ['nt_session=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

/** 从请求头解析指定名称的 Cookie。 */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('Cookie');
  if (header === null) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}
