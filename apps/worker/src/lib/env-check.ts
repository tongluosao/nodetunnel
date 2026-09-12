import { AppError, ErrorCode } from './errors.js';
import { logger } from './logger.js';

/**
 * 环境配置校验。
 *
 * 安全不变式：缺少必需密钥时必须「启动即失败」，绝不回退到默认值。
 * 使用默认密钥会让任何人都能伪造管理会话或解密组网密码。
 */

/** 会话密钥的最小长度（字节）。HMAC-SHA256 的密钥短于 32 字节会削弱安全性。 */
const MIN_SESSION_SECRET_LENGTH = 32;

export interface RequiredSecrets {
  sessionSecret: string;
  masterKey: string;
  relayNetworkName: string;
  relayNetworkSecret: string;
}

/**
 * 校验并返回必需配置。任一缺失或不合规即抛 AppError（HTTP 500），
 * 由顶层处理器转换为明确的错误响应，而不是静默降级。
 */
export function requireSecrets(env: {
  ADMIN_SESSION_SECRET?: string;
  NT_MASTER_KEY?: string;
  NT_RELAY_NETWORK_NAME?: string;
  NT_RELAY_NETWORK_SECRET?: string;
}): RequiredSecrets {
  const sessionSecret = env.ADMIN_SESSION_SECRET?.trim() ?? '';
  const masterKey = env.NT_MASTER_KEY?.trim() ?? '';
  const relayNetworkName = env.NT_RELAY_NETWORK_NAME?.trim() ?? '';
  const relayNetworkSecret = env.NT_RELAY_NETWORK_SECRET?.trim() ?? '';

  const missing: string[] = [];
  if (sessionSecret === '') {
    missing.push('ADMIN_SESSION_SECRET');
  }
  if (masterKey === '') {
    missing.push('NT_MASTER_KEY');
  }
  if (relayNetworkName === '') {
    missing.push('NT_RELAY_NETWORK_NAME');
  }
  if (relayNetworkSecret === '') {
    missing.push('NT_RELAY_NETWORK_SECRET');
  }

  if (missing.length > 0) {
    logger.error('missing_required_secrets', { missing });
    throw new AppError(
      ErrorCode.MISSING_SECRET,
      `缺少必需的环境变量：${missing.join('、')}。请在 .dev.vars 或 wrangler secret 中配置。`,
      { missing },
    );
  }

  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    logger.error('session_secret_too_short', { length: sessionSecret.length });
    throw new AppError(
      ErrorCode.MISSING_SECRET,
      `ADMIN_SESSION_SECRET 至少需要 ${MIN_SESSION_SECRET_LENGTH} 字节`,
    );
  }

  return { sessionSecret, masterKey, relayNetworkName, relayNetworkSecret };
}
