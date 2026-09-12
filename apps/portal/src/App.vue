<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

import { PortalNode, type PortalNodeStatus } from '@/easytier/portal-node';
import { requestOverTunnel } from '@/easytier/tunnel-http';

/**
 * NodeTunnel 浏览器门户（需求 3）。
 *
 * 流程：
 *   1. 用户在浏览器内启动一个 EasyTier 节点，加入目标隧道所在的虚拟网；
 *   2. 节点只发起连接、禁止一切入站，符合后端的 ACL 渲染；
 *   3. 之后便可在页面中直接访问隧道内被放行的服务。
 *
 * 访问路径有两条：
 *   - 经 Worker 中继：/t/<slug>/（无需本页节点，由 Worker 转发）；
 *   - 直连隧道内服务：本页节点加入虚拟网后直接连接目标 IP:端口。
 */

const node = new PortalNode();

const status = ref<PortalNodeStatus>({ state: 'idle', connections: 0, events: [] });
const starting = ref(false);
const stopping = ref(false);

const config = reactive({
  networkName: '',
  networkSecret: '',
  relayUrl: '',
  ipv4: '',
});

const query = reactive({ host: '', port: 80, path: '/' });
const querying = ref(false);
const queryResult = ref('');
const queryError = ref('');

let unsubscribe: (() => void) | undefined;

/** 由当前页面地址推导默认中继地址。 */
function deriveRelayUrl(networkName: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${protocol}//${window.location.host}/relay`;
  return networkName === '' ? base : `${base}?network=${encodeURIComponent(networkName)}`;
}

const stateLabel = computed(() => {
  switch (status.value.state) {
    case 'idle':
      return '未启动';
    case 'starting':
      return '启动中';
    case 'running':
      return '运行中';
    case 'stopped':
      return '已停止';
    case 'error':
      return '出错';
    default:
      return status.value.state;
  }
});

const stateColor = computed(() => {
  switch (status.value.state) {
    case 'running':
      return '#23b26d';
    case 'starting':
      return '#e0a020';
    case 'error':
      return '#e04b4b';
    default:
      return '#8b96ad';
  }
});

/** 组网名变化时同步更新中继地址，减少手工输入。 */
function syncRelayUrl(): void {
  config.relayUrl = deriveRelayUrl(config.networkName.trim());
}

async function start(): Promise<void> {
  if (config.networkName.trim() === '' || config.networkSecret.trim() === '') {
    queryError.value = '请填写组网名与组网密钥';
    return;
  }
  if (config.ipv4.trim() === '') {
    queryError.value = '请填写本节点在虚拟网中的 IPv4 地址（需与网内其他节点同网段且不冲突）';
    return;
  }

  starting.value = true;
  queryError.value = '';
  try {
    if (config.relayUrl.trim() === '') {
      syncRelayUrl();
    }
    await node.start({
      networkName: config.networkName.trim(),
      networkSecret: config.networkSecret.trim(),
      relayUrl: config.relayUrl.trim(),
      ipv4: config.ipv4.trim(),
    });
  } catch (error) {
    queryError.value = error instanceof Error ? error.message : String(error);
  } finally {
    starting.value = false;
  }
}

async function stop(): Promise<void> {
  stopping.value = true;
  try {
    await node.stop();
  } finally {
    stopping.value = false;
  }
}

async function sendRequest(): Promise<void> {
  queryError.value = '';
  queryResult.value = '';

  if (!node.running) {
    queryError.value = '浏览器节点尚未运行，请先启动节点';
    return;
  }
  if (query.host.trim() === '') {
    queryError.value = '请填写目标主机（虚拟网 IP）';
    return;
  }

  querying.value = true;
  try {
    const stream = await node.connectTcp(query.host.trim(), query.port);
    const response = await requestOverTunnel(stream, {
      method: 'GET',
      path: query.path.trim() === '' ? '/' : query.path.trim(),
      hostHeader: `${query.host.trim()}:${query.port}`,
      headers: { Accept: 'text/html,application/json,text/plain,*/*' },
    });

    const contentType = response.headers['content-type'] ?? '';
    const text = new TextDecoder('utf-8').decode(response.body);
    queryResult.value = `HTTP ${response.status} ${response.statusText}\nContent-Type: ${contentType || '（未声明）'}\n\n${text.slice(0, 4000)}`;
  } catch (error) {
    queryError.value = error instanceof Error ? error.message : String(error);
  } finally {
    querying.value = false;
  }
}

async function refreshStatus(): Promise<void> {
  await node.refresh();
}

onMounted(() => {
  unsubscribe = node.subscribe((next) => {
    status.value = next;
  });
  syncRelayUrl();
});

onBeforeUnmount(() => {
  unsubscribe?.();
  // 离开页面时释放虚拟网连接，避免残留节点占用地址。
  void node.stop();
});
</script>

<template>
  <div class="page">
    <header class="header">
      <h1>NodeTunnel 门户</h1>
      <p class="subtitle">
        在浏览器内运行 EasyTier 节点，加入隧道所在的虚拟局域网并直连网内服务。
        节点不监听任何端口，仅发起连接。
      </p>
    </header>

    <section class="card">
      <div class="card-head">
        <h2>1. 浏览器节点</h2>
        <span class="badge" :style="{ color: stateColor, borderColor: stateColor }">
          {{ stateLabel }}
        </span>
      </div>

      <div class="grid">
        <label>
          <span>组网名称</span>
          <input
            v-model="config.networkName"
            placeholder="与隧道一致，如 home-net"
            @blur="syncRelayUrl"
          />
        </label>

        <label>
          <span>组网密钥</span>
          <input v-model="config.networkSecret" type="password" placeholder="与隧道一致" />
        </label>

        <label>
          <span>本节点虚拟 IP</span>
          <input v-model="config.ipv4" placeholder="如 10.144.144.10" />
        </label>

        <label class="wide">
          <span>中继地址</span>
          <input v-model="config.relayUrl" placeholder="wss://<域名>/relay?network=<组网名>" />
        </label>
      </div>

      <div class="actions">
        <button
          class="primary"
          :disabled="starting || status.state === 'running' || status.state === 'starting'"
          @click="start"
        >
          {{ starting ? '启动中…' : '启动节点' }}
        </button>
        <button :disabled="stopping || status.state !== 'running'" @click="stop">
          {{ stopping ? '停止中…' : '停止节点' }}
        </button>
        <button :disabled="status.state !== 'running'" @click="refreshStatus">刷新状态</button>
        <span class="muted">当前连接数：{{ status.connections }}</span>
      </div>

      <p v-if="status.error" class="error">{{ status.error }}</p>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>2. 访问隧道内服务</h2>
      </div>
      <p class="hint">
        填写隧道节点的虚拟网 IP 与已放行的端口。请求经虚拟网直接发送， 不经过 Worker 转发。
      </p>

      <div class="grid">
        <label>
          <span>目标主机</span>
          <input v-model="query.host" placeholder="如 10.144.144.1" />
        </label>
        <label>
          <span>端口</span>
          <input v-model.number="query.port" type="number" min="1" max="65535" />
        </label>
        <label class="wide">
          <span>路径</span>
          <input v-model="query.path" placeholder="/" />
        </label>
      </div>

      <div class="actions">
        <button class="primary" :disabled="querying || !node.running" @click="sendRequest">
          {{ querying ? '请求中…' : '发送请求' }}
        </button>
      </div>

      <p v-if="queryError" class="error">{{ queryError }}</p>
      <pre v-if="queryResult" class="result">{{ queryResult }}</pre>
    </section>

    <section v-if="status.events.length > 0" class="card">
      <div class="card-head">
        <h2>事件日志</h2>
      </div>
      <pre class="result log">{{
        status.events
          .slice(-30)
          .map((e) => `[${e.kind}] ${e.message}`)
          .join('\n')
      }}</pre>
    </section>
  </div>
</template>
