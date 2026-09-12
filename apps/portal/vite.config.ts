import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';

/**
 * 把 `import bytes from ".../easytier_core.wasm"` 解析为运行时 fetch。
 *
 * 背景：上游 @easytier/browser 用裸 ESM 语法导入 .wasm，而 Vite 默认
 * 不支持「ESM integration proposal for Wasm」，构建会直接失败。
 *
 * 可选方案与取舍：
 *   1. 引入 vite-plugin-wasm —— 增加一个依赖，且它会改变 WASM 的加载语义；
 *   2. 改写上游源码为 `?url` —— 违反「最小改动复用上游」的原则；
 *   3. 本方案：在插件里把该导入替换为一段返回 fetch 结果的模块。
 *
 * 采用方案 3：不新增依赖、不触碰上游，且产物中 WASM 保持独立文件，
 * 由浏览器按需加载（3.4 MB 的内核不会阻塞首屏）。
 */
function wasmAsFetch(): Plugin {
  // 构建产物中该文件的公开路径（与 copy-wasm.mjs 的输出位置一致）。
  const PUBLIC_PATH = '/easytier_core.wasm';

  return {
    name: 'nodetunnel-wasm-as-fetch',
    enforce: 'pre',

    async resolveId(source, importer) {
      if (!source.endsWith('.wasm')) {
        return null;
      }
      // 让 Vite 正常解析出 .wasm 的绝对路径，再把它指向我们的替身模块。
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (resolved === null) {
        return null;
      }
      return `\0nodetunnel-wasm:${PUBLIC_PATH}`;
    },

    load(id) {
      if (!id.startsWith('\0nodetunnel-wasm:')) {
        return null;
      }
      const publicPath = id.slice('\0nodetunnel-wasm:'.length);

      // 返回一个「默认导出即 WASM 字节」的虚拟模块，与上游的用法保持一致。
      return `
        let cached;
        export default async function loadCoreBytes() {
          if (cached === undefined) {
            const response = await fetch(${JSON.stringify(publicPath)});
            if (!response.ok) {
              throw new Error(
                '无法加载 EasyTier 内核（HTTP ' + response.status + '）。' +
                '请确认已执行 pnpm build:wasm 与 prepare:wasm。'
              );
            }
            cached = await response.arrayBuffer();
          }
          return cached;
        }
      `;
    },
  };
}

/**
 * 浏览器门户构建配置。
 */
export default defineConfig({
  plugins: [vue(), wasmAsFetch()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@nodetunnel/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // WASM 体积较大，不作为内联资源。
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    // 这两个包以 TS 源码形式被引用，无需预打包。
    exclude: ['@easytier/browser', '@easytier/runtime'],
  },
});
