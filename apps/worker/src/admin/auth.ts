import type { Env } from '../env.js';
import { AppError, ErrorCode, err, ok, type Result } from '../lib/errors.js';
import { hashPassword, randomBase64, verifyPassword } from '../lib/crypto.js';
import {
  createSessionToken,
  readCookie,
  readSessionToken,
  type SessionPayload,
} from '../lib/session.js';
import { SESSION_COOKIE } from '@nodetunnel/shared';
import * as queries from '../db/queries.js';
import { logger } from '../lib/logger.js';

/**
 * 管理员认证（业务层）。
 *
 * 安全要点：
 *   - 密码使用 PBKDF2-SHA256（600000 次迭代）单向哈希，数据库不存明文；
 *   - 登录失败不区分「用户不存在」与「密码错误」，避免账号枚举；
 *   - 首次初始化只能在管理员表为空时进行，防止被抢占。
 */

export interface AuthenticatedAdmin {
  id: string;
  username: string;
}

export async function isInitialized(env: Env): Promise<boolean> {
  return (await queries.countAdmins(env.DB)) > 0;
}

export interface InitializeInput {
  username: string;
  password: string;
}

/**
 * 首次初始化：创建唯一的初始管理员。
 *
 * 仅当管理员表为空时允许调用；否则返回 ALREADY_INITIALIZED，
 * 避免攻击者在系统初始化后再次创建管理员。
 */
export async function initializeAdmin(
  env: Env,
  input: InitializeInput,
): Promise<Result<AuthenticatedAdmin, AppError>> {
  if (await isInitialized(env)) {
    return err(new AppError(ErrorCode.ALREADY_INITIALIZED));
  }

  const existing = await queries.findAdminByUsername(env.DB, input.username);
  if (existing !== undefined) {
    return err(new AppError(ErrorCode.CONFLICT, '该用户名已被占用', { field: 'username' }));
  }

  const { hash, salt, iterations } = await hashPassword(input.password);
  const id = crypto.randomUUID();
  const now = Date.now();

  await queries.insertAdmin(env.DB, {
    id,
    username: input.username,
    passwordHash: hash,
    passwordSalt: salt,
    iterations,
    now,
  });

  logger.info('admin_initialized', { username: input.username });
  return ok({ id, username: input.username });
}

export interface LoginInput {
  username: string;
  password: string;
}

/**
 * 登录校验。
 *
 * 用户名不存在时仍然执行一次哈希计算（对固定的假盐），
 * 使响应时间与「用户存在但密码错误」接近，降低时序侧信道风险。
 */
export async function login(
  env: Env,
  input: LoginInput,
): Promise<Result<{ admin: AuthenticatedAdmin; token: string }, AppError>> {
  const admin = await queries.findAdminByUsername(env.DB, input.username);

  if (admin === undefined) {
    // 恒定开销：对随机密码做一次同强度哈希。
    await hashPassword(randomBase64(16));
    return err(new AppError(ErrorCode.INVALID_CREDENTIALS));
  }

  const valid = await verifyPassword(input.password, {
    hash: admin.passwordHash,
    salt: admin.passwordSalt,
    iterations: admin.iterations,
  });

  if (!valid) {
    logger.warn('admin_login_failed', { username: input.username });
    return err(new AppError(ErrorCode.INVALID_CREDENTIALS));
  }

  const token = await createSessionToken(
    { id: admin.id, username: admin.username },
    env.ADMIN_SESSION_SECRET,
  );

  logger.info('admin_login_succeeded', { username: admin.username });
  return ok({ admin: { id: admin.id, username: admin.username }, token });
}

/** 从请求解析当前登录的管理员。未登录返回 undefined。 */
export async function currentAdmin(
  request: Request,
  env: Env,
): Promise<AuthenticatedAdmin | undefined> {
  const token = readCookie(request, SESSION_COOKIE);
  const payload: SessionPayload | undefined = await readSessionToken(
    token,
    env.ADMIN_SESSION_SECRET,
  );
  if (payload === undefined) {
    return undefined;
  }

  // 二次确认账号仍存在（可能已被删除）。
  const admin = await queries.findAdminById(env.DB, payload.sub);
  if (admin === undefined) {
    return undefined;
  }

  return { id: admin.id, username: admin.username };
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export async function changePassword(
  env: Env,
  adminId: string,
  input: ChangePasswordInput,
): Promise<Result<true, AppError>> {
  const row = await queries.findAdminById(env.DB, adminId);
  if (row === undefined) {
    return err(new AppError(ErrorCode.NOT_FOUND, '账号不存在'));
  }

  const full = await queries.findAdminByUsername(env.DB, row.username);
  if (full === undefined) {
    return err(new AppError(ErrorCode.NOT_FOUND, '账号不存在'));
  }

  const valid = await verifyPassword(input.currentPassword, {
    hash: full.passwordHash,
    salt: full.passwordSalt,
    iterations: full.iterations,
  });
  if (!valid) {
    return err(
      new AppError(ErrorCode.INVALID_CREDENTIALS, '当前密码不正确', {
        field: 'currentPassword',
      }),
    );
  }

  const { hash, salt, iterations } = await hashPassword(input.newPassword);
  await queries.updateAdminPassword(env.DB, {
    id: adminId,
    passwordHash: hash,
    passwordSalt: salt,
    iterations,
    now: Date.now(),
  });

  logger.info('admin_password_changed', { adminId });
  return ok(true);
}
