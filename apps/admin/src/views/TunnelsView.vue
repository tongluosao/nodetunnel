<script setup lang="ts">
import { message, Modal } from 'ant-design-vue';
import { onMounted, reactive, ref } from 'vue';

import { api, ApiError, type Tunnel, type TunnelPort } from '@/api/client';

/**
 * 隧道管理（需求 1.3 的管理入口）。
 *
 * 每个隧道对应一个 EasyTier 组网。这里的「暴露端口」直接决定
 * 下发配置中 ACL 的放行规则：未列出的端口一律拒绝入站。
 */

const tunnels = ref<Tunnel[]>([]);
const loading = ref(false);
const saving = ref(false);
const modalOpen = ref(false);
const editingId = ref<string | undefined>(undefined);

const configOpen = ref(false);
const configText = ref('');
const configLoading = ref(false);
const configTitle = ref('');

const form = reactive<{
  name: string;
  networkName: string;
  networkSecret: string;
  ports: TunnelPort[];
  enabled: boolean;
}>({
  name: '',
  networkName: '',
  networkSecret: '',
  ports: [],
  enabled: true,
});

/** 端口输入框的临时值（逗号分隔），提交时解析为端口数组。 */
const portsInput = ref('');

async function load(): Promise<void> {
  loading.value = true;
  try {
    tunnels.value = (await api.tunnels.list()).tunnels;
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '加载隧道失败');
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  editingId.value = undefined;
  form.name = '';
  form.networkName = '';
  form.networkSecret = '';
  form.ports = [];
  form.enabled = true;
  portsInput.value = '';
  modalOpen.value = true;
}

function openEdit(tunnel: Tunnel): void {
  editingId.value = tunnel.id;
  form.name = tunnel.name;
  form.networkName = tunnel.networkName;
  // 出于安全考虑，后端不回传明文组网密钥；留空表示不修改。
  form.networkSecret = '';
  form.ports = [...tunnel.ports];
  form.enabled = tunnel.enabled;
  portsInput.value = tunnel.ports
    .filter((p) => p.protocol === 'tcp')
    .map((p) => p.port)
    .join(', ');
  modalOpen.value = true;
}

/**
 * 解析端口输入。
 *
 * 只接受 TCP：浏览器侧通过 HTTP 访问，UDP 无法承载页面请求，
 * 因此管理界面不提供 UDP 放行入口，避免误开放攻击面。
 */
function parsePorts(): TunnelPort[] {
  const seen = new Set<number>();
  const result: TunnelPort[] = [];

  for (const piece of portsInput.value.split(',')) {
    const text = piece.trim();
    if (text === '') {
      continue;
    }
    const port = Number(text);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`端口「${text}」不是 1-65535 之间的整数`);
    }
    if (!seen.has(port)) {
      seen.add(port);
      result.push({ port, protocol: 'tcp' });
    }
  }

  return result.sort((a, b) => a.port - b.port);
}

async function submit(): Promise<void> {
  if (form.name.trim() === '') {
    message.warning('请填写隧道名称');
    return;
  }
  if (form.networkName.trim() === '') {
    message.warning('请填写组网名称');
    return;
  }
  if (editingId.value === undefined && form.networkSecret.trim() === '') {
    message.warning('请填写组网密钥');
    return;
  }

  let ports: TunnelPort[];
  try {
    ports = parsePorts();
  } catch (error) {
    message.error(error instanceof Error ? error.message : '端口格式不正确');
    return;
  }

  saving.value = true;
  try {
    if (editingId.value === undefined) {
      await api.tunnels.create({
        name: form.name.trim(),
        networkName: form.networkName.trim(),
        networkSecret: form.networkSecret.trim(),
        ports,
        enabled: form.enabled,
      });
      message.success('隧道已创建');
    } else {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        networkName: form.networkName.trim(),
        ports,
        enabled: form.enabled,
      };
      // 仅在填写了新密钥时才提交，避免把空值写入。
      if (form.networkSecret.trim() !== '') {
        payload.networkSecret = form.networkSecret.trim();
      }
      await api.tunnels.update(editingId.value, payload);
      message.success('隧道已更新');
    }
    modalOpen.value = false;
    await load();
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

function confirmRemove(tunnel: Tunnel): void {
  Modal.confirm({
    title: `确认删除隧道「${tunnel.name}」？`,
    content: '该隧道下的所有路由与端口白名单都会被一并删除，且不可恢复。',
    okText: '删除',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      try {
        await api.tunnels.remove(tunnel.id);
        message.success('隧道已删除');
        await load();
      } catch (error) {
        message.error(error instanceof ApiError ? error.message : '删除失败');
      }
    },
  });
}

async function showConfig(tunnel: Tunnel): Promise<void> {
  configTitle.value = `隧道「${tunnel.name}」的节点配置`;
  configOpen.value = true;
  configLoading.value = true;
  configText.value = '';
  try {
    configText.value = await api.tunnels.config(tunnel.id);
  } catch (error) {
    configText.value = `获取配置失败：${error instanceof ApiError ? error.message : '未知错误'}`;
  } finally {
    configLoading.value = false;
  }
}

async function copyConfig(): Promise<void> {
  try {
    await navigator.clipboard.writeText(configText.value);
    message.success('配置已复制到剪贴板');
  } catch {
    message.warning('复制失败，请手动选择文本复制');
  }
}

onMounted(load);
</script>

<template>
  <div class="nt-panel-card">
    <div class="nt-panel-card__head">
      <div>
        <h2 class="nt-panel-card__title">隧道列表</h2>
        <p class="nt-hint" style="margin: 4px 0 0">
          每个隧道是一个独立的 EasyTier 组网。只有此处列出的端口会被放行入站， 其余端口一律拒绝。
        </p>
      </div>
      <a-button type="primary" @click="openCreate">新建隧道</a-button>
    </div>

    <a-table
      :data-source="tunnels"
      :loading="loading"
      row-key="id"
      size="middle"
      :pagination="false"
    >
      <a-table-column title="名称" data-index="name" :width="160" />
      <a-table-column title="组网名" data-index="networkName" :width="160">
        <template #default="{ record }">
          <span class="nt-mono">{{ record.networkName }}</span>
        </template>
      </a-table-column>
      <a-table-column title="暴露端口" :width="200">
        <template #default="{ record }">
          <template v-if="record.ports.length === 0">
            <a-tag color="orange">未放行任何端口</a-tag>
          </template>
          <template v-else>
            <a-tag v-for="p in record.ports" :key="`${p.protocol}-${p.port}`" color="blue">
              {{ p.port }}/{{ p.protocol.toUpperCase() }}
            </a-tag>
          </template>
        </template>
      </a-table-column>
      <a-table-column title="状态" :width="90">
        <template #default="{ record }">
          <a-tag :color="record.enabled ? 'green' : 'default'">
            {{ record.enabled ? '启用' : '停用' }}
          </a-tag>
        </template>
      </a-table-column>
      <a-table-column title="操作" :width="220">
        <template #default="{ record }">
          <a-space size="small">
            <a-button size="small" @click="showConfig(record)">查看配置</a-button>
            <a-button size="small" @click="openEdit(record)">编辑</a-button>
            <a-button size="small" danger @click="confirmRemove(record)">删除</a-button>
          </a-space>
        </template>
      </a-table-column>
      <template #emptyText>
        <div class="nt-empty">还没有隧道，点击右上角「新建隧道」开始。</div>
      </template>
    </a-table>
  </div>

  <a-modal
    v-model:open="modalOpen"
    :title="editingId === undefined ? '新建隧道' : '编辑隧道'"
    :confirm-loading="saving"
    width="560px"
    ok-text="保存"
    cancel-text="取消"
    @ok="submit"
  >
    <a-form layout="vertical">
      <a-form-item label="隧道名称" help="用于在管理后台中识别，例如「家庭主机」">
        <a-input v-model:value="form.name" placeholder="家庭主机" />
      </a-form-item>

      <a-form-item
        label="组网名称"
        help="EasyTier 的 network_name。隧道节点与浏览器节点必须一致才能互通。"
      >
        <a-input v-model:value="form.networkName" placeholder="home-net" />
      </a-form-item>

      <a-form-item
        label="组网密钥"
        :help="
          editingId === undefined
            ? 'EasyTier 的 network_secret，至少 16 位。保存后不再回显。'
            : '留空表示不修改。填写新值将替换现有密钥。'
        "
      >
        <a-input-password
          v-model:value="form.networkSecret"
          :placeholder="editingId === undefined ? '至少 16 位' : '留空则不修改'"
        />
      </a-form-item>

      <a-form-item
        label="暴露端口（TCP）"
        help="逗号分隔，例如 80, 443, 8080。留空表示不放行任何入站端口。"
      >
        <a-input v-model:value="portsInput" placeholder="8080, 3000" />
      </a-form-item>

      <a-form-item label="启用">
        <a-switch v-model:checked="form.enabled" />
      </a-form-item>
    </a-form>
  </a-modal>

  <a-modal v-model:open="configOpen" :title="configTitle" width="720px" :footer="null">
    <p class="nt-hint">
      把下面的内容保存为隧道节点的 EasyTier 配置文件，或据此设置节点参数。
      其中包含明文组网密钥，请勿分享给无关人员。
    </p>
    <a-spin :spinning="configLoading">
      <pre class="nt-pre">{{ configText }}</pre>
    </a-spin>
    <div style="margin-top: 12px; text-align: right">
      <a-button type="primary" @click="copyConfig">复制配置</a-button>
    </div>
  </a-modal>
</template>
