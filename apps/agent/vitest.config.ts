import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // agent 的纯逻辑（地址校验、白名单求交、请求转发决策）与运行时解耦，
    // 因此用 node 环境即可，不需要拉起真实的 WebSocket 与 WebRTC。
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
