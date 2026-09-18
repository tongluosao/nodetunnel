<script setup lang="ts">
import { message } from 'ant-design-vue';
import { onMounted, ref } from 'vue';

import { api, ApiError, type DashboardStats } from '@/api/client';

/**
 * 仪表盘：整体运行概览。
 *
 * 所有统计数字都来自 /dashboard，不再单独探测中继 ——
 * 中继已不是独立概念，活跃连接数由信令房间统计后一并给出。
 */

const stats = ref<DashboardStats | undefined>(undefined);
const loading = ref(true);

async function load(): Promise<void> {
  loading.value = true;
  try {
    stats.value = await api.dashboard();
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
        <div class="nt-stat__label">已接入主机端</div>
        <div class="nt-stat__value">{{ stats?.agentCount ?? 0 }}</div>
      </div>
      <div class="nt-stat">
        <div class="nt-stat__label">在线主机端</div>
        <div class="nt-stat__value">{{ stats?.onlineAgentCount ?? 0 }}</div>
      </div>
      <div class="nt-stat">
        <div class="nt-stat__label">活跃连接数</div>
        <div class="nt-stat__value">{{ stats?.activeConnections ?? 0 }}</div>
      </div>
    </div>

    <div class="nt-panel-card">
      <div class="nt-panel-card__head">
        <h2 class="nt-panel-card__title">运行概览</h2>
        <a-button size="small" @click="load">刷新</a-button>
      </div>
      <p class="nt-hint">
        主机端 agent 凭接入令牌连上信令房间并定期上报心跳，在线判定窗口与后端一致。
      </p>
      <a-descriptions :column="2" size="small">
        <a-descriptions-item label="在线主机端">
          {{ stats?.onlineAgentCount ?? 0 }} / {{ stats?.agentCount ?? 0 }}
        </a-descriptions-item>
        <a-descriptions-item label="活跃连接数">
          {{ stats?.activeConnections ?? 0 }}
        </a-descriptions-item>
      </a-descriptions>
    </div>

    <div class="nt-panel-card">
      <h2 class="nt-panel-card__title">快速上手</h2>
      <p class="nt-hint">
        先在「隧道管理」创建隧道并声明需要暴露的端口，再到「路由管理」给每条路由绑定一个完整域名，
        访问该域名即打开主机上的服务。
      </p>
      <ol class="nt-hint" style="padding-left: 18px">
        <li>创建隧道：填写名称与要放行的端口；创建后立即复制一次性显示的接入令牌。</li>
        <li>在目标主机上运行 nodetunnel-agent，用该令牌与「系统设置」中的接入地址完成接入。</li>
        <li>创建路由：填写完整域名，以及主机上的目标地址与端口。</li>
        <li>在「主机端」列表确认 agent 已上线，然后访问该域名。</li>
      </ol>
    </div>
  </a-spin>
</template>
