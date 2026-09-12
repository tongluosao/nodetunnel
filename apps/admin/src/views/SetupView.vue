<script setup lang="ts">
import { message } from 'ant-design-vue';
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { validatePassword, validateUsername } from '@nodetunnel/shared';

/**
 * 首次初始化页（需求 2）。
 *
 * 仅当系统尚未创建管理员时可访问；提交成功后立即登录并进入仪表盘。
 * 密码强度在前后端同时校验，前端规则来自 @nodetunnel/shared，
 * 确保两侧判定完全一致。
 */

const auth = useAuthStore();
const router = useRouter();
const submitting = ref(false);

const form = reactive({
  username: '',
  password: '',
  confirm: '',
});

const errors = reactive({
  username: '',
  password: '',
  confirm: '',
});

function validate(): boolean {
  errors.username = '';
  errors.password = '';
  errors.confirm = '';

  const username = validateUsername(form.username);
  if (!username.ok) {
    errors.username = username.message;
  }

  const password = validatePassword(form.password);
  if (!password.ok) {
    errors.password = password.message;
  }

  if (form.confirm !== form.password) {
    errors.confirm = '两次输入的密码不一致';
  }

  return errors.username === '' && errors.password === '' && errors.confirm === '';
}

async function submit(): Promise<void> {
  if (!validate()) {
    return;
  }

  submitting.value = true;
  try {
    await auth.setup(form.username, form.password);
    message.success('初始化完成，已自动登录');
    await router.push({ name: 'dashboard' });
  } catch (error) {
    const text = error instanceof ApiError ? error.message : '初始化失败，请检查服务端日志';
    message.error(text);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="nt-centered">
    <div class="nt-card">
      <div class="nt-brand">
        <h1 class="nt-brand__title">初始化 NodeTunnel</h1>
        <p class="nt-brand__subtitle">首次使用请设置管理员账号。该账号用于管理隧道、路由与节点。</p>
      </div>

      <a-form layout="vertical" @submit.prevent="submit">
        <a-form-item
          label="管理员用户名"
          :validate-status="errors.username ? 'error' : ''"
          :help="errors.username"
        >
          <a-input
            v-model:value="form.username"
            size="large"
            placeholder="例如 admin"
            autocomplete="username"
          />
        </a-form-item>

        <a-form-item
          label="密码"
          :validate-status="errors.password ? 'error' : ''"
          :help="errors.password || '至少 12 位，需同时包含字母与数字'"
        >
          <a-input-password
            v-model:value="form.password"
            size="large"
            placeholder="请输入密码"
            autocomplete="new-password"
          />
        </a-form-item>

        <a-form-item
          label="确认密码"
          :validate-status="errors.confirm ? 'error' : ''"
          :help="errors.confirm"
        >
          <a-input-password
            v-model:value="form.confirm"
            size="large"
            placeholder="请再次输入密码"
            autocomplete="new-password"
          />
        </a-form-item>

        <a-button type="primary" size="large" block :loading="submitting" @click="submit">
          创建管理员并进入
        </a-button>
      </a-form>
    </div>
  </div>
</template>
