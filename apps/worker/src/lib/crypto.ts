import { AppError, ErrorCode, err, ok, type Result } from './errors.js';

/**
 * 密码学原语。全部基于 WebCrypto（Cloudflare Workers 原生支持），
 * 不引入第三方加密库，避免供应链与体积风险。
 *
 * 约定：
 *  - 管理员密码用 PBKDF2-SHA256 单向哈希，绝不明文或可逆存储；
 *  - tunnel 的 network_secret 必须能回传给客户端，故用 AES-GCM 加密存储；
 *  - 会话令牌用 HMAC-SHA256 签名。
 */

/** PBKDF2 迭代次数。OWASP 2023 对 PBKDF2-SHA256 的建议下限为 600,000。 */
export const PBKDF2_ITERATIONS = 600_000;

/** 盐与 IV 长度（字节）。 */
const SALT_BYTES = 16;
const IV_BYTES = 12;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * 常量时间比较，避免通过响应时间推断哈希前缀。
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= (a[index] as number) ^ (b[index] as number);
  }
  return diff === 0;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    material,
    256,
  ) as unknown as Promise<CryptoKey>;
}

export interface PasswordHash {
  hash: string;
  salt: string;
  iterations: number;
}

/** 生成密码哈希。每次调用产生新的随机盐。 */
export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const bits = (await deriveKey(password, salt, iterations)) as unknown as ArrayBuffer;
  return {
    hash: toBase64(new Uint8Array(bits)),
    salt: toBase64(salt),
    iterations,
  };
}

/** 校验密码。使用常量时间比较。 */
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const salt = fromBase64(stored.salt);
  const bits = (await deriveKey(password, salt, stored.iterations)) as unknown as ArrayBuffer;
  return timingSafeEqual(new Uint8Array(bits), fromBase64(stored.hash));
}

async function importMasterKey(masterKeyBase64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = fromBase64(masterKeyBase64);
  } catch {
    throw new AppError(ErrorCode.MISSING_SECRET, 'NT_MASTER_KEY 不是合法的 base64');
  }
  if (raw.length !== 32) {
    throw new AppError(ErrorCode.MISSING_SECRET, 'NT_MASTER_KEY 解码后必须为 32 字节');
  }
  return crypto.subtle.importKey('raw', raw as unknown as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * 加密需要回传给客户端的敏感配置（如 network_secret）。
 * 输出格式：`v1:<iv-base64>:<ciphertext-base64>`，带版本前缀以便将来轮换算法。
 */
export async function encryptSecret(
  plaintext: string,
  masterKeyBase64: string,
): Promise<Result<string, AppError>> {
  try {
    const key = await importMasterKey(masterKeyBase64);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      textEncoder.encode(plaintext) as unknown as BufferSource,
    );
    return ok(`v1:${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`);
  } catch (error) {
    return err(
      error instanceof AppError
        ? error
        : new AppError(ErrorCode.CONFIG_ENCRYPTION_FAILED, undefined, { cause: String(error) }),
    );
  }
}

/** 解密 encryptSecret 的输出。 */
export async function decryptSecret(
  encoded: string,
  masterKeyBase64: string,
): Promise<Result<string, AppError>> {
  const parts = encoded.split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    return err(new AppError(ErrorCode.CONFIG_ENCRYPTION_FAILED, '密文格式不正确'));
  }
  try {
    const key = await importMasterKey(masterKeyBase64);
    const iv = fromBase64(parts[1] as string);
    const ciphertext = fromBase64(parts[2] as string);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource,
    );
    return ok(textDecoder.decode(plaintext));
  } catch (error) {
    return err(
      new AppError(ErrorCode.CONFIG_ENCRYPTION_FAILED, undefined, { cause: String(error) }),
    );
  }
}

/** 生成指定字节数的随机 base64 字符串。 */
export function randomBase64(byteLength = 32): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** 生成 URL 安全的短随机 ID。 */
export function randomId(prefix = ''): string {
  return `${prefix}${crypto.randomUUID()}`;
}

/* ------------------------------ 接入令牌 ------------------------------ */

/**
 * 生成隧道接入令牌。
 *
 * 32 字节随机数据，base64url 编码后加 `nt_` 前缀。
 * 前缀的作用是让人在日志与配置文件里一眼认出这是凭据，
 * 避免它被当成普通标识符随手贴出去。
 */
export function generateTunnelToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64url = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `nt_${base64url}`;
}

/**
 * 计算令牌的存储摘要。
 *
 * 用一次 SHA-256 而非 PBKDF2：令牌是服务端生成的 32 字节随机值，
 * 不存在「弱口令被穷举」的风险，慢哈希只会拖慢每次握手。
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(token) as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** 令牌前 8 位，仅供管理后台辨认。 */
export function tokenPrefix(token: string): string {
  return token.slice(0, 8);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret) as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** 用 HMAC-SHA256 为会话载荷签名，返回 `<base64url(payload)>.<base64url(signature)>`。 */
export async function signSession(payload: unknown, secret: string): Promise<string> {
  const body = toBase64(textEncoder.encode(JSON.stringify(payload)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(body) as unknown as BufferSource,
  );
  const encodedSignature = toBase64(new Uint8Array(signature))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${body}.${encodedSignature}`;
}

/** 校验会话令牌并返回载荷；签名不匹配或格式错误返回 undefined。 */
export async function verifySession<T>(token: string, secret: string): Promise<T | undefined> {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) {
    return undefined;
  }
  const body = token.slice(0, separator);
  const signaturePart = token.slice(separator + 1);
  const key = await importHmacKey(secret);
  const expected = await crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(body) as unknown as BufferSource,
  );
  const expectedEncoded = toBase64(new Uint8Array(expected))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  if (!timingSafeEqual(textEncoder.encode(expectedEncoded), textEncoder.encode(signaturePart))) {
    return undefined;
  }
  try {
    const padded = body.replace(/-/g, '+').replace(/_/g, '/');
    const json = textDecoder.decode(fromBase64(padded));
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}
