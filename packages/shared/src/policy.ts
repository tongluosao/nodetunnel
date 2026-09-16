import type { TunnelPort } from './types.js';

/**
 * 入站端口白名单策略。
 *
 * 这是本项目**唯一的安全边界**，因此放在共享包里由两端各自执行：
 *
 *   - Worker 侧在转发前判断，避免把注定被拒的请求发出去；
 *   - agent 侧在建立本地连接前再判断一次。
 *
 * 为什么要判两次而不是信任 Worker：
 *   agent 直接连在用户的机器上，是真正持有「能否连到某个本地端口」这一
 *   能力的一方。如果只有 Worker 判断，那么一旦 Worker 校验有疏漏、
 *   被绕过，或者将来多出一种不经过 Worker 的入站路径（例如 P2P 直连），
 *   攻击面就直接落到用户的内网上。agent 独立判断后，即使 Worker 判错，
 *   本机端口也不会被访问。
 *
 * 语义：**默认拒绝**。未在列表中显式声明的端口一律拒绝，
 * 这与重构前 EasyTier ACL 的「默认 Drop 入站」语义保持一致。
 */

/** 判断某个 TCP 端口是否被允许入站。 */
export function isPortAllowed(
  ports: TunnelPort[],
  port: number,
  protocol: 'tcp' | 'udp' = 'tcp',
): boolean {
  return ports.some((item) => item.port === port && item.protocol === protocol);
}

/**
 * 判断目标主机是否允许作为转发目标。
 *
 * 只允许回环地址与私有网段 —— 这不只是「内网穿透」的语义要求，
 * 也是一道安全约束：如果允许填任意公网地址，这套系统就会变成一个
 * 开放的匿名代理，被用来隐藏攻击来源。
 *
 * 明确拒绝的写法（默认拒绝）而不是允许列表的例外写法，
 * 避免出现「以为拦住了其实没有」的情况。
 */
export function isTargetHostAllowed(host: string): boolean {
  const value = host.trim().toLowerCase();

  if (value === 'localhost' || value === '::1') {
    return true;
  }

  // IPv4 字面量：只放行私有段与回环段。
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ipv4 !== null) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地
    return false;
  }

  // 主机名：允许普通内网域名（如 nas.local、api.internal）。
  // 拒绝带点且不像内网域名的裸公网域名需要 DNS 解析才能判断，
  // 这里不做解析（解析结果不可信且有 DNS 重绑定风险），
  // 因此对主机名放宽，由部署者自行约束 —— 这一点必须在文档里写明。
  return /^[a-z0-9][a-z0-9.-]*$/.test(value);
}
