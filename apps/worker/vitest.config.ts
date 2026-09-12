import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 多数测试是纯逻辑（协议渲染、校验、命名映射），使用 node 环境即可。
    // 需要 Workers 运行时的集成测试将在后续阶段引入 @cloudflare/vitest-pool-workers。
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
