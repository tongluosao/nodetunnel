import { CONFIG_SERVER_PATH } from '@nodetunnel/shared';
import {
  RpcErrorCode,
  RpcMethod,
  isJsonRpcRequest,
  normalizeHeartbeat,
  rpcFailure,
  rpcSuccess,
  type GetFeatureResponse,
  type HeartbeatResponse,
} from '@nodetunnel/protocol';

import type { Env } from '../env.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { recordHeartbeat } from '../db/node-heartbeat.js';

/**
 * EasyTier 配置服务器（需求 1.3）。
 *
 * 普通 EasyTier 客户端通过 `--config-server wss://<host>${CONFIG_SERVER_PATH}`
 * 接入，本服务负责：
 *   1. 接受 WebSocket 升级并保持长连接；
 *   2. 响应 Heartbeat / GetFeature RPC（协议见 @nodetunnel/protocol/config-server.ts）；
 *   3. 把节点上报信息写入数据库，供管理后台展示。
 *
 * 注意：本服务不主动推送配置。客户端通过 REST 端点
 * （/api/v1/machines/:machine-id/networks/config/:inst-id）拉取配置，
 * 该端点在 admin 路由中实现，与 easytier-web 的接口保持一致。
 */

interface HeartbeatParams {
  machine_id: string;
  inst_id: string;
  easytier_version?: string;
  hostname?: string;
  running_network_instances?: string[];
}

export async function handleConfigServer(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname !== CONFIG_SERVER_PATH) {
    return new Response('Not found', { status: 404 });
  }

  const upgrade = request.headers.get('Upgrade');
  if (upgrade?.toLowerCase() !== 'websocket') {
    // 非 WebSocket 请求用于健康探测，返回服务能力描述。
    return Response.json({
      ok: true,
      service: 'nodetunnel-config-server',
      version: env.NODETUNNEL_VERSION,
      methods: [RpcMethod.Heartbeat, RpcMethod.GetFeature],
    });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];

  server.accept();

  server.addEventListener('message', (event) => {
    void handleMessage(event.data, server, env).catch((error: unknown) => {
      logger.error('config_server_message_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  server.addEventListener('error', () => {
    logger.warn('config_server_socket_error');
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function handleMessage(data: unknown, socket: WebSocket, env: Env): Promise<void> {
  if (typeof data !== 'string') {
    socket.send(
      JSON.stringify(rpcFailure(null, RpcErrorCode.InvalidRequest, '仅支持 JSON 文本帧')),
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    socket.send(JSON.stringify(rpcFailure(null, RpcErrorCode.ParseError, 'JSON 解析失败')));
    return;
  }

  if (!isJsonRpcRequest(parsed)) {
    socket.send(
      JSON.stringify(rpcFailure(null, RpcErrorCode.InvalidRequest, '不是合法的 JSON-RPC 2.0 请求')),
    );
    return;
  }

  const { id, method, params } = parsed;

  switch (method) {
    case RpcMethod.GetFeature: {
      const result: GetFeatureResponse = { support_encryption: true };
      socket.send(JSON.stringify(rpcSuccess(id, result)));
      return;
    }

    case RpcMethod.Heartbeat: {
      const heartbeat = normalizeHeartbeat(params);
      if (heartbeat === undefined) {
        socket.send(
          JSON.stringify(rpcFailure(id, RpcErrorCode.InvalidParams, '缺少 machine_id 或 inst_id')),
        );
        return;
      }

      await recordHeartbeatSafely(env, heartbeat);

      const result: HeartbeatResponse = {};
      socket.send(JSON.stringify(rpcSuccess(id, result)));
      return;
    }

    default:
      socket.send(
        JSON.stringify(rpcFailure(id, RpcErrorCode.MethodNotFound, `未知方法: ${method}`)),
      );
  }
}

/**
 * 记录心跳。
 *
 * 心跳写库失败不应导致客户端断连：客户端会周期重发，
 * 因此这里吞掉异常并记录日志，保持连接可用。
 */
async function recordHeartbeatSafely(env: Env, heartbeat: HeartbeatParams): Promise<void> {
  try {
    await recordHeartbeat(env, heartbeat);
  } catch (error) {
    logger.warn('heartbeat_record_failed', {
      instanceId: heartbeat.inst_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 供测试引用：把内部错误转换为配置服务器的错误语义。 */
export function configServerError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  return new AppError(ErrorCode.INTERNAL_ERROR);
}
