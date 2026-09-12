<script setup lang="ts">
import { message } from 'ant-design-vue';
import { computed, onMounted, ref } from 'vue';

import { api, ApiError, type NodeRecord, type Tunnel } from '@/api/client';
import { NODE_ONLINE_WINDOW_SECONDS } from '@nodetunnel/shared';

/**
 * 节点列表：展示所有通过配置服务器接入的 EasyTier 节点。
 *
 * 在线判定使用与后端一致的窗口（NODE_ONLINE_WINDOW_SECONDS），
 * 避免前后端对「在线」的理解出现偏差。
 */

const nodes = ref<NodeRecord[]>([]);
const tunnels = ref<Tunnel[]>([]);
const loading = ref(false);
const now = ref(Date.now());

const onlineThresholdMs = NODE_ONLINE_WINDOW_SECONDS * 1000;

function tunnelName(tunnelId: string | null): string {
  if (tunnelId === null) {
    return '未归属';
  }
  return tunnels.value.find((t) => t.id === tunnelId)?.name ?? '（隧道已删除）';
}

function isOnline(node: NodeRecord): boolean {
  return now.value - node.lastSeen < onlineThresholdMs;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor((now.value - ms) / 1000));
  if (seconds < 60) {
    return `${seconds} 秒前`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} 分钟前`;
  }
  return `${Math.floor(seconds / 3600)} 小时前`;
}

const onlineCount = computed(() => nodes.value.filter(isOnline).length);

async function load(): Promise<void> {
  loading.value = true;
  now.value = Date.now();
  try {
    const [nodeResult, tunnelResult] = await Promise.all([api.nodes.list(), api.tunnels.list()]);
    nodes.value = nodeResult.nodes;
    tunnels.value = tunnelResult.tunnels;
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '加载节点失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="nt-panel-card">
    <div class="nt-panel-card__head">
      <div>
        <h2 class="nt-panel-card__title">
          节点列表
          <span style="color: var(--nt-text-dim); font-weight: 400; font-size: 13px">
            （{{ onlineCount }} / {{ nodes.length }} 在线）
          </span>
        </h2>
        <p class="nt-hint" style="margin: 4px 0 0">
          节点通过配置服务器上报心跳。超过 {{ Math.round(NODE_ONLINE_WINDOW_SECONDS / 60) }}
          分钟未上报即视为离线。
        </p>
      </div>
      <a-button @click="load">刷新</a-button>
    </div>

    <a-table
      :data-source="nodes"
      :loading="loading"
      row-key="id"
      size="middle"
      :pagination="{ pageSize: 20 }"
    >
      <a-table-column title="状态" :width="90">
        <template #default="{ record }">
          <a-badge
            :status="isOnline(record) ? 'success' : 'default'"
            :text="isOnline(record) ? '在线' : '离线'"
          />
        </template>
      </a-table-column>
      <a-table-column title="主机名" :width="150">
        <template #default="{ record }">
          {{ record.hostname ?? '—' }}
        </template>
      </a-table-column>
      <a-table-column title="所属隧道" :width="150">
        <template #default="{ record }">{{ tunnelName(record.tunnelId) }}</template>
      </a-table-column>
      <a-table-column title="虚拟网 IP" :width="140">
        <template #default="{ record }">
          <span class="nt-mono">{{ record.ipv4 ?? '—' }}</span>
        </template>
      </a-table-column>
      <a-table-column title="EasyTier 版本" :width="130">
        <template #default="{ record }">
          <span class="nt-mono">{{ record.easytierVersion ?? '—' }}</span>
        </template>
      </a-table-column>
      <a-table-column title="实例 ID" :width="290">
        <template #default="{ record }">
          <span class="nt-mono">{{ record.instanceId }}</span>
        </template>
      </a-table-column>
      <a-table-column title="最后上报">
        <template #default="{ record }">
          <a-tooltip :title="formatTime(record.lastSeen)">
            {{ formatAgo(record.lastSeen) }}
          </a-tooltip>
        </template>
      </a-table-column>
      <template #emptyText>
        <div class="nt-empty">还没有节点接入。请在隧道节点上使用配置服务器地址完成接入。</div>
      </template>
    </a-table>
  </div>
</template>
