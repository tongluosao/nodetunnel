import { describe, expect, it } from 'vitest';
import { LineSplitter, encodeLine } from '../src/transport/line-framing.js';
import { chunkBytes, mergeChunks } from '../src/transport/transport.js';
import { buildRequestBytes, findHeaderEnd, parseResponse } from '../src/http/messages.js';

/**
 * 门户纯逻辑测试。
 *
 * 覆盖分帧、分片与 HTTP 报文解析 —— 这三处出错会表现为
 * 「数据丢失」或「响应错乱」，联调时极难定位，因此钉牢边界条件。
 */

describe('行分帧', () => {
  it('单行一次喂入可以解出', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\n')).toEqual(['{"a":1}']);
    expect(splitter.pending).toBe(0);
  });

  it('逐字符喂入仍能正确解出', () => {
    // 真实链路不保证「一次 send 对应一次 message」，必须能处理任意切分。
    const splitter = new LineSplitter();
    const text = '{"hello":"world"}\n';
    const lines: string[] = [];
    for (const char of text) {
      lines.push(...splitter.push(char));
    }
    expect(lines).toEqual(['{"hello":"world"}']);
  });

  it('多行粘在一次喂入可以全部解出', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('a\nb\nc\n')).toEqual(['a', 'b', 'c']);
  });

  it('半行留在缓冲中，不误判为完整消息', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"partial"')).toEqual([]);
    expect(splitter.pending).toBe(10);
    expect(splitter.push(':true}\n')).toEqual(['{"partial":true}']);
  });

  it('空行被忽略，不会产出空消息', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('\n\n\na\n')).toEqual(['a']);
  });

  it('中文与转义字符按字符边界切分不损坏', () => {
    const splitter = new LineSplitter();
    const payload = { message: '中文载荷测试', path: '/a/b?c=1&d=中文' };
    const lines = splitter.push(encodeLine(payload));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual(payload);
  });

  it('reset 丢弃未完成的行', () => {
    const splitter = new LineSplitter();
    splitter.push('{"incomplete"');
    splitter.reset();
    expect(splitter.pending).toBe(0);
    expect(splitter.push('{"fresh":1}\n')).toEqual(['{"fresh":1}']);
  });
});

describe('分片', () => {
  it('空输入不产生分片', () => {
    expect(chunkBytes(new Uint8Array(0))).toHaveLength(0);
  });

  it('分片后合并能还原原始字节', () => {
    const original = new Uint8Array(40_000);
    for (let index = 0; index < original.length; index += 1) {
      original[index] = index % 251;
    }
    const merged = mergeChunks(chunkBytes(original));
    expect(Array.from(merged)).toEqual(Array.from(original));
  });

  it('多字节 UTF-8 跨分片边界不会损坏', () => {
    // 中文按字节切分时可能把一个字符切在两片之间，按字节合并必须无损。
    const text = '中文载荷测试'.repeat(3000);
    const original = new TextEncoder().encode(text);
    expect(new TextDecoder().decode(mergeChunks(chunkBytes(original)))).toBe(text);
  });
});

describe('HTTP 请求构造', () => {
  it('自动补 Host、Connection 与 User-Agent', () => {
    const bytes = buildRequestBytes({ method: 'GET', path: '/', hostHeader: 'example.local' });
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('GET / HTTP/1.1\r\n')).toBe(true);
    expect(text).toContain('Host: example.local');
    expect(text).toContain('Connection: close');
  });

  it('有请求体时自动补 Content-Length', () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const bytes = buildRequestBytes({
      method: 'POST',
      path: '/submit',
      hostHeader: 'x',
      body,
    });
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('Content-Length: 4');
    // 体必须真的被拼在头部之后。
    expect(bytes.byteLength).toBeGreaterThan(body.byteLength);
  });

  it('方法被规范化为大写', () => {
    const bytes = buildRequestBytes({ method: 'get', path: '/', hostHeader: 'x' });
    expect(new TextDecoder().decode(bytes).startsWith('GET ')).toBe(true);
  });
});

describe('HTTP 响应解析', () => {
  const encoder = new TextEncoder();

  it('解析 Content-Length 响应', () => {
    const raw = encoder.encode('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello');
    const result = parseResponse(raw);
    expect(result.complete).toBe(true);
    expect(result.response.status).toBe(200);
    expect(new TextDecoder().decode(result.response.body)).toBe('hello');
  });

  it('体未收全时标记为未完成', () => {
    // 调用方据此决定继续读，而不是把残缺响应当完整响应使用。
    const raw = encoder.encode('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nhello');
    const result = parseResponse(raw);
    expect(result.complete).toBe(false);
  });

  it('解析 chunked 响应', () => {
    const raw = encoder.encode(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n',
    );
    const result = parseResponse(raw);
    expect(result.complete).toBe(true);
    expect(new TextDecoder().decode(result.response.body)).toBe('hello world');
  });

  it('chunked 数据不完整时不误判为完成', () => {
    const raw = encoder.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel');
    expect(parseResponse(raw).complete).toBe(false);
  });

  it('头部未结束时抛错', () => {
    expect(() => parseResponse(encoder.encode('HTTP/1.1 200 OK'))).toThrow(/未找到 HTTP 头部/);
  });

  it('状态行畸形时抛错', () => {
    expect(() => parseResponse(encoder.encode('GARBAGE\r\n\r\n'))).toThrow(/状态行无法解析/);
  });

  it('同名头以逗号合并', () => {
    const raw = encoder.encode('HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n');
    const result = parseResponse(raw);
    expect(result.response.headers['set-cookie']).toBe('a=1, b=2');
  });

  it('findHeaderEnd 定位头部结束位置', () => {
    const raw = encoder.encode('HTTP/1.1 200 OK\r\n\r\nbody');
    // "HTTP/1.1 200 OK" 长 15，其后是 \r\n\r\n
    expect(findHeaderEnd(raw)).toBe(15);
  });
});
