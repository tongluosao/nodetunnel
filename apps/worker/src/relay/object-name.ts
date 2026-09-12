/**
 * 中继对象名校验与映射。
 *
 * 单独成模块的原因：
 *   1. 该映射是组网隔离的基础，需要能被单元测试直接覆盖，
 *      而不必加载 EasyTier WASM 与 Durable Object 运行时；
 *   2. 健康检查等多个调用点需要复用同一套映射，避免逻辑分叉。
 */

/**
 * 由组网名解析 Durable Object 实例名。
 *
 * 空组网名回退到 `primary`，保证中继对未声明组网的连接仍然可用。
 * 非空组网名经 FNV-1a 哈希收敛为固定长度的合法名称。
 */
export function relayObjectName(networkName: string): string {
  const trimmed = networkName.trim();
  if (trimmed === '') {
    return 'primary';
  }
  return `net-${hashName(trimmed)}`;
}

/**
 * 稳定的短哈希：把任意组网名映射为合法的 Durable Object 名称。
 *
 * 使用 FNV-1a 32 位：计算快、无依赖、分布足够用于分组。
 * 不需要密码学强度 —— 组网名的秘密性由 network_secret 保证，
 * 哈希冲突只会导致两个组网共用同一中继实例，不会泄露密钥。
 */
function hashName(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
