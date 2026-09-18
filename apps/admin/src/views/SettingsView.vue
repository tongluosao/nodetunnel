<script setup lang="ts">
import { message } from 'ant-design-vue';
import { computed, onMounted, reactive, ref } from 'vue';

import { api, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { validatePassword, validateUsername } from '@nodetunnel/shared';

/**
 * 系统设置：接入信息、管理员账号与密码。
 *
 * 接入地址不再由前端拼接，而是取自 /system/endpoints —— 协议（ws/wss）
 * 与路径的判断只应有一处实现，前端自行推导很容易与实际部署产生分歧。
 */

const auth = useAuthStore();
const saving = ref(false);
const savingUsername = ref(false);
const endpointsLoading = ref(false);
const agentUrl = ref('');
const signalingUrl = ref('');

const password = reactive({ next: '', confirm: '' });
const passwordErrors = reactive({ next: '', confirm: '' });

const usernameForm = reactive({ value: '' });
const usernameError = ref('');

// 进页面时用当前账号填充，避免用户以为要重新输入。
usernameForm.value = auth.admin?.username ?? '';

/**
 * agent 的 --server 参数要的是 HTTP(S) 地址，而接入地址是 WebSocket 地址。
 * 这里只做协议替换，host 与路径保持服务端给的值，避免出现两套来源。
 */
const agentServerOrigin = computed(() => {
  if (agentUrl.value === '') {
    return '';
  }
  return agentUrl.value
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:')
    .replace(/\/agent$/, '');
});

const agentCommand = computed(
  () =>
    `nodetunnel-agent --server ${agentServerOrigin.value || '<Worker 地址>'} --token <接入令牌> --ports 8080`,
);

async function loadEndpoints(): Promise<void> {
  endpointsLoading.value = true;
  try {
    const result = await api.system.endpoints();
    agentUrl.value = result.agentUrl;
    signalingUrl.value = result.signalingUrl;
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '加载接入地址失败');
  } finally {
    endpointsLoading.value = false;
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
  passwordErrors.next = '';
  passwordErrors.confirm = '';

  const next = validatePassword(password.next);
  if (!next.ok) {
    passwordErrors.next = next.message;
  }

  if (password.confirm !== password.next) {
    passwordErrors.confirm = '两次输入的新密码不一致';
  }

  return passwordErrors.next === '' && passwordErrors.confirm === '';
}

async function changePassword(): Promise<void> {
  if (!validatePasswordForm()) {
    return;
  }

  saving.value = true;
  try {
    // 服务端不再要求当前密码：会话本身已经是身份凭证。
    await api.auth.changePassword(password.next);
    message.success('密码已更新');
    password.next = '';
    password.confirm = '';
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '修改密码失败');
  } finally {
    saving.value = false;
  }
}

async function changeUsername(): Promise<void> {
  usernameError.value = '';
  const value = usernameForm.value.trim();

  const validated = validateUsername(value);
  if (!validated.ok) {
    usernameError.value = validated.message;
    return;
  }
  if (value === auth.admin?.username) {
    message.info('用户名未发生变化');
    return;
  }

  savingUsername.value = true;
  try {
    const result = await api.auth.changeUsername(value);
    // 服务端已重签会话，这里同步本地状态，顶栏立即显示新名字。
    auth.setUsername(result.admin.username);
    usernameForm.value = result.admin.username;
    message.success('用户名已更新');
  } catch (error) {
    const text = error instanceof ApiError ? error.message : '修改用户名失败';
    usernameError.value = text;
    message.error(text);
  } finally {
    savingUsername.value = false;
  }
}

onMounted(loadEndpoints);
</script>

<template>
  <div class="nt-panel-card">
    <div class="nt-panel-card__head">
      <div>
        <h2 class="nt-panel-card__title">接入信息</h2>
        <p class="nt-hint" style="margin: 4px 0 0">
          以下地址由服务端按当前部署域名推导。主机端 agent 使用接入地址，
          浏览器门户使用信令地址，两者共用同一个 Worker。
        </p>
      </div>
      <a-button size="small" :loading="endpointsLoading" @click="loadEndpoints">刷新</a-button>
    </div>

    <a-descriptions :column="1" size="small" bordered>
      <a-descriptions-item label="主机端接入地址">
        <div style="display: flex; align-items: center; gap: 10px">
          <span class="nt-mono">{{ agentUrl || '—' }}</span>
          <a-button size="small" :disabled="agentUrl === ''" @click="copy(agentUrl, '接入地址')">
            复制
          </a-button>
        </div>
      </a-descriptions-item>

      <a-descriptions-item label="浏览器信令地址">
        <div style="display: flex; align-items: center; gap: 10px">
          <span class="nt-mono">{{ signalingUrl || '—' }}</span>
          <a-button
            size="small"
            :disabled="signalingUrl === ''"
            @click="copy(signalingUrl, '信令地址')"
          >
            复制
          </a-button>
        </div>
      </a-descriptions-item>

      <a-descriptions-item label="隧道访问方式">
        <span>专属域名（在「路由管理」中为每条路由填写完整域名）</span>
      </a-descriptions-item>

      <a-descriptions-item label="服务版本">
        <span class="nt-mono">{{ auth.version || '—' }}</span>
      </a-descriptions-item>
    </a-descriptions>

    <h3 class="nt-panel-card__title" style="margin-top: 22px; font-size: 14px">启动主机端</h3>
    <p class="nt-hint">
      在需要暴露服务的主机上运行以下命令。令牌在「隧道管理」创建或轮换隧道时显示一次， 请粘贴到
      <code class="nt-mono">&lt;接入令牌&gt;</code> 处；
      <code class="nt-mono">--ports</code> 填本机允许放行的端口。
    </p>
    <pre class="nt-pre">{{ agentCommand }}</pre>
    <div style="margin-top: 12px; text-align: right">
      <a-button @click="copy(agentCommand, '启动命令')">复制命令</a-button>
    </div>
  </div>

  <div class="nt-panel-card">
    <h2 class="nt-panel-card__title">管理员账号</h2>
    <p class="nt-hint">用户名用于登录与界面展示。修改后服务端会重签当前会话，无需重新登录。</p>

    <a-form layout="vertical" style="max-width: 420px">
      <a-form-item
        label="用户名"
        :validate-status="usernameError ? 'error' : ''"
        :help="usernameError || '3–32 位，可含字母、数字、下划线、短横线与点'"
      >
        <a-input v-model:value="usernameForm.value" autocomplete="username" />
      </a-form-item>

      <a-button type="primary" :loading="savingUsername" @click="changeUsername">
        更新用户名
      </a-button>
    </a-form>
  </div>

  <div class="nt-panel-card">
    <h2 class="nt-panel-card__title">修改密码</h2>
    <p class="nt-hint">
      修改后当前会话仍有效。这里不需要输入当前密码 —— 能打开本页面即已持有有效会话，
      会话本身就是身份凭证。
    </p>

    <a-form layout="vertical" style="max-width: 420px">
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
