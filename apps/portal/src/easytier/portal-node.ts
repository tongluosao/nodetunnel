import type { EasyTierEvent, EasyTierInstance, EasyTierTcpStream } from '@easytier/runtime';

/**
 * 浏览器侧 EasyTier 节点客户端。
 *
 * 这是需求 3 的核心：在用户访问本网站时，于浏览器内运行一个
 * EasyTier 节点（WASM 内核 + WebSocket 中继），使其加入目标隧道所在的
 * 虚拟局域网，从而可以直接访问隧道内被放行的服务。
 *
 * 安全约定（与后端 ACL 渲染保持一致）：
 *   浏览器节点被渲染为「禁止一切入站」，不监听任何端口。
 *   它只发起连接，因此即使浏览器被恶意页面接管，也无法被当作
 *   进入虚拟网的入口。
 *
 * WASM 获取方式：
 *   不通过 ESM import（打包器行为差异大），而是用 fetch 取 public 下的
 *   .wasm 字节，再交给 createEasyTierWithArtifact。
 */

export interface PortalNodeConfig {
  /** 隧道组网名（network_name）。 */
  networkName: string;
  /** 隧道组网密钥（network_secret）。 */
  networkSecret: string;
  /** 中继 WebSocket 地址。 */
  relayUrl: string;
  /**
   * 本节点在虚拟网中的 IPv4 地址。
   *
   * 必须与隧道内其他节点处于同一网段且不冲突，例如 10.144.144.0/24。
   * 由门户从隧道信息中分配或由用户填写。
   */
  ipv4: string;
  /** 实例名称，仅用于日志与状态展示。 */
  instanceName?: string;
  /** 是否启用传输加密。 */
  encryption?: boolean;
}

export type PortalNodeState = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

export interface PortalNodeStatus {
  state: PortalNodeState;
  connections: number;
  error?: string;
  events: EasyTierEvent[];
}

/** 保留的最大事件条数，避免长时间运行后内存无限增长。 */
const MAX_EVENTS = 200;

export class PortalNode {
  #instance: EasyTierInstance | undefined;
  #state: PortalNodeState = 'idle';
  #connections = 0;
  #error: string | undefined;
  #events: EasyTierEvent[] = [];
  #listeners = new Set<(status: PortalNodeStatus) => void>();

  get status(): PortalNodeStatus {
    return {
      state: this.#state,
      connections: this.#connections,
      error: this.#error,
      events: [...this.#events],
    };
  }

  /** 订阅状态变化。返回取消订阅函数。 */
  subscribe(listener: (status: PortalNodeStatus) => void): () => void {
    this.#listeners.add(listener);
    listener(this.status);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(): void {
    const snapshot = this.status;
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }

  #pushEvent(event: EasyTierEvent): void {
    this.#events = [...this.#events, event].slice(-MAX_EVENTS);
    this.#emit();
  }

  /**
   * 启动浏览器节点。
   *
   * 幂等：已在运行或正在启动时直接返回，避免重复创建 WASM 实例
   * （重复实例会争抢同一个虚拟 IP，导致组网异常）。
   */
  async start(config: PortalNodeConfig): Promise<void> {
    if (this.#state === 'running' || this.#state === 'starting') {
      return;
    }

    this.#error = undefined;
    this.#events = [];
    this.#state = 'starting';
    this.#emit();

    try {
      // 动态导入：避免把体积较大的运行时打进首屏包。
      // 上游 browser 包只导出 "."，其 createEasyTier 内部会自行导入
      // generated/easytier_core.wasm，因此无需我们手动 fetch。
      const { createEasyTier } = await import('@easytier/browser');

      this.#state = 'starting';
      this.#emit();

      this.#instance = await createEasyTier(
        {
          networkName: config.networkName,
          networkSecret: config.networkSecret,
          instanceName: config.instanceName ?? 'nodetunnel-portal',
          encryption: config.encryption ?? true,
          ipv4: config.ipv4,
          peers: config.relayUrl,
        },
        {
          onEvent: (event) => {
            this.#pushEvent(event);
          },
        },
      );

      const status = await this.#instance.status();
      this.#connections = status.connections;
      this.#state = status.state === 'running' ? 'running' : 'starting';
      this.#emit();
    } catch (error) {
      this.#state = 'error';
      this.#error = error instanceof Error ? error.message : String(error);
      this.#instance = undefined;
      this.#emit();
      throw error;
    }
  }

  /** 停止并释放节点。 */
  async stop(): Promise<void> {
    const instance = this.#instance;
    this.#instance = undefined;
    this.#state = 'stopped';
    this.#connections = 0;
    this.#emit();

    if (instance !== undefined) {
      // 释放失败不影响本地状态清理。
      await instance.close().catch(() => undefined);
    }
  }

  /** 刷新状态（连接数会随中继连接建立而变化）。 */
  async refresh(): Promise<void> {
    if (this.#instance === undefined) {
      return;
    }
    try {
      const status = await this.#instance.status();
      this.#connections = status.connections;
      this.#state = status.state === 'running' ? 'running' : this.#state;
      this.#emit();
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
      this.#emit();
    }
  }

  /**
   * 通过隧道访问目标服务的 TCP 端口。
   *
   * 返回的流可用于自行收发数据；HTTP 层面的请求/响应编解码
   * 由调用方（tunnel-http.ts）负责。
   */
  async connectTcp(host: string, port: number): Promise<EasyTierTcpStream> {
    if (this.#instance === undefined) {
      throw new Error('浏览器节点尚未启动');
    }
    return this.#instance.connectTcp(`${host}:${port}`);
  }

  get running(): boolean {
    return this.#instance !== undefined && this.#state === 'running';
  }
}
