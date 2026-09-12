// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

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
      '**/.wasm-build/**',
      '其他项目代码/**',
      '**/wasm/**',
      '**/src/generated/**',
      'packages/easytier-js/runtime/src/jspi.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    // 让 .vue 文件用 vue-eslint-parser 解析，并把 <script> 交给 TS 解析器。
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 2023,
        sourceType: 'module',
      },
    },
    rules: {
      // 单文件组件名与文件同名是常见约定，多词限制对本项目无意义。
      'vue/multi-word-component-names': 'off',
      // 本项目统一 2 空格缩进、单引号，交由 Prettier 处理版式。
      'vue/html-indent': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/attributes-order': 'off',
    },
  },
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
    /**
     * vendored 上游代码（packages/easytier-js）。
     *
     * 这批文件通过 scripts/sync-upstream.mjs 从只读参考目录同步而来，
     * 本项目遵循「最小改动复用上游」的原则，因此不把本仓库的代码风格
     * 强制施加到它们身上——否则每次同步都会产生无意义的冲突。
     * 仅保留真正影响正确性的规则（如 no-undef 之外的错误用法）。
     */
    files: ['packages/easytier-js/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-empty-interface': 'off',
      'prefer-const': 'off',
      'no-undef': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
    },
  },
  {
    // 浏览器侧代码（管理后台、门户）使用 DOM 全局对象。
    files: ['apps/admin/**/*.{ts,vue}', 'apps/portal/**/*.{ts,vue}'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        crypto: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        WebSocket: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        Blob: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        performance: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        WebAssembly: 'readonly',
        RTCPeerConnection: 'readonly',
        RTCDataChannel: 'readonly',
        RTCSessionDescription: 'readonly',
        RTCIceCandidate: 'readonly',
        MessageChannel: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        structuredClone: 'readonly',
      },
    },
  },
  {
    // Worker 侧运行在 Cloudflare 运行时，部分 DOM 类型以全局形式可用。
    files: ['apps/worker/**/*.ts', 'packages/**/*.ts'],
    languageOptions: {
      globals: {
        crypto: 'readonly',
        WebAssembly: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        WebSocketPair: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        structuredClone: 'readonly',
      },
    },
  },
  {
    // Node 脚本使用 Node 全局对象，且不做类型化约束。
    files: ['scripts/**/*.mjs', 'scripts/**/*.js', 'packages/easytier-js/**/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        URL: 'readonly',
        WebAssembly: 'readonly',
      },
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
    files: [
      'apps/worker/src/nodetunnel/**',
      'apps/worker/src/admin/**',
      'apps/worker/src/http-tunnel/**',
    ],
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
