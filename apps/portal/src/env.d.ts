/// <reference types="vite/client" />

/** Vue 单文件组件的类型声明（由 vue-tsc 处理实际编译）。 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
