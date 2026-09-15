/**
 * 阶段 0 验证：Node 侧能否用 werift 建立 DataChannel 并可靠传输字节。
 *
 * 这是 WebRTC 重构方案的地基。若本脚本失败，方案不成立。
 *
 * 经实测确认的 werift API（与浏览器显著不同，容易踩坑）：
 *   - 事件用 EventEmitter 风格 `dc.on(name, fn)`，事件名为小写：
 *     'open' / 'close' / 'message' / 'error'；
 *   - 另有 `dc.stateChange.subscribe()` 可用（Event 对象）；
 *   - `dc.onopen` / `dc.onmessage` 在订阅前是 undefined，不能直接访问；
 *   - 'message' 事件的载荷是包装对象而非裸 Buffer，必须显式适配。
 *
 * 用法：
 *   cd scripts/poc && pnpm install && node verify-datachannel.mjs
 */
import { RTCPeerConnection } from 'werift';

const TIMEOUT_MS = 20_000;

/**
 * 默认使用国内 STUN。
 *
 * 不使用 Google STUN：在国内网络下它常被 DNS 劫持或代理 TUN 接管，
 * 表现为解析到 198.18.x.x 保留地址且 UDP 无响应，导致验证结果失真。
 */
const ICE_SERVERS = [
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
];

function withTimeout(promise, label, ms = TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    }),
  ]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 把 'message' 事件的载荷统一转成 Buffer。
 *
 * 实测该事件传入的是包装对象，因此逐个候选字段尝试；
 * 全部失败时抛错并列出实际字段名，便于上游库升级后快速定位。
 */
function extractPayload(event) {
  if (Buffer.isBuffer(event)) return event;
  if (event instanceof ArrayBuffer) return Buffer.from(event);
  if (ArrayBuffer.isView(event)) {
    return Buffer.from(event.buffer, event.byteOffset, event.byteLength);
  }
  for (const key of ['data', 'message', 'buffer', 'payload', 'value', 'chunk']) {
    const candidate = event?.[key];
    if (Buffer.isBuffer(candidate)) return candidate;
    if (candidate instanceof ArrayBuffer) return Buffer.from(candidate);
    if (ArrayBuffer.isView(candidate)) {
      return Buffer.from(candidate.buffer, candidate.byteOffset, candidate.byteLength);
    }
    if (typeof candidate === 'string') return Buffer.from(candidate);
  }
  const fields = Object.keys(event ?? {});
  throw new Error(`无法从 message 事件中取出载荷，实际字段: ${fields.join(', ')}`);
}

/** 等待 DataChannel 打开。 */
function waitForOpen(channel, label) {
  if (channel.readyState === 'open') return Promise.resolve();
  return withTimeout(
    new Promise((resolve) => {
      channel.on('open', () => resolve());
      channel.stateChange?.subscribe?.((state) => {
        if (state === 'open') resolve();
      });
    }),
    label,
  );
}

/** 轮询等待条件成立，避免依赖不明确的事件时序。 */
async function waitUntil(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  throw new Error(`${label} 超时（${timeoutMs}ms）`);
}

function summarizeCandidates(description) {
  const lines = (description?.sdp ?? '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('a=candidate'));
  const byType = {};
  for (const line of lines) {
    const type = line.split(' ')[7] ?? 'unknown';
    byType[type] = (byType[type] ?? 0) + 1;
  }
  return { lines, byType };
}

async function main() {
  console.log('=== Node 侧 WebRTC DataChannel 验证 ===\n');
  const failures = [];

  console.log('[1/6] 创建 RTCPeerConnection 与 DataChannel…');
  const offerer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const answerer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const outbound = offerer.createDataChannel('nodetunnel', { ordered: true });
  console.log('      OK');

  const received = [];
  let inbound = null;
  const inboundSeen = new Promise((resolve) => {
    answerer.onDataChannel.subscribe((channel) => {
      inbound = channel;
      channel.on('message', (event) => received.push(extractPayload(event)));
      resolve();
    });
  });

  console.log('[2/6] 交换 SDP 并收集 ICE…');
  await offerer.setLocalDescription(await offerer.createOffer());
  await sleep(1500);
  await answerer.setRemoteDescription(offerer.localDescription);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await sleep(1500);
  await offerer.setRemoteDescription(answerer.localDescription);

  const summary = summarizeCandidates(offerer.localDescription);
  console.log(`      OK（候选 ${summary.lines.length} 条：${JSON.stringify(summary.byType)}）`);

  console.log('[3/6] 等待连接与通道就绪…');
  await withTimeout(inboundSeen, 'answerer onDataChannel');
  await waitForOpen(outbound, 'offerer DataChannel 打开');
  await waitForOpen(inbound, 'answerer DataChannel 打开');
  console.log(`      OK（connectionState=${offerer.connectionState}）`);

  console.log('[4/6] 正向传输 offerer -> answerer…');
  const payloads = [
    Buffer.from('hello-nodetunnel'),
    Buffer.from('中文载荷测试'),
    Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]),
  ];
  for (const payload of payloads) outbound.send(payload);
  await waitUntil(() => received.length >= payloads.length, '接收正向载荷');

  for (let index = 0; index < payloads.length; index += 1) {
    const ok = received[index]?.equals(payloads[index]) ?? false;
    console.log(`      #${index}: ${ok ? '一致' : '不一致'}`);
    if (!ok) failures.push(`正向载荷 #${index} 不一致`);
  }

  console.log('[5/6] 反向传输 answerer -> offerer…');
  let backReceived = null;
  outbound.on('message', (event) => {
    backReceived = extractPayload(event);
  });
  const backPayload = Buffer.from('reply-from-answerer');
  inbound.send(backPayload);
  await waitUntil(() => backReceived !== null, '接收反向载荷');
  const backOk = backReceived.equals(backPayload);
  console.log(`      ${backOk ? '一致' : '不一致'}`);
  if (!backOk) failures.push('反向载荷不一致');

  console.log('[6/6] 大载荷分片（1 MiB，模拟 HTTP 响应体）…');
  // 方向：answerer -> offerer，对应「服务端把响应体回给浏览器」的真实数据流。
  // 注意监听端必须是 outbound（offerer 侧），发送端才是 inbound。
  // 若在同一个通道端点上既 send 又 on('message')，数据会发往对端，本端永远收不到。
  let bigBytes = 0;
  let bigChunks = 0;
  outbound.on('message', (event) => {
    bigBytes += extractPayload(event).length;
    bigChunks += 1;
  });

  // 分片上限 16 KiB：单条 SCTP 消息超过 64 KiB 会被库直接拒绝
  // （抛出 max-message-size exceeded），因此实现时必须自行分片。
  const BIG = 1024 * 1024;
  const CHUNK = 16 * 1024;
  let sent = 0;
  for (let offset = 0; offset < BIG; offset += CHUNK) {
    inbound.send(Buffer.alloc(Math.min(CHUNK, BIG - offset), 0x5a));
    sent += 1;
  }
  await waitUntil(() => bigBytes >= BIG, '接收大载荷', 30_000);
  console.log(`      发送 ${sent} 片，收到 ${bigChunks} 片 / ${bigBytes} 字节`);
  if (bigBytes !== BIG) failures.push(`大载荷不完整：${bigBytes}/${BIG}`);

  outbound.close();
  offerer.close();
  answerer.close();

  if (failures.length > 0) {
    console.log('\n=== 结果：失败 ===');
    for (const item of failures) console.log(`  - ${item}`);
    process.exit(1);
  }
  console.log('\n=== 结果：通过 ===');
  process.exit(0);
}

main().catch((error) => {
  console.error('\n=== 结果：失败 ===');
  console.error(error);
  process.exit(1);
});
