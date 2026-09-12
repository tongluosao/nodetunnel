import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * 管理后台构建配置。
 *
 * 开发期通过代理把 /api 转发到本地 Worker，避免 CORS 与会话 Cookie 的
 * SameSite 限制；生产构建产出纯静态资源，可部署到任意静态托管。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 复用共享包的类型与常量（如 ACL 枚举、路径前缀）。
      '@nodetunnel/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    // 显式绑定 IPv4 回环：默认只监听 ::1，会导致 127.0.0.1 无法访问，
    // 与 Worker（127.0.0.1:8787）的地址族不一致，排查问题时容易误判。
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
