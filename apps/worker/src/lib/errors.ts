import { err, ok, type Result } from './result.js';

/**
 * 业务错误码。
 *
 * 每个错误码都对应一个确定的 HTTP 状态码与面向用户的中文消息。
 * 新增错误码时必须同时：
 *   1. 在此处登记；
 *   2. 在 ERROR_STATUS 中登记状态码；
 *   3. 若对外暴露，在 apps/admin 或 portal 的文案表中登记。
 */
export const ErrorCode = {
  // 请求与校验
  INVALID_REQUEST: 'invalid_request',
  VALIDATION_FAILED: 'validation_failed',

  // 认证与授权
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  ALREADY_INITIALIZED: 'already_initialized',
  NOT_INITIALIZED: 'not_initialized',
  INVALID_CREDENTIALS: 'invalid_credentials',

  // 资源
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',

  // 配置与密钥
  MISSING_SECRET: 'missing_secret',
  CONFIG_ENCRYPTION_FAILED: 'config_encryption_failed',

  // 隧道与中继
  RELAY_UNAVAILABLE: 'relay_unavailable',
  TUNNEL_DISABLED: 'tunnel_disabled',
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  UPSTREAM_ERROR: 'upstream_error',

  // 兜底
  INTERNAL_ERROR: 'internal_error',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

const ERROR_STATUS: Record<ErrorCodeValue, number> = {
  [ErrorCode.INVALID_REQUEST]: 400,
  [ErrorCode.VALIDATION_FAILED]: 422,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.ALREADY_INITIALIZED]: 409,
  [ErrorCode.NOT_INITIALIZED]: 428,
  [ErrorCode.INVALID_CREDENTIALS]: 401,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.MISSING_SECRET]: 500,
  [ErrorCode.CONFIG_ENCRYPTION_FAILED]: 500,
  [ErrorCode.RELAY_UNAVAILABLE]: 503,
  [ErrorCode.TUNNEL_DISABLED]: 503,
  [ErrorCode.UPSTREAM_TIMEOUT]: 504,
  [ErrorCode.UPSTREAM_ERROR]: 502,
  [ErrorCode.INTERNAL_ERROR]: 500,
};

const ERROR_MESSAGE: Record<ErrorCodeValue, string> = {
  [ErrorCode.INVALID_REQUEST]: '请求格式不正确',
  [ErrorCode.VALIDATION_FAILED]: '请求参数校验未通过',
  [ErrorCode.UNAUTHORIZED]: '请先登录',
  [ErrorCode.FORBIDDEN]: '没有权限执行该操作',
  [ErrorCode.ALREADY_INITIALIZED]: '系统已初始化',
  [ErrorCode.NOT_INITIALIZED]: '系统尚未初始化，请先设置管理员账号',
  [ErrorCode.INVALID_CREDENTIALS]: '用户名或密码不正确',
  [ErrorCode.NOT_FOUND]: '资源不存在',
  [ErrorCode.CONFLICT]: '资源冲突',
  [ErrorCode.MISSING_SECRET]: '服务端缺少必需的密钥配置',
  [ErrorCode.CONFIG_ENCRYPTION_FAILED]: '配置加解密失败',
  [ErrorCode.RELAY_UNAVAILABLE]: 'EasyTier 中继当前不可用',
  [ErrorCode.TUNNEL_DISABLED]: '该隧道已被禁用',
  [ErrorCode.UPSTREAM_TIMEOUT]: '访问目标服务超时',
  [ErrorCode.UPSTREAM_ERROR]: '目标服务返回错误',
  [ErrorCode.INTERNAL_ERROR]: '服务内部错误',
};

/** 统一的业务错误。携带错误码与可选的补充信息（字段名、冲突值等）。 */
export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCodeValue,
    message?: string,
    details?: Record<string, unknown>,
  ) {
    super(message ?? ERROR_MESSAGE[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  /** 序列化为对外的 JSON 响应体。不泄露堆栈与内部细节。 */
  toBody(): { error: { code: ErrorCodeValue; message: string; details?: Record<string, unknown> } } {
    const error: { code: ErrorCodeValue; message: string; details?: Record<string, unknown> } = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) {
      error.details = this.details;
    }
    return { error };
  }
}

/** 便捷构造：校验失败，附带字段级说明。 */
export function validationError(details: Record<string, unknown>): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, undefined, details);
}

/** 便捷构造：资源冲突，附带冲突字段。 */
export function conflictError(details: Record<string, unknown>): AppError {
  return new AppError(ErrorCode.CONFLICT, undefined, details);
}

/**
 * 把「可预期失败」的 Result 收敛为 AppError 抛出，供只在最外层捕获的调用链使用。
 * 注意：仅在确实无法用 Result 表达的控制流中使用。
 */
export function toAppError<E>(error: E, code: ErrorCodeValue = ErrorCode.INTERNAL_ERROR): AppError {
  if (error instanceof AppError) {
    return error;
  }
  return new AppError(code, undefined, { cause: String(error) });
}

/** 把 Result 转换为「成功返回 T，失败抛 AppError」。 */
export function requireOk<T, E>(result: Result<T, E>, code?: ErrorCodeValue): T {
  if (result.ok) {
    return result.value;
  }
  throw toAppError(result.error, code);
}

export { ok, err };
