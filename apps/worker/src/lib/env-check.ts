import { AppError, ErrorCode } from './errors.js';
import { logger } from './logger.js';

/**
 * 环境配置校验。
 *
 * 安全不变式：缺少必需密钥时必须「启动即失败」，绝不回退到默认值。
 * 使用默认密钥会让任何人都能伪造管理会话。
 */

/** 会话密钥的最小长度（字节）。HMAC-SHA256 的密钥短于 32 字节会削弱安全性。 */
const MIN_SESSION_SECRET_LENGTH = 32;

export interface RequiredSecrets {
  sessionSecret: string;
}

/**
 * 校验并返回必需配置。任一缺失或不合规即抛 AppError（HTTP 500），
 * 由顶层处理器转换为明确的错误响应，而不是静默降级。
 */
export function requireSecrets(env: { ADMIN_SESSION_SECRET?: string }): RequiredSecrets {
  const sessionSecret = env.ADMIN_SESSION_SECRET?.trim() ?? '';

  if (sessionSecret === '') {
    logger.error('missing_required_secrets', { missing: ['ADMIN_SESSION_SECRET'] });
    throw new AppError(
      ErrorCode.MISSING_SECRET,
      '缺少必需的环境变量：ADMIN_SESSION_SECRET。请在 .dev.vars 或 wrangler secret 中配置。',
      { missing: ['ADMIN_SESSION_SECRET'] },
    );
  }

  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    logger.error('session_secret_too_short', { length: sessionSecret.length });
    throw new AppError(
      ErrorCode.MISSING_SECRET,
      `ADMIN_SESSION_SECRET 至少需要 ${MIN_SESSION_SECRET_LENGTH} 字节`,
    );
  }

  return { sessionSecret };
}
