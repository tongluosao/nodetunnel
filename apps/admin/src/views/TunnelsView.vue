<script setup lang="ts">
import { message, Modal } from 'ant-design-vue';
import { onMounted, reactive, ref } from 'vue';

import { api, ApiError, type PortProtocol, type Tunnel, type TunnelPort } from '@/api/client';

/**
 * 隧道管理。
 *
 * 隧道现在只表示「一台主机端的接入登记」：服务端签发接入令牌，主机端凭令牌
 * 连上信令房间，端口白名单决定本机哪些端口允许被转发。
 *
 * 令牌是唯一凭据且服务端只存哈希，所以创建/轮换后必须立刻把明文交给管理员 ——
 * 弹窗一旦关闭，谁也无法再取回，只能重新轮换（旧令牌同时立即失效）。
 */

const tunnels = ref<Tunnel[]>([]);
const loading = ref(false);
const saving = ref(false);
const modalOpen = ref(false);
const editingId = ref<string | undefined>(undefined);

/** 一次性明文令牌弹窗。 */
const tokenOpen = ref(false);
const tokenValue = ref('');
const tokenReason = ref('');
const tokenTunnelName = ref('');

const form = reactive<{
  name: string;
  ports: TunnelPort[];
  enabled: boolean;
}>({
  name: '',
  ports: [],
  enabled: true,
});

const protocolOptions: { label: string; value: PortProtocol }[] = [
  { label: 'TCP', value: 'tcp' },
  { label: 'UDP', value: 'udp' },
];

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
  // 默认给出一行，避免管理员把「不放行任何端口」当成默认选项而误提交。
  form.ports = [{ port: 8080, protocol: 'tcp' }];
  form.enabled = true;
  modalOpen.value = true;
}

function openEdit(tunnel: Tunnel): void {
  editingId.value = tunnel.id;
  form.name = tunnel.name;
  // 复制一份，避免编辑过程中直接改动列表里的对象。
  form.ports = tunnel.ports.map((p) => ({ ...p }));
  form.enabled = tunnel.enabled;
  modalOpen.value = true;
}

function addPort(): void {
  form.ports.push({ port: 8080, protocol: 'tcp' });
}

function removePort(index: number): void {
  form.ports.splice(index, 1);
}

/**
 * 校验并规范化端口白名单。
 *
 * 前端只拦「明显填错」的情况，真正的边界由服务端与主机端各自把关，
 * 因此这里不能因为图省事就把非法端口交给后端。
 */
function normalizePorts(): TunnelPort[] {
  const seen = new Set<string>();
  const result: TunnelPort[] = [];

  for (const item of form.ports) {
    const port = Number(item.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`端口「${String(item.port)}」不是 1-65535 之间的整数`);
    }
    const key = `${item.protocol}:${port}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ port, protocol: item.protocol });
  }

  return result.sort((a, b) =>
    a.protocol === b.protocol ? a.port - b.port : a.protocol.localeCompare(b.protocol),
  );
}

/** 展示一次性令牌。调用方保证这是明文唯一一次可见的时机。 */
function revealToken(tunnelName: string, reason: string, token: string): void {
  tokenTunnelName.value = tunnelName;
  tokenReason.value = reason;
  tokenValue.value = token;
  tokenOpen.value = true;
}

function closeToken(): void {
  tokenOpen.value = false;
  // 立即清空，避免明文在内存与 DOM 里继续留存。
  tokenValue.value = '';
}

async function copyToken(): Promise<void> {
  try {
    await navigator.clipboard.writeText(tokenValue.value);
    message.success('接入令牌已复制到剪贴板');
  } catch {
    message.warning('复制失败，请手动选中文本复制');
  }
}

async function submit(): Promise<void> {
  if (form.name.trim() === '') {
    message.warning('请填写隧道名称');
    return;
  }

  let ports: TunnelPort[];
  try {
    ports = normalizePorts();
  } catch (error) {
    message.error(error instanceof Error ? error.message : '端口格式不正确');
    return;
  }

  saving.value = true;
  try {
    if (editingId.value === undefined) {
      const created = await api.tunnels.create({
        name: form.name.trim(),
        ports,
        enabled: form.enabled,
      });
      modalOpen.value = false;
      await load();
      revealToken(created.tunnel.name, '新建', created.tunnel.token);
    } else {
      await api.tunnels.update(editingId.value, {
        name: form.name.trim(),
        ports,
        enabled: form.enabled,
      });
      message.success('隧道已更新');
      modalOpen.value = false;
      await load();
    }
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

function confirmRotate(tunnel: Tunnel): void {
  Modal.confirm({
    title: `确认轮换「${tunnel.name}」的接入令牌？`,
    content: '轮换后旧令牌立即失效，使用旧令牌的主机端会掉线，需要用新令牌重新接入。',
    okText: '轮换',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      try {
        const result = await api.tunnels.rotateToken(tunnel.id);
        await load();
        revealToken(result.tunnel.name, '轮换', result.tunnel.token);
      } catch (error) {
        message.error(error instanceof ApiError ? error.message : '轮换令牌失败');
      }
    },
  });
}

function confirmRemove(tunnel: Tunnel): void {
  Modal.confirm({
    title: `确认删除隧道「${tunnel.name}」？`,
    content: '该隧道下的所有路由都会被一并删除，已接入的主机端将立即失去连接，且不可恢复。',
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

onMounted(load);
</script>

<template>
  <div class="nt-panel-card">
    <div class="nt-panel-card__head">
      <div>
        <h2 class="nt-panel-card__title">隧道列表</h2>
        <p class="nt-hint" style="margin: 4px 0 0">
          每个隧道对应一台主机端的接入登记。只有此处列出的端口会被放行入站， 其余端口一律拒绝。
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
      <a-table-column title="名称" data-index="name" :width="180" />
      <a-table-column title="令牌前缀" :width="180">
        <template #default="{ record }">
          <span class="nt-mono">{{ record.tokenPrefix }}</span>
        </template>
      </a-table-column>
      <a-table-column title="暴露端口" :width="240">
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
      <a-table-column title="操作" :width="230">
        <template #default="{ record }">
          <a-space size="small">
            <a-button size="small" @click="openEdit(record)">编辑</a-button>
            <a-button size="small" @click="confirmRotate(record)">轮换令牌</a-button>
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
    width="620px"
    ok-text="保存"
    cancel-text="取消"
    @ok="submit"
  >
    <a-form layout="vertical">
      <a-form-item label="隧道名称" help="用于在管理后台中识别，例如「家庭主机」">
        <a-input v-model:value="form.name" placeholder="家庭主机" />
      </a-form-item>

      <a-form-item
        label="暴露端口白名单"
        help="只有列出的端口会被放行，其余一律拒绝；留空表示不放行任何入站端口。"
      >
        <div class="nt-port-editor">
          <div v-for="(item, index) in form.ports" :key="index" class="nt-port-editor__row">
            <a-input-number
              v-model:value="item.port"
              :min="1"
              :max="65535"
              :controls="false"
              placeholder="8080"
              style="width: 150px"
            />
            <a-select
              v-model:value="item.protocol"
              :options="protocolOptions"
              style="width: 110px"
            />
            <a-button size="small" danger @click="removePort(index)">移除</a-button>
          </div>
          <a-button size="small" @click="addPort">添加端口</a-button>
        </div>
      </a-form-item>

      <a-form-item label="启用">
        <a-switch v-model:checked="form.enabled" />
      </a-form-item>
    </a-form>
  </a-modal>

  <a-modal
    :open="tokenOpen"
    :title="`${tokenTunnelName} 的接入令牌（${tokenReason}）`"
    width="640px"
    :mask-closable="false"
    ok-text="我已安全保存，关闭"
    :cancel-button-props="{ style: { display: 'none' } }"
    @ok="closeToken"
    @cancel="closeToken"
  >
    <a-alert
      type="warning"
      show-icon
      message="接入令牌只显示这一次"
      description="服务端只保存令牌的哈希，关闭本弹窗后无法再次查看。请立即复制并妥善保存；一旦丢失，只能重新轮换令牌，届时旧令牌会立即失效。"
      style="margin-bottom: 16px"
    />
    <pre class="nt-pre">{{ tokenValue }}</pre>
    <div style="margin-top: 12px; text-align: right">
      <a-button type="primary" @click="copyToken">复制令牌</a-button>
    </div>
  </a-modal>
</template>

<style scoped>
.nt-port-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.nt-port-editor__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
