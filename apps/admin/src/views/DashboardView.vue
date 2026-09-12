<script setup lang="ts">
import { message } from 'ant-design-vue';
import { onMounted, ref } from 'vue';

import { api, ApiError, type DashboardStats } from '@/api/client';

/**
 * 仪表盘：整体运行概览。
 *
 * 统计数字来自 /dashboard；中继状态单独探测，
 * 因为中继运行在 Durable Object 内，需要实际唤醒才能获知状态。
 */

const stats = ref<DashboardStats | undefined>(undefined);
const loading = ref(true);
const relayState = ref('unknown');
const relayConnections = ref(0);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [dashboard, health] = await Promise.all([
      api.dashboard(),
      // 中继探测失败不影响仪表盘其余数据，降级为「未知状态」。
      api.system.relayHealth().catch(() => ({ ok: false, state: 'unreachable', connections: 0 })),
    ]);
    stats.value = dashboard;
    relayState.value = health.state ?? (health.ok ? 'running' : 'stopped');
    relayConnections.value = health.connections ?? 0;
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '加载仪表盘失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <a-spin :spinning="loading">
    <div class="nt-stats">
      <div class="nt-stat">
        <div class="nt-stat__label">隧道总数</div>
        <div class="nt-stat__value">{{ stats?.tunnelCount ?? 0 }}</div>
      </div>
      <div class="nt-stat">
        <div class="nt-stat__label">路由总数</div>
        <div class="nt-stat__value">{{ stats?.routeCount ?? 0 }}</div>
      </div>
      <div class="nt-stat">
        <div class="nt-stat__label">已接入节点</div>
        <div class="nt-stat__value">{{ stats?.nodeCount ?? 0 }}</div>
      </div>
      <div class="nt-stat">
        <div class="nt-stat__label">在线节点</div>
        <div class="nt-stat__value">{{ stats?.onlineNodeCount ?? 0 }}</div>
      </div>
      <div class="nt-stat">
        <div class="nt-stat__label">中继连接数</div>
        <div class="nt-stat__value">{{ relayConnections }}</div>
      </div>
    </div>

    <div class="nt-panel-card">
      <div class="nt-panel-card__head">
        <h2 class="nt-panel-card__title">中继状态</h2>
        <a-button size="small" @click="load">刷新</a-button>
      </div>
      <p class="nt-hint">
        中继运行在 Durable Object 内，承载所有隧道节点的 WebSocket 接入与流量转发。
      </p>
      <a-descriptions :column="2" size="small">
        <a-descriptions-item label="运行状态">
          <a-tag :color="relayState === 'running' ? 'green' : 'red'">
            {{ relayState === 'running' ? '运行中' : relayState }}
          </a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="当前连接数">
          {{ relayConnections }}
        </a-descriptions-item>
      </a-descriptions>
    </div>

    <div class="nt-panel-card">
      <h2 class="nt-panel-card__title">快速上手</h2>
      <p class="nt-hint">
        先在「隧道管理」创建一个组网并声明需要暴露的端口，再到「路由管理」把
        <code class="nt-mono">/t/&lt;slug&gt;</code> 指向隧道内的服务。
      </p>
      <ol class="nt-hint" style="padding-left: 18px">
        <li>创建隧道：填写组网名与组网密钥，并选择要放行的端口。</li>
        <li>创建路由：填写访问路径与隧道内的目标主机、端口。</li>
        <li>在「隧道管理」打开配置，复制下发给隧道节点的 EasyTier 配置。</li>
        <li>在「节点列表」确认节点已接入。</li>
      </ol>
    </div>
  </a-spin>
</template>
