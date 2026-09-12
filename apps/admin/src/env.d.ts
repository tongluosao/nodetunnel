/// <reference types="vite/client" />

/**
 * Vue 单文件组件的类型声明。
 *
 * 由 vue-tsc 处理 .vue 文件；此处声明让 tsc 在纯类型检查时
 * 也能解析 `import X from './X.vue'`。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
