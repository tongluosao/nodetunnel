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
    // status 接口在已登录时会带回真实账号，刷新页面后据此恢复顶栏显示。
    // 不能用硬编码的默认用户名：用户名可以被修改，硬编码会让界面长期显示旧值。
    if (status.authenticated) {
      admin.value = status.admin ?? admin.value ?? { id: '', username: '管理员' };
    } else {
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

  /** 改名后同步本地状态，避免顶栏继续显示旧用户名。 */
  function setUsername(username: string): void {
    if (admin.value === undefined) {
      admin.value = { id: '', username };
      return;
    }
    admin.value = { ...admin.value, username };
  }

  return { admin, initialized, version, ready, refresh, login, setup, logout, setUsername };
});
