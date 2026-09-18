<script setup lang="ts">
import { message, Modal } from 'ant-design-vue';
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';

import { useAuthStore } from '@/stores/auth';
import { useThemeStore, type ThemeMode } from '@/stores/theme';

/**
 * 管理后台主布局：左侧导航 + 顶部栏 + 内容区。
 */

const auth = useAuthStore();
const themeStore = useThemeStore();
const route = useRoute();
const router = useRouter();

const navItems = [
  { name: 'dashboard', label: '仪表盘', icon: '◈' },
  { name: 'tunnels', label: '隧道管理', icon: '⬡' },
  { name: 'routes', label: '路由管理', icon: '⇄' },
  { name: 'agents', label: '主机端', icon: '◉' },
  { name: 'settings', label: '系统设置', icon: '⚙' },
] as const;

const pageTitle = computed(() =>
  typeof route.meta.title === 'string' ? route.meta.title : 'NodeTunnel',
);

const username = computed(() => auth.admin?.username ?? '');

/** 主题三态：跟随系统 / 浅色 / 深色。 */
const themeOptions: { label: string; value: ThemeMode }[] = [
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
  { label: '跟随系统', value: 'system' },
];

/** a-segmented 的 change 回调值是 string | number，这里显式收窄为三态之一。 */
function onThemeChange(value: string | number): void {
  if (value === 'light' || value === 'dark' || value === 'system') {
    themeStore.setMode(value);
  }
}

function confirmLogout(): void {
  Modal.confirm({
    title: '确认退出登录？',
    okText: '退出',
    cancelText: '取消',
    async onOk() {
      await auth.logout();
      message.success('已退出登录');
      await router.push({ name: 'login' });
    },
  });
}
</script>

<template>
  <div class="nt-shell">
    <aside class="nt-sider">
      <div class="nt-logo">
        <span class="nt-logo__dot" />
        <span>NodeTunnel</span>
      </div>
      <nav class="nt-nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.name"
          :to="{ name: item.name }"
          class="nt-nav__item"
          :class="{ 'nt-nav__item--active': route.name === item.name }"
        >
          <span aria-hidden="true">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>
    </aside>

    <div class="nt-main">
      <header class="nt-header">
        <h1 class="nt-header__title">{{ pageTitle }}</h1>
        <div class="nt-header__user">
          <a-segmented
            :value="themeStore.mode"
            :options="themeOptions"
            size="small"
            @change="onThemeChange"
          />
          <span>版本 {{ auth.version || '—' }}</span>
          <span>·</span>
          <span>{{ username || '管理员' }}</span>
          <a-button size="small" @click="confirmLogout">退出</a-button>
        </div>
      </header>

      <main class="nt-content">
        <RouterView />
      </main>
    </div>
  </div>
</template>
