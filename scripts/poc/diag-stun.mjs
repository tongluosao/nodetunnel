/**
 * STUN 可用性与 NAT 类型诊断。
 *
 * 用途：
 *   1. 探测各 STUN 服务器是否可达，并识别被代理 TUN 劫持的情况；
 *   2. 通过对比同一本地 socket 对不同目标的公网映射，
 *      判断出口 NAT 类型 —— 这是评估 P2P 打洞成功率的决定性依据。
 *
 * 判定规则：
 *   - 多个目标得到同一 IP 与同一端口 → 锥形 NAT（Cone），打洞成功率高；
 *   - 多个目标得到同一 IP 但端口不同 → 对称 NAT（NAT4），打洞成功率低；
 *   - 多个目标得到不同 IP          → 多出口，打洞基本不可行。
 *
 * 用法：
 *   cd scripts/poc && pnpm install && node diag-stun.mjs
 *
 * 说明：只做诊断，不修改任何系统配置，也不产生副作用。
 */
import { RTCPeerConnection } from 'werift';
import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';

/** 国内可用的公共 STUN 服务器。国外服务器在国内常被劫持，不列入默认清单。 */
const STUN_SERVERS = [
  'stun.miwifi.com:3478',
  'stun.chat.bilibili.com:3478',
  'stun.hitv.com:3478',
  'stun.cdnbye.com:3478',
  'stun.douyucdn.cn:18000',
];

/** 用于识别代理 TUN 的保留网段（RFC 2544，常见于 Clash/Meta 等工具的假 IP 池）。 */
const PROXY_FAKE_IP_PREFIXES = ['198.18.', '198.19.'];

/** 构造最小 STUN Binding Request（RFC 5389）。 */
function buildStunRequest() {
  const buffer = Buffer.alloc(20);
  buffer.writeUInt16BE(0x0001, 0); // Binding Request
  buffer.writeUInt16BE(0x0000, 2); // message length
  buffer.writeUInt32BE(0x2112a442, 4); // magic cookie
  for (let index = 8; index < 20; index += 1) {
    buffer[index] = Math.floor(Math.random() * 256);
  }
  return buffer;
}

/** 解析 XOR-MAPPED-ADDRESS / MAPPED-ADDRESS，返回公网 IP:端口。 */
function parseMappedAddress(message) {
  if (message.length < 20 || message.readUInt16BE(0) !== 0x0101) return null;

  let offset = 20;
  const end = Math.min(20 + message.readUInt16BE(2), message.length);

  while (offset + 4 <= end) {
    const attributeType = message.readUInt16BE(offset);
    const attributeLength = message.readUInt16BE(offset + 2);
    const valueStart = offset + 4;

    // 0x0020 = XOR-MAPPED-ADDRESS，0x0001 = MAPPED-ADDRESS（旧式，未异或）
    if (
      (attributeType === 0x0020 || attributeType === 0x0001) &&
      message[valueStart + 1] === 0x01 // IPv4
    ) {
      const rawPort = message.readUInt16BE(valueStart + 2);
      const rawIp = message.readUInt32BE(valueStart + 4);
      const isXor = attributeType === 0x0020;
      const port = isXor ? rawPort ^ 0x2112 : rawPort;
      const ip = isXor ? (rawIp ^ 0x2112a442) >>> 0 : rawIp;
      return {
        address: `${(ip >>> 24) & 0xff}.${(ip >>> 16) & 0xff}.${(ip >>> 8) & 0xff}.${ip & 0xff}`,
        port,
      };
    }

    // 属性按 4 字节对齐。
    offset = valueStart + attributeLength + ((4 - (attributeLength % 4)) % 4);
  }
  return null;
}

function isProxyFakeIp(address) {
  return PROXY_FAKE_IP_PREFIXES.some((prefix) => address.startsWith(prefix));
}

/** 裸 UDP 探测单个 STUN 服务器。 */
async function probeServer(host, port, timeoutMs = 4000) {
  let address;
  try {
    address = (await lookup(host, { family: 4 })).address;
  } catch (error) {
    return { ok: false, stage: 'dns', reason: error.code ?? error.message };
  }

  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // 重复关闭可忽略。
      }
      resolve({ address, ...payload });
    };

    const timer = setTimeout(
      () => finish({ ok: false, stage: 'udp', reason: '超时无响应' }),
      timeoutMs,
    );

    socket.on('error', (error) => finish({ ok: false, stage: 'udp', reason: error.message }));
    socket.on('message', (message) => {
      const mapped = parseMappedAddress(message);
      finish({ ok: mapped !== null, stage: 'done', mapped, bytes: message.length });
    });
    socket.send(buildStunRequest(), port, address, (error) => {
      if (error) finish({ ok: false, stage: 'send', reason: error.message });
    });
  });
}

/** 用 werift 收集某个 STUN 服务器下产生的 srflx 候选。 */
async function gatherSrflx(stunTarget) {
  const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:${stunTarget}` }] });
  peer.createDataChannel('stun-probe', { ordered: true });
  await peer.setLocalDescription(await peer.createOffer());

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 6000);
    peer.iceGatheringStateChange.subscribe((state) => {
      if (state === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const candidates = (peer.localDescription?.sdp ?? '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('a=candidate'));

  const srflx = candidates
    .filter((line) => line.split(' ')[7] === 'srflx')
    .map((line) => {
      const parts = line.split(' ');
      return `${parts[4]}:${parts[5]}`;
    });

  peer.close();
  return { total: candidates.length, srflx };
}

async function main() {
  console.log('=== STUN 可用性与 NAT 类型诊断 ===\n');

  console.log('[1] 逐个探测 STUN 服务器');
  const reachable = [];
  for (const target of STUN_SERVERS) {
    const [host, portText] = target.split(':');
    const result = await probeServer(host, Number(portText));

    if (result.ok) {
      console.log(
        `    可达 ${target.padEnd(32)} [${result.address}]` +
          ` -> 公网映射 ${result.mapped.address}:${result.mapped.port}`,
      );
      reachable.push(target);
    } else {
      const hijacked = result.address !== undefined && isProxyFakeIp(result.address);
      const hint = hijacked ? ' ← 被代理 TUN 劫持（假 IP），请将 STUN 加入直连规则' : '';
      console.log(
        `    失败 ${target.padEnd(32)} [${result.address ?? '-'}] ${result.stage}: ${result.reason}${hint}`,
      );
    }
  }

  console.log(`\n    合计可达 ${reachable.length} / ${STUN_SERVERS.length} 个`);

  if (reachable.length === 0) {
    console.log('\n=== 结论：无可用 STUN 服务器，无法判定 NAT 类型 ===');
    console.log('建议：检查代理/防火墙是否拦截 UDP，或换一个网络环境重试。');
    process.exit(1);
  }

  console.log('\n[2] 用 werift 收集 srflx 候选，判定 NAT 类型');
  const observations = [];
  for (const target of reachable.slice(0, 3)) {
    const { total, srflx } = await gatherSrflx(target);
    console.log(`    经由 ${target}: 候选 ${total} 条，其中 srflx ${srflx.length} 条`);
    for (const endpoint of srflx) {
      console.log(`      ${endpoint}`);
      observations.push(endpoint);
    }
  }

  if (observations.length === 0) {
    console.log('\n=== 结论：未能产出 srflx 候选 ===');
    console.log('网络可达但库未取得公网映射，需排查 STUN 实现。');
    process.exit(1);
  }

  const ips = new Set(observations.map((item) => item.split(':')[0]));
  const endpoints = new Set(observations);

  console.log('\n[3] NAT 类型判定');
  console.log(`    观察到 ${observations.length} 个公网映射，涉及 ${ips.size} 个出口 IP`);
  console.log(`    出口 IP: ${[...ips].join(', ')}`);

  console.log('\n=== 结论 ===');
  if (ips.size > 1) {
    console.log('    多出口 IP —— 不同目标走不同出口，P2P 打洞基本不可行。');
    console.log('    建议以中继为主路径，P2P 仅作为可选优化。');
    process.exit(0);
  }
  if (endpoints.size > 1) {
    console.log('    端口随目标变化 —— 符合对称 NAT（NAT4）特征。');
    console.log('    打洞成功率低：对端无法预测本端映射端口，回落中继会是常态。');
    process.exit(0);
  }
  console.log('    端口稳定 —— 符合锥形 NAT（Cone）特征。');
  console.log('    打洞成功率较高，P2P 可作为主路径。');
  process.exit(0);
}

main().catch((error) => {
  console.error('\n诊断失败：');
  console.error(error);
  process.exit(1);
});
