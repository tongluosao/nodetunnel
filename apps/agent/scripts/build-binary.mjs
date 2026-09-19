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

// SEA 需要载体二进制里预置一段 sentinel（fuse）。这段 hex 会随 Node 版本变化，
// 所以下面改为动态提取，不再依赖某个具体版本。这里只守住最低版本：
// SEA 自 Node 20.12 起可用，更早的版本会给出莫名其妙的注入错误。
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(
    `构建二进制需要 Node >= 20.12（当前 ${process.versions.node}）。\n` +
      `Node SEA（单文件可执行）自 20.12 起提供。`,
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

// 必须用 realpath 解析：setup-node 等版本管理器提供的 process.execPath
// 往往是符号链接，直接 copyFileSync 复制符号链接拿到的不是真正的二进制
// （或链接目标不完整），后续注入就会找不到 fuse。
const nodeBinary = fs.realpathSync(process.execPath);
fs.copyFileSync(nodeBinary, binaryPath);
console.log(
  `[3/4] 已准备载体二进制：${binaryName}（${nodeBinary}，${(fs.statSync(binaryPath).size / 1024 / 1024).toFixed(1)} MB）`,
);

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
// fuse 常量**不能硬编码**。它形如 NODE_SEA_FUSE_<hex>，但这段 hex 会随 Node
// 版本变化（实测 Node 24 是 ...df1996b2，而网上流传的旧文档值是 ...dfa6c673）。
// 硬编码会在换 Node 版本后抛出「找不到 sentinel」，且报错指向 postject，
// 很难联想到是版本漂移。因此直接从载体二进制里读出来。
const fuse = extractSeaFuse(nodeBinary);
if (fuse === undefined) {
  console.error('载体二进制里找不到 NODE_SEA_FUSE_*，该 node 构建不支持 SEA。');
  process.exit(1);
}
console.log(`      载体 fuse：${fuse}`);
await inject(binaryPath, 'NODE_SEA_BLOB', fs.readFileSync(blobPath), { sentinelFuse: fuse });
console.log(`[4/4] 已注入，产物：dist-binary/${binaryName}`);

// 清理中间文件，只留可执行产物。
for (const f of ['agent.cjs', 'sea.blob', 'sea-config.json']) {
  fs.rmSync(path.join(outDir, f), { force: true });
}

/**
 * 从 node 二进制里读出 SEA 的 fuse 常量名。
 *
 * 只取首个 NODE_SEA_FUSE 出现处往后的一小段做正则匹配，
 * 不整文件扫描 —— 二进制有几十 MB，全扫会明显拖慢构建。
 */
function extractSeaFuse(binaryFile) {
  const handle = fs.openSync(binaryFile, 'r');
  try {
    const CHUNK = 1 << 20; // 1 MB
    const buf = Buffer.alloc(CHUNK);
    let offset = 0;
    let carry = '';
    while (true) {
      const read = fs.readSync(handle, buf, 0, CHUNK, offset);
      if (read === 0) break;
      const haystack = carry + buf.subarray(0, read).toString('latin1');
      const m = /NODE_SEA_FUSE_[0-9a-fA-F]+/.exec(haystack);
      if (m !== null) return m[0];
      // 跨块边界的匹配：保留尾部，避免常量被切成两半而漏掉。
      carry = haystack.slice(-64);
      offset += read;
    }
    return undefined;
  } finally {
    fs.closeSync(handle);
  }
}
