/**
 * 信令房间名映射（基础层）。
 *
 * 单独成模块的原因：
 *   1. 该映射是「每个 tunnel 一个房间」这个隔离语义的基础，
 *      需要能被单元测试直接覆盖，而不必加载 Durable Object 运行时；
 *   2. 主机接入、访客接入、健康检查等多个调用点需要复用同一套映射，
 *      避免逻辑分叉导致访客被路由到错误的房间。
 */

/**
 * 由 tunnel id 解析 Durable Object 实例名。
 *
 * tunnel id 是服务端生成的 UUID，本身已是合法名称，但仍做一次
 * FNV-1a 哈希：这样 DO 名称长度恒定，且不会把内部 id 直接暴露在
 * DO 命名空间里（DO 名称会出现在日志与 Cloudflare 面板中）。
 */
export function signalingRoomName(tunnelId: string): string {
  const trimmed = tunnelId.trim();
  if (trimmed === '') {
    return 'unassigned';
  }
  return `room-${hashName(trimmed)}`;
}

/**
 * 稳定的短哈希：把任意标识映射为合法的 Durable Object 名称。
 *
 * 使用 FNV-1a 32 位：计算快、无依赖、分布足够用于分组。
 * 不需要密码学强度 —— 隧道归属由接入令牌保证，
 * 哈希冲突只会导致两个隧道共用同一房间，而它们各自的信令里带着
 * 自己的 sessionId，不会互相错投到同一个访客连接上。
 */
function hashName(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
