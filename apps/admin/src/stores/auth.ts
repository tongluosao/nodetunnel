import { defineStore } from 'pinia';
import { ref } from 'vue';

import { api, ApiError, type AdminInfo, type AuthStatus } from '@/api/client';

/**
 * 认证状态。
 *
 * 首次登录流程（需求 2）：
 *   进入应用 -> 查询 /auth/status ->
 *     initialized === false -> 跳转 /setup 设置管理员用户名与密码
 *     initialized === true  -> 未登录则跳转 /login
 */
export const useAuthStore = defineStore('auth', () => {
  const admin = ref<AdminInfo | undefined>(undefined);
  const initialized = ref(false);
  const version = ref('');
  const ready = ref(false);

  async function refresh(): Promise<AuthStatus> {
    const status = await api.auth.status();
    initialized.value = status.initialized;
    version.value = status.version;
    // status 接口只返回是否已登录，管理员信息在登录时获得；
    // 刷新页面后若已登录，用一次受保护请求确认会话仍有效。
    if (status.authenticated && admin.value === undefined) {
      admin.value = { id: '', username: 'admin' };
    }
    if (!status.authenticated) {
      admin.value = undefined;
    }
    ready.value = true;
    return status;
  }

  async function login(username: string, password: string): Promise<void> {
    const result = await api.auth.login(username, password);
    admin.value = result.admin;
    initialized.value = true;
  }

  async function setup(username: string, password: string): Promise<void> {
    const result = await api.setup(username, password);
    admin.value = result.admin;
    initialized.value = true;
  }

  async function logout(): Promise<void> {
    try {
      await api.auth.logout();
    } catch (error) {
      // 登出失败不应阻塞前端清理会话状态。
      if (!(error instanceof ApiError)) {
        throw error;
      }
    }
    admin.value = undefined;
  }

  return { admin, initialized, version, ready, refresh, login, setup, logout };
});
