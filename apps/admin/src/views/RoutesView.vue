<script setup lang="ts">
import { message, Modal } from 'ant-design-vue';
import { computed, onMounted, reactive, ref } from 'vue';

import { api, ApiError, type Route, type Tunnel } from '@/api/client';

/**
 * 路由管理。
 *
 * 访问入口只有「专属域名」一种：该域名整站交给这条路由，应用跑在根路径上，
 * 因此它发出的绝对路径（/js/app.js、/api/xxx）与浏览器实际请求的路径一致，
 * 无需改任何应用代码即可接入。
 *
 * slug 仍保留，但它只是路由的稳定标识（同时用于 `<slug>.localhost` 这个
 * 本地免配 DNS 的约定），不再是访问路径。
 */

const routes = ref<Route[]>([]);
const tunnels = ref<Tunnel[]>([]);
const loading = ref(false);
const saving = ref(false);
const modalOpen = ref(false);
const editingId = ref<string | undefined>(undefined);

const form = reactive({
  slug: '',
  tunnelId: '',
  targetHost: '',
  targetPort: 80,
  hostname: '',
  enabled: true,
});

const tunnelOptions = computed(() => tunnels.value.map((t) => ({ label: t.name, value: t.id })));

function tunnelName(tunnelId: string): string {
  return tunnels.value.find((t) => t.id === tunnelId)?.name ?? '（隧道已删除）';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [routeResult, tunnelResult] = await Promise.all([api.routes.list(), api.tunnels.list()]);
    routes.value = routeResult.routes;
    tunnels.value = tunnelResult.tunnels;
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '加载路由失败');
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  editingId.value = undefined;
  form.slug = '';
  form.tunnelId = tunnels.value[0]?.id ?? '';
  form.targetHost = '';
  form.targetPort = 80;
  form.hostname = '';
  form.enabled = true;
  modalOpen.value = true;
}

function openEdit(route: Route): void {
  editingId.value = route.id;
  form.slug = route.slug;
  form.tunnelId = route.tunnelId;
  form.targetHost = route.targetHost;
  form.targetPort = route.targetPort;
  form.hostname = route.hostname ?? '';
  form.enabled = route.enabled;
  modalOpen.value = true;
}

async function submit(): Promise<void> {
  if (form.slug.trim() === '') {
    message.warning('请填写路由标识');
    return;
  }
  if (form.tunnelId === '') {
    message.warning('请先创建并选择一个隧道');
    return;
  }
  if (form.targetHost.trim() === '') {
    message.warning('请填写目标主机');
    return;
  }
  if (form.hostname.trim() === '') {
    // 没有域名就没有访问入口，放过去只会得到一条「配了但打不开」的路由。
    message.warning('请填写完整域名，否则该路由没有任何访问入口');
    return;
  }

  const hostname = form.hostname.trim();

  saving.value = true;
  try {
    if (editingId.value === undefined) {
      await api.routes.create({
        slug: form.slug.trim(),
        tunnelId: form.tunnelId,
        targetHost: form.targetHost.trim(),
        targetPort: form.targetPort,
        hostname,
        enabled: form.enabled,
      });
      message.success('路由已创建');
    } else {
      await api.routes.update(editingId.value, {
        slug: form.slug.trim(),
        tunnelId: form.tunnelId,
        targetHost: form.targetHost.trim(),
        targetPort: form.targetPort,
        hostname,
        enabled: form.enabled,
      });
      message.success('路由已更新');
    }
    modalOpen.value = false;
    await load();
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

function confirmRemove(route: Route): void {
  Modal.confirm({
    title: `确认删除路由「${route.slug}」？`,
    okText: '删除',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      try {
        await api.routes.remove(route.id);
        message.success('路由已删除');
        await load();
      } catch (error) {
        message.error(error instanceof ApiError ? error.message : '删除失败');
      }
    },
  });
}

/**
 * 专属域名下的访问地址。
 *
 * 端口沿用管理后台当前的端口，仅本地开发有意义；真实部署时域名走 443，
 * 因此这里只作为「在本地验证」的提示。
 */
function hostAccessUrl(hostname: string): string {
  const port = window.location.port === '' ? '' : `:${window.location.port}`;
  return `${window.location.protocol}//${hostname}${port}/`;
}

onMounted(load);
</script>

<template>
  <div class="nt-panel-card">
    <div class="nt-panel-card__head">
      <div>
        <h2 class="nt-panel-card__title">路由列表</h2>
        <p class="nt-hint" style="margin: 4px 0 0">
          每条路由绑定一个完整域名，访问该域名即打开对应的本机服务。
          目标主机必须是主机端所在的内网/回环地址，填写公网地址会被服务端拒绝。
        </p>
      </div>
      <a-button type="primary" :disabled="tunnels.length === 0" @click="openCreate">
        新建路由
      </a-button>
    </div>

    <a-alert
      v-if="tunnels.length === 0"
      type="info"
      show-icon
      message="请先在「隧道管理」中创建隧道，之后才能添加路由。"
      style="margin-bottom: 16px"
    />

    <a-table
      :data-source="routes"
      :loading="loading"
      row-key="id"
      size="middle"
      :pagination="false"
    >
      <a-table-column title="专属域名" :width="240">
        <template #default="{ record }">
          <template v-if="record.hostname">
            <a
              :href="hostAccessUrl(record.hostname)"
              target="_blank"
              rel="noreferrer"
              class="nt-mono"
            >
              {{ record.hostname }}
            </a>
          </template>
          <template v-else>
            <a-tag color="red">未设置（无法访问）</a-tag>
          </template>
        </template>
      </a-table-column>
      <a-table-column title="路由标识" :width="150">
        <template #default="{ record }">
          <span class="nt-mono">{{ record.slug }}</span>
        </template>
      </a-table-column>
      <a-table-column title="所属隧道" :width="170">
        <template #default="{ record }">{{ tunnelName(record.tunnelId) }}</template>
      </a-table-column>
      <a-table-column title="目标服务" :width="180">
        <template #default="{ record }">
          <span class="nt-mono">{{ record.targetHost }}:{{ record.targetPort }}</span>
        </template>
      </a-table-column>
      <a-table-column title="状态" :width="90">
        <template #default="{ record }">
          <a-tag :color="record.enabled ? 'green' : 'default'">
            {{ record.enabled ? '启用' : '停用' }}
          </a-tag>
        </template>
      </a-table-column>
      <a-table-column title="操作" :width="160">
        <template #default="{ record }">
          <a-space size="small">
            <a-button size="small" @click="openEdit(record)">编辑</a-button>
            <a-button size="small" danger @click="confirmRemove(record)">删除</a-button>
          </a-space>
        </template>
      </a-table-column>
      <template #emptyText>
        <div class="nt-empty">还没有路由。</div>
      </template>
    </a-table>
  </div>

  <a-modal
    v-model:open="modalOpen"
    :title="editingId === undefined ? '新建路由' : '编辑路由'"
    :confirm-loading="saving"
    width="560px"
    ok-text="保存"
    cancel-text="取消"
    @ok="submit"
  >
    <a-form layout="vertical">
      <a-form-item
        label="专属域名"
        help="填写完整域名，例如 project1.example.com。该域名必须已指向本 Worker；访问它即打开这条路由对应的服务。"
      >
        <a-input v-model:value="form.hostname" placeholder="project1.example.com" />
      </a-form-item>

      <a-form-item
        label="路由标识"
        help="仅作为路由的内部标识，同时提供 <标识>.localhost 这一本地免配 DNS 的访问方式，不再是访问路径。"
      >
        <a-input v-model:value="form.slug" placeholder="my-app" />
      </a-form-item>

      <a-form-item label="所属隧道">
        <a-select v-model:value="form.tunnelId" :options="tunnelOptions" placeholder="请选择隧道" />
      </a-form-item>

      <a-form-item
        label="目标主机"
        help="主机端本机可达的地址，例如 127.0.0.1 或内网地址。填写公网地址会被拒绝。"
      >
        <a-input v-model:value="form.targetHost" placeholder="127.0.0.1" />
      </a-form-item>

      <a-form-item label="目标端口" help="目标服务监听的端口，需在隧道中被放行。">
        <a-input-number v-model:value="form.targetPort" :min="1" :max="65535" style="width: 100%" />
      </a-form-item>

      <a-form-item label="启用">
        <a-switch v-model:checked="form.enabled" />
      </a-form-item>
    </a-form>
  </a-modal>
</template>
