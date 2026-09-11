/**
 * 结构化日志。
 *
 * 规则：
 *  - 一律输出 JSON，便于 Cloudflare 日志检索；
 *  - 严禁记录密码、network_secret、会话令牌等敏感字段，见 redact()；
 *  - 事件名使用 snake_case，便于聚合。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SENSITIVE_KEYS = [
  'password',
  'password_hash',
  'password_salt',
  'network_secret',
  'network_secret_enc',
  'secret',
  'token',
  'session',
  'cookie',
  'authorization',
  'master_key',
];

/** 递归脱敏：命中敏感键名的值替换为 "[已脱敏]"。 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return '[超出深度]';
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redact(item, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEYS.some((sensitive) => key.toLowerCase().includes(sensitive))
      ? '[已脱敏]'
      : redact(item, depth + 1);
  }
  return output;
}

function emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  const payload = {
    level,
    event,
    time: new Date().toISOString(),
    ...(fields === undefined ? {} : (redact(fields) as Record<string, unknown>)),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => emit('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit('error', event, fields),
};
