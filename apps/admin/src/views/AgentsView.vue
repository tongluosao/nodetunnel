<script setup lang="ts">
import { message } from 'ant-design-vue';
import { computed, onMounted, ref } from 'vue';

import { api, ApiError, type AgentRecord, type Tunnel } from '@/api/client';
import { AGENT_ONLINE_WINDOW_SECONDS } from '@nodetunnel/shared';

/**
 * 主机端列表：展示所有凭接入令牌连上信令房间的主机端 agent。
 *
 * 在线判定使用与后端一致的窗口（AGENT_ONLINE_WINDOW_SECONDS）。
 * 该常量以「秒」为单位，转成毫秒才能与 lastSeen 比较 —— 单位写错会让
 * 在线/离线判断整体偏小三数量级，因此这里显式标注换算。
 */

const agents = ref<AgentRecord[]>([]);
const tunnels = ref<Tunnel[]>([]);
const loading = ref(false);
const now = ref(Date.now());

const onlineThresholdMs = AGENT_ONLINE_WINDOW_SECONDS * 1000;

function tunnelName(tunnelId: string): string {
  return tunnels.value.find((t) => t.id === tunnelId)?.name ?? '（隧道已删除）';
}

function isOnline(agent: AgentRecord): boolean {
  return now.value - agent.lastSeen < onlineThresholdMs;
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

const onlineCount = computed(() => agents.value.filter(isOnline).length);

async function load(): Promise<void> {
  loading.value = true;
  now.value = Date.now();
  try {
    const [agentResult, tunnelResult] = await Promise.all([api.agents.list(), api.tunnels.list()]);
    agents.value = agentResult.agents;
    tunnels.value = tunnelResult.tunnels;
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '加载主机端失败');
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
          主机端列表
          <span style="color: var(--nt-text-dim); font-weight: 400; font-size: 13px">
            （{{ onlineCount }} / {{ agents.length }} 在线）
          </span>
        </h2>
        <p class="nt-hint" style="margin: 4px 0 0">
          主机端凭接入令牌连上信令房间并定期上报心跳。超过
          {{ Math.round(AGENT_ONLINE_WINDOW_SECONDS / 60) }} 分钟未上报即视为离线。
        </p>
      </div>
      <a-button @click="load">刷新</a-button>
    </div>

    <a-table
      :data-source="agents"
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
      <a-table-column title="上报端口" :width="220">
        <template #default="{ record }">
          <template v-if="record.reportedPorts.length === 0">
            <span style="color: var(--nt-text-dim)">—</span>
          </template>
          <template v-else>
            <a-tag v-for="port in record.reportedPorts" :key="port" color="blue">
              {{ port }}
            </a-tag>
          </template>
        </template>
      </a-table-column>
      <a-table-column title="版本" :width="110">
        <template #default="{ record }">
          <span class="nt-mono">{{ record.version ?? '—' }}</span>
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
        <div class="nt-empty">
          还没有主机端接入。请在本机运行 nodetunnel-agent，并用隧道令牌完成接入。
        </div>
      </template>
    </a-table>
  </div>
</template>
