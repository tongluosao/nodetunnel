/**
 * DataChannel 上的行分帧。
 *
 * 为什么用换行分帧：
 *   DataChannel 保序，但不保证「一次 send 对应一次 message」——
 *   收到的一条消息未必恰好是一次逻辑写入，也可能多个逻辑消息
 *   被合并到一条消息里。因此必须自己划边界。
 *
 * 为什么选「换行 + JSON」而不是二进制长度头：
 *   中继路径（WebSocket）天然以消息为边界，用 JSON 报文；
 *   让 P2P 也走同样的 JSON 报文，主机端就只需要**一份**请求
 *   处理逻辑，不必为 P2P 再写一套二进制协议与解析。
 *   代价是 base64 约 33% 的体积开销，对穿透场景可以接受。
 *
 * 这是纯函数模块，不依赖浏览器 API，可直接在 node 环境测试。
 */

/** 分帧分隔符。 */
export const FRAME_DELIMITER = '\n';

/**
 * 增量式行切分器。
 *
 * 喂入任意切分的文本，吐出其中所有完整的行（不含分隔符）。
 * 不完整的尾部留在内部缓冲里，等下次喂入。
 */
export class LineSplitter {
  private buffer = '';

  /** 喂入一段文本，返回其中所有完整的行。 */
  push(text: string): string[] {
    this.buffer += text;

    const lines: string[] = [];
    let index = this.buffer.indexOf(FRAME_DELIMITER);

    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      // 空行不产出 —— 双换行或前导换行都不该被当成一条消息。
      if (line !== '') {
        lines.push(line);
      }
      index = this.buffer.indexOf(FRAME_DELIMITER);
    }

    return lines;
  }

  /** 缓冲区中尚未成行的字符数。 */
  get pending(): number {
    return this.buffer.length;
  }

  /** 清空缓冲，丢弃未完成的行。 */
  reset(): void {
    this.buffer = '';
  }
}

/** 把一条消息编码成可发送的一行。 */
export function encodeLine(payload: unknown): string {
  return `${JSON.stringify(payload)}${FRAME_DELIMITER}`;
}
