<script setup lang="ts">
import { message } from 'ant-design-vue';
import { computed, onMounted, reactive, ref } from 'vue';

import { api, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { CONFIG_SERVER_PATH, ROUTE_PREFIX } from '@nodetunnel/shared';
import { validatePassword } from '@nodetunnel/shared';

/**
 * 系统设置：接入信息与管理员改密。
 *
 * 接入信息由当前页面地址推导，确保管理员复制到的地址
 * 与实际部署的域名一致。
 */

const auth = useAuthStore();
const saving = ref(false);
const relayState = ref('unknown');
const relayConnections = ref(0);

const password = reactive({ current: '', next: '', confirm: '' });
const passwordErrors = reactive({ current: '', next: '', confirm: '' });

const wsOrigin = computed(() => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
});

const configServerUrl = computed(() => `${wsOrigin.value}${CONFIG_SERVER_PATH}`);
const relayUrlTemplate = computed(() => `${wsOrigin.value}/relay?network=<组网名>`);
const routePrefix = computed(() => `${window.location.origin}${ROUTE_PREFIX}/<slug>/`);

async function loadRelayStatus(): Promise<void> {
  try {
    const health = await api.system.relayHealth();
    relayState.value = health.state ?? (health.ok ? 'running' : 'stopped');
    relayConnections.value = health.connections ?? 0;
  } catch {
    relayState.value = 'unreachable';
  }
}

async function copy(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    message.success(`${label}已复制`);
  } catch {
    message.warning('复制失败，请手动选择文本复制');
  }
}

function validatePasswordForm(): boolean {
  passwordErrors.current = '';
  passwordErrors.next = '';
  passwordErrors.confirm = '';

  if (password.current === '') {
    passwordErrors.current = '请输入当前密码';
  }

  const next = validatePassword(password.next);
  if (!next.ok) {
    passwordErrors.next = next.message;
  }

  if (password.confirm !== password.next) {
    passwordErrors.confirm = '两次输入的新密码不一致';
  }

  return (
    passwordErrors.current === '' && passwordErrors.next === '' && passwordErrors.confirm === ''
  );
}

async function changePassword(): Promise<void> {
  if (!validatePasswordForm()) {
    return;
  }

  saving.value = true;
  try {
    await api.auth.changePassword(password.current, password.next);
    message.success('密码已更新，请使用新密码重新登录');
    password.current = '';
    password.next = '';
    password.confirm = '';
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '修改密码失败');
  } finally {
    saving.value = false;
  }
}

onMounted(loadRelayStatus);
</script>

<template>
  <div class="nt-panel-card">
    <h2 class="nt-panel-card__title">接入信息</h2>
    <p class="nt-hint">
      以下地址由当前访问域名推导。若管理后台与 Worker 部署在不同域名， 请把
      <code class="nt-mono">{{ CONFIG_SERVER_PATH }}</code> 与
      <code class="nt-mono">/relay</code> 替换为 Worker 的实际域名。
    </p>

    <a-descriptions :column="1" size="small" bordered>
      <a-descriptions-item label="配置服务器地址">
        <div style="display: flex; align-items: center; gap: 10px">
          <span class="nt-mono">{{ configServerUrl }}</span>
          <a-button size="small" @click="copy(configServerUrl, '配置服务器地址')">复制</a-button>
        </div>
      </a-descriptions-item>

      <a-descriptions-item label="中继地址模板">
        <div style="display: flex; align-items: center; gap: 10px">
          <span class="nt-mono">{{ relayUrlTemplate }}</span>
          <a-button size="small" @click="copy(relayUrlTemplate, '中继地址模板')">复制</a-button>
        </div>
      </a-descriptions-item>

      <a-descriptions-item label="隧道访问前缀">
        <div style="display: flex; align-items: center; gap: 10px">
          <span class="nt-mono">{{ routePrefix }}</span>
          <a-button size="small" @click="copy(routePrefix, '访问前缀')">复制</a-button>
        </div>
      </a-descriptions-item>

      <a-descriptions-item label="中继状态">
        <a-tag :color="relayState === 'running' ? 'green' : 'red'">
          {{ relayState === 'running' ? '运行中' : relayState }}
        </a-tag>
        <span style="margin-left: 10px; color: var(--nt-text-dim)">
          当前连接数 {{ relayConnections }}
        </span>
        <a-button size="small" style="margin-left: 10px" @click="loadRelayStatus">刷新</a-button>
      </a-descriptions-item>

      <a-descriptions-item label="服务版本">
        <span class="nt-mono">{{ auth.version || '—' }}</span>
      </a-descriptions-item>
    </a-descriptions>
  </div>

  <div class="nt-panel-card">
    <h2 class="nt-panel-card__title">修改密码</h2>
    <p class="nt-hint">修改后当前会话仍有效，建议重新登录一次以确认新密码可用。</p>

    <a-form layout="vertical" style="max-width: 420px">
      <a-form-item
        label="当前密码"
        :validate-status="passwordErrors.current ? 'error' : ''"
        :help="passwordErrors.current"
      >
        <a-input-password v-model:value="password.current" autocomplete="current-password" />
      </a-form-item>

      <a-form-item
        label="新密码"
        :validate-status="passwordErrors.next ? 'error' : ''"
        :help="passwordErrors.next || '至少 12 位，需同时包含字母与数字'"
      >
        <a-input-password v-model:value="password.next" autocomplete="new-password" />
      </a-form-item>

      <a-form-item
        label="确认新密码"
        :validate-status="passwordErrors.confirm ? 'error' : ''"
        :help="passwordErrors.confirm"
      >
        <a-input-password v-model:value="password.confirm" autocomplete="new-password" />
      </a-form-item>

      <a-button type="primary" :loading="saving" @click="changePassword"> 更新密码 </a-button>
    </a-form>
  </div>
</template>
