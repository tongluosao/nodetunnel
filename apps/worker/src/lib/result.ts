/**
 * 显式结果类型。
 *
 * 项目约定：跨层调用的可预期失败必须用 Result 表达，而不是抛异常；
 * 异常只保留给「程序缺陷」与「不可恢复的基础设施故障」。
 */

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** 取出成功值，失败时抛出。仅用于已经确认成功、或缺陷即崩溃的场景。 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`unwrap 遇到错误结果: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

/** 把 Result 映射为另一个成功值，保持错误不变。 */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}
