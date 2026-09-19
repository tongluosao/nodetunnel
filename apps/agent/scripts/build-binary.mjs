/**
 * 把主机端 agent 打包成**自包含的单文件可执行程序**（Node SEA）。
 *
 * 与 scripts/build.mjs 的区别：
 *   - build.mjs 产出 dist/agent.mjs，werift 留作外部依赖，运行时要装依赖；
 *   - 本脚本把 werift 一起打进去，再配合 Node SEA 把运行时与代码合成一个文件，
 *     用户下载后直接双击/命令行执行，不需要 Node 也不需要 npm install。
 *
 * 为什么必须在目标平台原生构建（不能交叉编译）：
 *   SEA 的原理是「拿一份该平台的官方 node 二进制，把代码 blob 注入进去」。
 *   产物里跑的就是这份二进制，因此 Windows 上只能做出 Windows 版，
 *   在 Linux x64 上也做不出 arm64 版。跨平台产物必须靠各平台的 CI runner
 *   分别构建 —— 这一步由 .github/workflows/release.yml 的 matrix 完成。
 *
 * 用法：
 *   node scripts/build-binary.mjs <target-name>
 *   产物落在 apps/agent/dist-binary/
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-binary');

// SEA 依赖载体二进制里预置的一段 sentinel（fuse）。不同 Node 版本的二进制
// 布局可能变化，因此固定用一个经过验证的版本，避免换版本后静默产出坏文件。
// CI 里由 actions/setup-node 提供；本地构建时同样需要这个版本。
const major = Number(process.versions.node.split('.')[0]);
if (major !== 22) {
  console.error(
    `构建二进制需要 Node 22（当前 ${process.versions.node}）。\n` +
      `SEA 注入依赖载体二进制内的 sentinel 槽位，只在 Node 22 上做过验证。`,
  );
  process.exit(1);
}

/** 目标名 → SEA 需要的平台标识与可执行文件后缀。 */
const TARGETS = {
  'linux-x64': { sea: 'linux-x64', ext: '' },
  'linux-arm64': { sea: 'linux-arm64', ext: '' },
  'win-x64': { sea: 'win-x64', ext: '.exe' },
  'win-arm64': { sea: 'win-arm64', ext: '.exe' },
};

const targetName = process.argv[2];
const target = TARGETS[targetName];
if (target === undefined) {
  console.error(`未知目标：${targetName ?? '(未指定)'}；可选：${Object.keys(TARGETS).join(', ')}`);
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// 1. 打成自包含的 CJS 单文件
//
// SEA 只接受 CJS：ESM 的 import 在 blob 里无法解析（没有文件系统可回溯）。
// werift 不再 external —— 二进制产物里没有 node_modules 可供它去加载。
// ---------------------------------------------------------------------------
const bundlePath = path.join(outDir, 'agent.cjs');
await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: [],
  logLevel: 'warning',
});
console.log(
  `[1/4] 已打包自包含 CJS：${(fs.statSync(bundlePath).size / 1024 / 1024).toFixed(2)} MB`,
);

// ---------------------------------------------------------------------------
// 2. 生成 SEA blob
// ---------------------------------------------------------------------------
const blobPath = path.join(outDir, 'sea.blob');
const configPath = path.join(outDir, 'sea-config.json');
fs.writeFileSync(
  configPath,
  JSON.stringify({
    main: bundlePath,
    output: blobPath,
    // 不注入实验性警告：这是给用户直接运行的成品，不是开发调试。
    disableExperimentalSEAWarning: true,
  }),
);
execFileSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit' });
console.log('[2/4] 已生成 SEA blob');

// ---------------------------------------------------------------------------
// 3. 取一份当前平台的 node 二进制作为载体
// ---------------------------------------------------------------------------
const binaryName = `nodetunnel-agent-${targetName}${target.ext}`;
const binaryPath = path.join(outDir, binaryName);
fs.copyFileSync(process.execPath, binaryPath);
console.log(`[3/4] 已准备载体二进制：${binaryName}`);

// ---------------------------------------------------------------------------
// 4. 注入 blob
//
// 注入会破坏 node.exe 原有的数字签名，日志里的
// 「The signature seems corrupted!」是预期现象，不影响运行。
// ---------------------------------------------------------------------------

// postject 作为 devDependency 装在项目里，且**作为库调用**而不是起子进程：
// 起子进程需要管道通信来捕获输出，在受限构建环境里会因 EPERM 失败；
// 直接 import 调用则在同一进程内完成，没有管道依赖。
const { inject } = await import('postject');
// sentinelFuse 必须显式传 Node SEA 的固定常量。
// 不传时 postject 会去找它自己的默认 sentinel（POSTJECT_SENTINEL_*），
// 而 node 二进制里只有 NODE_SEA_FUSE_*，于是报「找不到 sentinel」。
await inject(binaryPath, 'NODE_SEA_BLOB', fs.readFileSync(blobPath), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5dfa6c673',
});
console.log(`[4/4] 已注入，产物：dist-binary/${binaryName}`);

// 清理中间文件，只留可执行产物。
for (const f of ['agent.cjs', 'sea.blob', 'sea-config.json']) {
  fs.rmSync(path.join(outDir, f), { force: true });
}
