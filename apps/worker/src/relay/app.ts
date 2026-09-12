import { createEasyTierCloudflare } from '@easytier/cloudflare';

import type { Env } from '../env.js';
import { relayObjectName } from './object-name.js';

/**
 * EasyTier 中继应用。
 *
 * 复用上游 `@easytier/cloudflare` 的实现，不修改其逻辑：
 *   - 该包在 Durable Object 内运行 EasyTier WASM 内核；
 *   - 提供 WebSocket 接入（101 升级）与 /health 健康检查；
 *   - 只做入站中继，不主动拨号；
 *   - WASM 模块由该包内部通过静态 `.wasm` 导入获取，
 *     由 wrangler 的 CompiledWasm 规则在构建期编译。
 *
 * 本项目的职责只是提供「按组网名选择 Durable Object」的映射，
 * 使每个 tunnel 组网拥有独立的中继实例，实现组网间隔离。
 *
 * 数据流：
 *   隧道节点 / 浏览器节点 --wss--> Worker --(DO)--> EasyTier 中继实例
 */
export const easytierRelay = createEasyTierCloudflare<Env>({
  namespace: (env: Env) => env.EASYTIER_RELAY,

  /**
   * 中继自身的网络身份。
   *
   * 中继不是业务组网的成员，它只负责转发：EasyTier 会依据节点上报的
   * network_name / network_secret 做归属校验。这里使用独立的中继组网身份，
   * 避免中继因加入某个业务组网而继承其 ACL。
   */
  config: (env: Env) => ({
    networkName: env.NT_RELAY_NETWORK_NAME,
    networkSecret: env.NT_RELAY_NETWORK_SECRET,
    instanceName: 'nodetunnel-relay',
    encryption: true,
  }),

  /**
   * 组网隔离：不同组网路由到不同的 Durable Object 实例。
   *
   * 对象名取自请求 URL 的 `network` 查询参数（由 relay/handler.ts 注入）。
   */
  objectName: (request: Request) => {
    const url = new URL(request.url);
    return relayObjectName(url.searchParams.get('network') ?? '');
  },
});

export { relayObjectName };
