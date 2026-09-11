// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * 三层边界的强制规则。
 *
 * 依赖方向严格单向：接入层 -> 业务层 -> 基础层。
 * 基础层不得反向依赖上层，业务层不得绕过基础层直接持有基础设施句柄。
 */
const BASE_LAYER_DIRS = [
  'apps/worker/src/db/**',
  'apps/worker/src/relay/**',
  'apps/worker/src/config-server/**',
  'apps/worker/src/lib/**',
  'packages/**',
];

const BOUNDARY_MESSAGE =
  '违反三层边界：基础层不得依赖业务层或接入层。请把共享类型下沉到 packages/shared。';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.wrangler/**',
      '**/.turbo/**',
      '**/coverage/**',
      '其他项目代码/**',
      '**/wasm/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.vue'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
      'prefer-const': 'error',
    },
  },
  {
    files: BASE_LAYER_DIRS,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/admin/**'], message: BOUNDARY_MESSAGE },
            { group: ['**/http-tunnel/**'], message: BOUNDARY_MESSAGE },
            { group: ['**/nodetunnel/**'], message: BOUNDARY_MESSAGE },
          ],
        },
      ],
    },
  },
  {
    // 业务层不得直接执行 SQL 或直接触碰 Durable Object 存储句柄。
    files: ['apps/worker/src/nodetunnel/**', 'apps/worker/src/admin/**', 'apps/worker/src/http-tunnel/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['cloudflare:workers'],
              importNames: ['DurableObject'],
              message:
                '业务层不得直接实例化 DurableObject，请通过 src/db 或 src/relay 暴露的接口访问。',
            },
          ],
        },
      ],
    },
  },
);
