/**
 * 日志。
 *
 * agent 是本地常驻进程，直接输出到 stdout 即可；
 * 但必须经过这里而不是各处 console.log，以便：
 *   1. 统一格式，便于用户复制给我们排查；
 *   2. 集中脱敏 —— 令牌绝不能出现在日志里。
 */

export type LogLevel = 'info' | 'warn' | 'error';

/** 需要脱敏的字段名。 */
const REDACTED_KEYS = new Set(['token', 'authorization', 'secret', 'password']);

export function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const stamp = new Date().toISOString();
  const suffix =
    fields === undefined || Object.keys(fields).length === 0
      ? ''
      : ` ${JSON.stringify(redact(fields))}`;

  const line = `[${stamp}] ${level.toUpperCase()} ${message}${suffix}`;

  if (level === 'error') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

/** 递归脱敏。 */
function redact(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      output[key] = '***';
      continue;
    }
    output[key] = item;
  }
  return output;
}
