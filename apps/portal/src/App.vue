<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

import { resolveSlugFromLocation } from '@/slug.js';
import { TunnelClient, type TunnelClientStatus } from '@/tunnel-client.js';

/**
 * NodeTunnel 浏览器门户。
 *
 * 用户在页面里填「路由 slug + 目标端口 + 路径」，门户就会：
 *   1. 连上 Worker 的信令房间；
 *   2. 尝试用 WebRTC 与主机端 P2P 直连（原生 ICE 打洞）；
 *   3. 打不通就自动回落到中继 —— 这是设计内的常态路径。
 *
 * 页面上会把当前走的是哪条路显示出来，方便判断打洞是否成功。
 * 无论走哪条路，端口白名单都由服务端与主机端各自校验，
 * 前端无法绕过。
 */

const client = ref<TunnelClient | null>(null);
const status = ref<TunnelClientStatus>({
  signalingReady: false,
  mode: null,
  peerState: null,
  message: '未连接',
});

const form = reactive({
  /** 路由 slug：对应管理后台里配置的 /t/<slug>/。 */
  slug: '',
  targetPort: 8080,
  method: 'GET',
  path: '/',
});

const sending = ref(false);
const response = ref('');
const error = ref('');
const events = ref<string[]>([]);

/** 当前传输方式的显示文案。 */
const modeLabel = computed(() => {
  switch (status.value.mode) {
    case 'p2p':
      return 'P2P 直连';
    case 'relay':
      return '中继';
    default:
      return '未建立';
  }
});

const modeColor = computed(() => {
  switch (status.value.mode) {
    case 'p2p':
      return '#23b26d';
    case 'relay':
      return '#e0a020';
    default:
      return '#8b96ad';
  }
});

function recordEvent(message: string): void {
  const stamp = new Date().toLocaleTimeString();
  events.value = [...events.value.slice(-49), `[${stamp}] ${message}`];
}

onMounted(() => {
  // 从 URL 自动识别 slug，减少手工输入。
  const slug = resolveSlugFromLocation(window.location.pathname, window.location.search);
  if (slug !== undefined) {
    form.slug = slug;
    recordEvent(`已从地址栏识别到路由 ${slug}`);
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const signalingUrl = `${protocol}//${window.location.host}/signal`;

  client.value = new TunnelClient({
    signalingUrl,
    slug: form.slug,
    onStatus: (next) => {
      status.value = next;
      recordEvent(next.message);
    },
  });
  recordEvent(`信令地址：${signalingUrl}`);
});

onBeforeUnmount(() => {
  client.value?.dispose();
});

async function send(): Promise<void> {
  error.value = '';
  response.value = '';

  const slug = form.slug.trim().toLowerCase();
  if (slug === '') {
    error.value = '请填写路由 slug（管理后台中配置的路径前缀）';
    return;
  }

  const instance = client.value;
  if (instance === null) {
    error.value = '客户端尚未初始化';
    return;
  }

  sending.value = true;
  try {
    const result = await instance.request({
      method: form.method.toUpperCase(),
      path: form.path.trim() === '' ? '/' : form.path.trim(),
      targetPort: Number(form.targetPort),
    });

    const headerLines = Object.entries(result.headers).map(([name, value]) => `${name}: ${value}`);
    const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(result.body);
    response.value = [
      `HTTP ${result.status} ${result.statusText}`,
      ...headerLines,
      '',
      bodyText,
    ].join('\n');

    recordEvent(`请求完成：HTTP ${result.status}（${modeLabel.value}）`);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
    recordEvent(`请求失败：${error.value}`);
  } finally {
    sending.value = false;
  }
}

function reset(): void {
  client.value?.dispose();
  client.value = null;
  response.value = '';
  error.value = '';

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  client.value = new TunnelClient({
    signalingUrl: `${protocol}//${window.location.host}/signal`,
    slug: form.slug.trim().toLowerCase(),
    onStatus: (next) => {
      status.value = next;
      recordEvent(next.message);
    },
  });
  recordEvent('已重置连接');
}
</script>

<template>
  <div class="page">
    <header class="header">
      <h1>NodeTunnel 门户</h1>
      <p class="subtitle">
        用 WebRTC 直连主机端；打洞失败时自动回落到中继。两条路都只放行白名单端口。
      </p>
    </header>

    <section class="card">
      <div class="card-head">
        <h2>连接状态</h2>
        <span class="badge" :style="{ color: modeColor }">{{ modeLabel }}</span>
      </div>

      <div class="stats">
        <div class="stat">
          <span class="stat-label">信令</span>
          <span :class="['stat-value', status.signalingReady ? 'ok' : 'dim']">
            {{ status.signalingReady ? '已连接' : '未连接' }}
          </span>
        </div>
        <div class="stat">
          <span class="stat-label">传输方式</span>
          <span class="stat-value" :style="{ color: modeColor }">{{ modeLabel }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">P2P 状态</span>
          <span class="stat-value dim">{{ status.peerState ?? '—' }}</span>
        </div>
      </div>

      <p class="hint">
        说明：本机网络若为对称 NAT，打洞通常无法成功，请求会经中继完成。这是预期行为。
      </p>

      <div class="actions">
        <button @click="reset">重置连接</button>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>发起请求</h2>
      </div>

      <div class="grid">
        <label>
          <span>路由 slug</span>
          <input v-model="form.slug" placeholder="my-app" />
        </label>
        <label>
          <span>目标端口</span>
          <input v-model.number="form.targetPort" type="number" min="1" max="65535" />
        </label>
        <label>
          <span>方法</span>
          <input v-model="form.method" placeholder="GET" />
        </label>
        <label>
          <span>路径</span>
          <input v-model="form.path" placeholder="/" />
        </label>
      </div>

      <div class="actions">
        <button class="primary" :disabled="sending" @click="send">
          {{ sending ? '请求中…' : '发送请求' }}
        </button>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
      <pre v-if="response" class="result">{{ response }}</pre>
    </section>

    <section v-if="events.length > 0" class="card">
      <div class="card-head">
        <h2>事件日志</h2>
      </div>
      <pre class="result log">{{ events.join('\n') }}</pre>
    </section>
  </div>
</template>
