/**
 * 节点注册表（业务层门面）。
 *
 * 真正的实现位于基础层 src/db/node-heartbeat.ts —— 配置服务器
 * （同为基础层）需要直接调用它，若实现放在本文件就会形成
 * 「基础层 -> 业务层」的反向依赖。
 *
 * 本文件保留给业务层与接入层使用，保证调用点语义清晰。
 */

export { recordHeartbeat, listNodes, type HeartbeatInput } from '../db/node-heartbeat.js';
