<script setup lang="ts">
import { ConfigProvider, theme } from 'ant-design-vue';
import zhCN from 'ant-design-vue/es/locale/zh_CN';
import { computed } from 'vue';

import { useThemeStore } from '@/stores/theme';

/**
 * 应用根组件。
 *
 * 主题只在这里交给 ConfigProvider：Ant Design 的组件配色由 algorithm
 * 统一推导，与 global.css 的 data-theme 变量同源。这样就不需要为每个
 * 组件手写前景色覆盖 —— 手写覆盖一旦漏掉某处，就会出现深色底上的黑字。
 */
const themeStore = useThemeStore();

const antdTheme = computed(() => ({
  algorithm: themeStore.resolved === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
}));
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="antdTheme">
    <RouterView />
  </ConfigProvider>
</template>
