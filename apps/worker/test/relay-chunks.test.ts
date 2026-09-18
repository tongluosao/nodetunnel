import { describe, expect, it } from 'vitest';

import { RelayAccumulator } from '../src/signaling/relay-chunks.js';

/**
 * 中继分片合并测试。
 *
 * 这里守护的是一个曾经真实发生过的缺陷：响应头只随第一个分片到达，
 * 若在收尾时取「最后一条消息」的头，就会得到空对象 → Content-Type 丢失。
 * 再叠加房间强制写入的 `X-Content-Type-Options: nosniff`，浏览器会以
 * 「MIME type ('') is not executable」直接拒绝执行脚本。
 *
 * 因为分片阈值是 16 KiB，任何真实的前端资源（JS / CSS / 图片）都会命中，
 * 所以这条不变式必须被测试钉死，而不能只靠人工回归。
 */

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('RelayAccumulator 分片合并', () => {
  it('合并多个分片，顺序保持不变', () => {
    const acc = new RelayAccumulator();
    acc.push(utf8('aaa'));
    acc.push(utf8('bbb'));
    acc.push(utf8('ccc'));

    expect(new TextDecoder().decode(acc.merge())).toBe('aaabbbccc');
    expect(acc.byteLength).toBe(9);
  });

  it('空分片不计入长度，但也不影响结果', () => {
    // 空响应体只发一个 last 帧，因此必须能正确处理长度为 0 的分片。
    const acc = new RelayAccumulator();
    acc.push(new Uint8Array(0));
    expect(acc.byteLength).toBe(0);
    expect(acc.merge().byteLength).toBe(0);

    acc.push(utf8('x'));
    acc.push(new Uint8Array(0));
    expect(new TextDecoder().decode(acc.merge())).toBe('x');
  });

  it('没有分片时合并为空数组，不抛异常', () => {
    const acc = new RelayAccumulator();
    expect(acc.merge().byteLength).toBe(0);
  });

  it('跨分片还原二进制内容，不因分片边界损坏字节', () => {
    // 按 3 字节切分一段 0..255 的字节序列，验证合并后与原序列逐字节相等。
    const original = new Uint8Array(256);
    for (let i = 0; i < original.length; i += 1) {
      original[i] = i;
    }
    const acc = new RelayAccumulator();
    for (let offset = 0; offset < original.length; offset += 3) {
      acc.push(original.subarray(offset, Math.min(offset + 3, original.length)));
    }

    const merged = acc.merge();
    expect(merged.byteLength).toBe(256);
    expect(Array.from(merged)).toEqual(Array.from(original));
  });
});

describe('RelayAccumulator 响应头捕获（防止 MIME 丢失）', () => {
  it('保留首片的响应头，即使后续分片不带头', () => {
    // 这正是线上缺陷的形态：只有第 0 个分片带头，其余分片 headers 为 undefined。
    const acc = new RelayAccumulator();
    acc.captureHeaders({ 'content-type': 'application/javascript' });
    acc.push(utf8('part1'));
    acc.captureHeaders(undefined);
    acc.push(utf8('part2'));
    acc.captureHeaders(undefined);

    expect(acc.headers()['content-type']).toBe('application/javascript');
  });

  it('首片头不会被后续分片的残缺头覆盖', () => {
    // 后续分片若意外带了头（例如只有 content-length），不能把首片的
    // Content-Type 冲掉 —— 否则同样会触发 MIME 拒绝。
    const acc = new RelayAccumulator();
    acc.captureHeaders({ 'content-type': 'text/css', 'content-length': '100' });
    acc.captureHeaders({ 'content-length': '50' });

    expect(acc.headers()['content-type']).toBe('text/css');
    expect(acc.headers()['content-length']).toBe('100');
  });

  it('从未收到响应头时返回空对象而不是 undefined', () => {
    // 返回值会直接交给 Response 构造，返回 undefined 会抛类型错误。
    const acc = new RelayAccumulator();
    expect(acc.headers()).toEqual({});
  });

  it('分片顺序不影响头的捕获结果', () => {
    // 头与体到达顺序在实现上不应成为隐含依赖。
    const acc = new RelayAccumulator();
    acc.push(utf8('body'));
    acc.captureHeaders({ 'content-type': 'image/png' });
    expect(acc.headers()['content-type']).toBe('image/png');
  });
});
