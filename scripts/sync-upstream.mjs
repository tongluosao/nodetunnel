#!/usr/bin/env node
/**
 * 从只读参考仓库同步 easytier-js 源码。
 *
 * 参考目录「其他项目代码」是只读的：本脚本只读取它，绝不写入。
 * 同步后目标目录中的文件会被覆写，但以下文件被保留（本项目的定制）：
 *   - packages/easytier-js/runtime/src/transport/**（阶段 5 的 RTC 传输扩展点）
 *   - packages/easytier-js/runtime/src/websocket-host.patch.md（改动说明）
 *
 * 用法：
 *   pnpm sync:upstream          # 同步
 *   pnpm sync:upstream --check  # 只校验差异，不写入
 */
import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const upstreamRoot = path.join(repositoryRoot, '其他项目代码', 'EasyTier', 'easytier-js');
const targetRoot = path.join(repositoryRoot, 'packages', 'easytier-js');

/** 同步时需要一并复制的相对路径（相对于 easytier-js 根）。 */
const COPY_ENTRIES = [
  ['runtime/src', 'runtime/src'],
  ['runtime/scripts', 'runtime/scripts'],
  ['runtime/package.json', 'runtime/package.json'],
  ['runtime/tsconfig.json', 'runtime/tsconfig.json'],
  ['runtime/tsconfig.build.json', 'runtime/tsconfig.build.json'],
  ['runtime/README.md', 'runtime/README.md'],
  ['browser/src', 'browser/src'],
  ['browser/package.json', 'browser/package.json'],
  ['browser/tsconfig.json', 'browser/tsconfig.json'],
  ['browser/tsconfig.build.json', 'browser/tsconfig.build.json'],
  ['browser/README.md', 'browser/README.md'],
  ['cloudflare/src', 'cloudflare/src'],
  ['cloudflare/package.json', 'cloudflare/package.json'],
  ['cloudflare/tsconfig.json', 'cloudflare/tsconfig.json'],
  ['cloudflare/tsconfig.build.json', 'cloudflare/tsconfig.build.json'],
  ['cloudflare/README.md', 'cloudflare/README.md'],
  ['cloudflare/wrangler.jsonc', 'cloudflare/wrangler.jsonc'],
];

/**
 * 属于本项目定制、禁止被上游覆盖的路径。
 *
 * package.json 也被保留：上游使用 `workspace:0.1.0` 与固定版本号，
 * 本项目需要 `private: true` 与 `workspace:*`，并在 exports 中直接指向 TS 源码。
 *
 * browser/cloudflare 的 tsconfig.json 同样保留：上游的 include 未覆盖
 * runtime/src/jspi.d.ts，导致从这两个包发起类型检查时找不到
 * WebAssembly.Suspending / promising 而报错。本项目在 include 中补上了该文件。
 */
const PRESERVE = [
  path.join('runtime', 'src', 'transport'),
  path.join('runtime', 'src', 'websocket-host.patch.md'),
  path.join('runtime', 'src', 'rtc-host.ts'),
  path.join('runtime', 'package.json'),
  path.join('browser', 'package.json'),
  path.join('browser', 'tsconfig.json'),
  path.join('cloudflare', 'package.json'),
  path.join('cloudflare', 'tsconfig.json'),
];

function normalize(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function isPreserved(relativePath) {
  const normalized = normalize(relativePath);
  return PRESERVE.some(
    (preserved) =>
      normalized === normalize(preserved) || normalized.startsWith(`${normalize(preserved)}/`),
  );
}

async function collectFiles(root, relative = '') {
  const absolute = path.join(root, relative);
  const info = await stat(absolute);
  if (info.isFile()) {
    return [relative];
  }
  if (!info.isDirectory()) {
    return [];
  }
  const entries = await readdir(absolute);
  const files = [];
  for (const entry of entries) {
    files.push(...(await collectFiles(root, path.join(relative, entry))));
  }
  return files;
}

async function main() {
  const checkOnly = process.argv.includes('--check');

  if (!existsSync(upstreamRoot)) {
    console.error(`未找到参考目录: ${upstreamRoot}`);
    console.error('请确认「其他项目代码/EasyTier/easytier-js」存在。');
    process.exit(1);
  }

  const copied = [];
  const skipped = [];

  for (const [from, to] of COPY_ENTRIES) {
    const source = path.join(upstreamRoot, from);
    const destination = path.join(targetRoot, to);
    if (!existsSync(source)) {
      console.warn(`跳过（上游不存在）: ${from}`);
      continue;
    }

    const files = await collectFiles(source);
    for (const relative of files) {
      const targetRelative = path.join(to, relative);
      if (isPreserved(targetRelative)) {
        skipped.push(normalize(targetRelative));
        continue;
      }
      if (!checkOnly) {
        await mkdir(path.dirname(path.join(targetRoot, targetRelative)), { recursive: true });
        await cp(path.join(source, relative), path.join(targetRoot, targetRelative));
      }
      copied.push(normalize(targetRelative));
    }

    if (files.length === 0 && !checkOnly) {
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true });
    }
  }

  if (!checkOnly) {
    await writeFile(
      path.join(targetRoot, 'UPSTREAM.md'),
      buildUpstreamNote(copied.length, skipped),
      'utf8',
    );
  }

  console.log(`${checkOnly ? '[校验] 待同步' : '已同步'} ${copied.length} 个文件`);
  if (skipped.length > 0) {
    console.log(`保留本项目定制 ${skipped.length} 项:`);
    for (const item of skipped) {
      console.log(`  - ${item}`);
    }
  }
}

function buildUpstreamNote(fileCount, preserved) {
  return `# 上游来源说明

本目录的源码复制自 EasyTier 官方仓库的 \`easytier-js\` 工作区。

- 上游路径：\`其他项目代码/EasyTier/easytier-js\`（只读参考，本项目不修改它）
- 同步文件数：${fileCount}
- 同步脚本：\`scripts/sync-upstream.mjs\`

## 本项目的改动

本项目对上游代码做了最小必要改动，改动点集中记录，便于对照升级：

1. \`runtime/src/config.ts\` —— 增加传输相关配置项，使浏览器 profile 可在
   P2P 可用时不再强制 \`disable_p2p\`（阶段 5）。
2. \`runtime/src/websocket-host.ts\` —— 登记 WebRTC 相关的 host 导入实现
   （阶段 5）；此前这些导入固定返回 \`HOST_UNSUPPORTED\`。
3. \`runtime/src/rtc-host.ts\`、\`runtime/src/transport/\` —— 本项目新增文件，
   同步脚本会保留，不会被上游覆盖。

## 保留路径（同步时不会被覆盖）

${preserved.map((item) => `- \`${item}\``).join('\n')}
`;
}

await main();
