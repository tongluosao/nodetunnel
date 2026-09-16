/**
 * 打包主机端 agent。
 *
 * 为什么需要打包，而不是直接 `node src/index.ts`：
 *   agent 依赖 `@nodetunnel/shared`，而该工作区按约定直接以 TS 源码形式
 *   被消费，源码内部用 `./types.js` 这样的 ESM 后缀互相引用（这是
 *   TypeScript 的标准写法，编译后才成立）。
 *   但 Node 的 `--experimental-strip-types` 只删类型、**不重写模块路径**，
 *   它不会把 `./types.js` 映射回磁盘上的 `./types.ts`，
 *   于是直接运行源码必然报 ERR_MODULE_NOT_FOUND。
 *
 * 打包顺便解决另外两件事：
 *   1. 用户可以拿到一个不依赖仓库目录结构的单文件入口；
 *   2. 避开 strip-only 模式不支持语法（参数属性、enum、namespace）的限制。
 *
 * werift 保持为外部依赖而不是打进产物：它体积大且是纯 JS，
 * 没有必要为每次构建重新打包；它作为 agent 的运行时依赖被正常安装。
 */

import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'dist/agent.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  // 目标设为 Node 20：仓库要求 Node >= 20，且该版本已有稳定的 ESM 与 fetch。
  target: 'node20',
  external: ['werift'],
  // 让产物可直接执行。
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
