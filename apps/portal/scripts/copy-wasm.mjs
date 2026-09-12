import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 把编译好的 EasyTier WASM 复制到门户的 public 目录。
 *
 * 复制而非直接引用 packages 内的产物，原因：
 *   1. 浏览器门户需要能通过普通 HTTP 请求获取 .wasm（避免打包器对
 *      ESM WASM 导入的差异化处理）；
 *   2. packages/easytier-js 下的 generated 目录被 gitignore 排除，
 *      复制到 public 后门户可以独立部署。
 *
 * 用法：pnpm build:wasm 产出 WASM 后，此脚本负责搬运。
 */

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const portalRoot = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(portalRoot, '..', '..');

const source = path.join(
  repositoryRoot,
  'packages',
  'easytier-js',
  'browser',
  'src',
  'generated',
  'easytier_core.wasm',
);
const targetDirectory = path.join(portalRoot, 'public');
const target = path.join(targetDirectory, 'easytier_core.wasm');

if (!(await exists(source))) {
  console.error(`未找到 WASM 产物：${source}`);
  console.error('请先运行 pnpm build:wasm 生成浏览器 profile 的内核。');
  process.exit(1);
}

await mkdir(targetDirectory, { recursive: true });
await copyFile(source, target);

const size = (await stat(target)).size;
console.log(
  `已复制 WASM 到 ${path.relative(repositoryRoot, target)}（${(size / 1024 / 1024).toFixed(2)} MB）`,
);

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
