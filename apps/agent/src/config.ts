/**
 * agent 配置。
 *
 * 通过命令行参数或环境变量提供，二者都可，命令行优先。
 */

export interface AgentConfig {
  /** Worker 的地址，例如 https://nodetunnel.example.workers.dev。 */
  server: string;
  /** 隧道接入令牌。 */
  token: string;
  /**
   * 允许入站的本地端口白名单。
   *
   * 这是本机唯一的安全边界。为空表示拒绝一切入站 —— 默认拒绝，
   * 不是「默认全开」。这样即使配置漏填，后果也只是「用不了」，
   * 而不是「内网被暴露」。
   */
  allowedPorts: number[];
  /** 本机可监听的端口探测列表，仅用于向服务端上报，不影响放行。 */
  hostname: string;
  /** 是否尝试 P2P（WebRTC）。失败会自动回落到中继。 */
  enableP2P: boolean;
}

export interface ParseResult {
  ok: true;
  config: AgentConfig;
}

export interface ParseError {
  ok: false;
  message: string;
}

/**
 * 解析命令行参数。
 *
 * 不引入第三方 CLI 库：参数只有五个，手写解析更透明，
 * 也避免为一个小工具增加依赖面。
 */
export function parseArgs(argv: string[]): ParseResult | ParseError {
  const flags = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) {
      return { ok: false, message: `无法识别的参数：${arg}` };
    }
    const [name, inlineValue] = arg.slice(2).split('=');
    if (name === undefined || name === '') {
      return { ok: false, message: `无法识别的参数：${arg}` };
    }
    // 支持 `--key=value` 与 `--key value` 两种写法。
    if (inlineValue !== undefined) {
      flags.set(name, inlineValue);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        flags.set(name, 'true');
      } else {
        flags.set(name, next);
        index += 1;
      }
    }
  }

  const server = (flags.get('server') ?? process.env.NT_SERVER ?? '').trim();
  const token = (flags.get('token') ?? process.env.NT_TOKEN ?? '').trim();
  const portsText = (flags.get('ports') ?? process.env.NT_PORTS ?? '').trim();
  const hostname = (flags.get('hostname') ?? process.env.NT_HOSTNAME ?? '').trim();
  const p2pFlag = (flags.get('p2p') ?? process.env.NT_P2P ?? 'true').trim();

  if (server === '') {
    return { ok: false, message: '缺少 --server（Worker 地址，例如 https://xxx.workers.dev）' };
  }
  if (token === '') {
    return { ok: false, message: '缺少 --token（隧道接入令牌）' };
  }

  let serverUrl: URL;
  try {
    serverUrl = new URL(server);
  } catch {
    return { ok: false, message: `--server 不是合法的 URL：${server}` };
  }
  if (serverUrl.protocol !== 'http:' && serverUrl.protocol !== 'https:') {
    return { ok: false, message: '--server 必须使用 http:// 或 https://' };
  }

  const ports = parsePorts(portsText);
  if (!ports.ok) {
    return ports;
  }

  return {
    ok: true,
    config: {
      server: serverUrl.toString().replace(/\/$/, ''),
      token,
      allowedPorts: ports.value,
      hostname: hostname === '' ? 'unknown' : hostname,
      enableP2P: p2pFlag !== 'false' && p2pFlag !== '0',
    },
  };
}

/** 解析端口列表。逗号或空白分隔。 */
function parsePorts(input: string): { ok: true; value: number[] } | ParseError {
  if (input === '') {
    // 不报错：显式留空表示「不放行任何端口」，是一个合法（且安全）的配置。
    return { ok: true, value: [] };
  }

  const ports: number[] = [];
  for (const part of input.split(/[,\s]+/)) {
    const text = part.trim();
    if (text === '') {
      continue;
    }
    const value = Number(text);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      return { ok: false, message: `端口必须是 1–65535 的整数：${text}` };
    }
    if (!ports.includes(value)) {
      ports.push(value);
    }
  }
  ports.sort((a, b) => a - b);
  return { ok: true, value: ports };
}

/** 把 HTTP(S) 地址转换为 WebSocket 地址。 */
export function toWebSocketUrl(server: string, path: string): string {
  const url = new URL(server);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = path;
  return url.toString();
}
