import { describe, expect, it } from 'vitest';

import { parseResponse } from '../src/easytier/tunnel-http';

/**
 * HTTP/1.1 响应解析。
 *
 * 这段逻辑在浏览器侧处理来自隧道内服务的原始字节，
 * 直接决定页面能否正确渲染目标服务，因此需要完整覆盖。
 */

function respond(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('parseResponse', () => {
  it('解析状态行与响应头', () => {
    const response = parseResponse(
      respond('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nServer: test\r\n\r\nhi'),
    );

    expect(response.status).toBe(200);
    expect(response.statusText).toBe('OK');
    expect(response.headers['content-type']).toBe('text/html');
    expect(response.headers.server).toBe('test');
    expect(new TextDecoder().decode(response.body)).toBe('hi');
  });

  it('响应头名统一转为小写，便于大小写无关查找', () => {
    const response = parseResponse(respond('HTTP/1.1 200 OK\r\nX-Custom-Header: v\r\n\r\n'));
    expect(response.headers['x-custom-header']).toBe('v');
  });

  it('同名响应头以逗号合并', () => {
    const response = parseResponse(
      respond('HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n'),
    );
    expect(response.headers['set-cookie']).toBe('a=1, b=2');
  });

  it('按 Content-Length 截断响应体，忽略多余字节', () => {
    const response = parseResponse(
      respond('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhelloEXTRA'),
    );
    expect(new TextDecoder().decode(response.body)).toBe('hello');
  });

  it('解码分块传输编码', () => {
    const response = parseResponse(
      respond(
        'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n',
      ),
    );
    expect(new TextDecoder().decode(response.body)).toBe('hello world');
  });

  it('支持带扩展的分块长度写法', () => {
    const response = parseResponse(
      respond('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4;ext=1\r\nabcd\r\n0\r\n\r\n'),
    );
    expect(new TextDecoder().decode(response.body)).toBe('abcd');
  });

  it('缺少 Content-Length 与 chunked 时读到结尾为止', () => {
    const response = parseResponse(respond('HTTP/1.1 200 OK\r\n\r\ntail-data'));
    expect(new TextDecoder().decode(response.body)).toBe('tail-data');
  });

  it('解析 204 与各类状态码', () => {
    expect(parseResponse(respond('HTTP/1.1 204 No Content\r\n\r\n')).status).toBe(204);
    expect(parseResponse(respond('HTTP/1.1 404 Not Found\r\n\r\n')).status).toBe(404);
    expect(parseResponse(respond('HTTP/1.1 500 Internal Server Error\r\n\r\n')).status).toBe(500);
  });

  it('状态行允许无原因短语', () => {
    const response = parseResponse(respond('HTTP/1.1 200 \r\n\r\n'));
    expect(response.status).toBe(200);
    expect(response.statusText).toBe('');
  });

  it('缺少头部结束标记时报错', () => {
    expect(() => parseResponse(respond('HTTP/1.1 200 OK'))).toThrow(/未找到 HTTP 头部结束标记/);
  });

  it('状态行非法时报错', () => {
    expect(() => parseResponse(respond('NOT-HTTP\r\n\r\n'))).toThrow(/状态行无法解析/);
  });

  it('分块长度非法时报错', () => {
    expect(() =>
      parseResponse(
        respond('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\ndata\r\n0\r\n\r\n'),
      ),
    ).toThrow(/块长度无法解析/);
  });

  it('分块数据不完整时报错', () => {
    expect(() =>
      parseResponse(respond('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nff\r\nab\r\n')),
    ).toThrow(/块数据不完整/);
  });

  it('能处理 UTF-8 中文响应体', () => {
    const body = '来自隧道内的中文内容';
    const encoded = new TextEncoder().encode(body);
    const head = new TextEncoder().encode(
      `HTTP/1.1 200 OK\r\nContent-Length: ${encoded.byteLength}\r\n\r\n`,
    );
    const merged = new Uint8Array(head.byteLength + encoded.byteLength);
    merged.set(head, 0);
    merged.set(encoded, head.byteLength);

    const response = parseResponse(merged);
    expect(new TextDecoder().decode(response.body)).toBe(body);
  });
});
