<script setup lang="ts">
import { message } from 'ant-design-vue';
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

/**
 * 登录页。
 *
 * 错误提示统一使用服务端返回的文案：服务端不区分「用户不存在」
 * 与「密码错误」，前端也不应暗示具体原因，避免账号枚举。
 */

const auth = useAuthStore();
const router = useRouter();
const submitting = ref(false);

const form = reactive({ username: '', password: '' });

async function submit(): Promise<void> {
  if (form.username === '' || form.password === '') {
    message.warning('请输入用户名与密码');
    return;
  }

  submitting.value = true;
  try {
    await auth.login(form.username, form.password);
    message.success('登录成功');
    await router.push({ name: 'dashboard' });
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '登录失败，请稍后重试');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="nt-centered">
    <div class="nt-card">
      <div class="nt-brand">
        <h1 class="nt-brand__title">NodeTunnel</h1>
        <p class="nt-brand__subtitle">登录以管理隧道、路由与主机端</p>
      </div>

      <a-form layout="vertical" @submit.prevent="submit">
        <a-form-item label="用户名">
          <a-input
            v-model:value="form.username"
            size="large"
            placeholder="请输入用户名"
            autocomplete="username"
          />
        </a-form-item>

        <a-form-item label="密码">
          <a-input-password
            v-model:value="form.password"
            size="large"
            placeholder="请输入密码"
            autocomplete="current-password"
            @press-enter="submit"
          />
        </a-form-item>

        <a-button type="primary" size="large" block :loading="submitting" @click="submit">
          登录
        </a-button>
      </a-form>
    </div>
  </div>
</template>
