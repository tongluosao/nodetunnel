import { describe, expect, it } from 'vitest';
import { validateRouteHostname } from '@nodetunnel/shared';

import { normalizeHostname } from '../src/nodetunnel/host-routing.js';

/**
 * 专属域名的校验与归一化。
 *
 * 这两段逻辑共同决定「一个请求落到哪条路由」。判错方向很关键：
 *   - 校验过宽 → 管理员能把管理后台自己的域名绑给应用，直接把自己锁在门外；
 *   - 归一化漏剥端口 → 配了域名却永远匹配不上，表现为「明明配了还是首页」。
 * 因此这里同时守护「拒绝什么」与「如何比较」。
 */

describe('validateRouteHostname 拒绝非法输入', () => {
  it('拒绝 IP 字面量', () => {
    // IP 无法用于域名分发，且会与 Worker 自身地址混淆。
    for (const input of ['127.0.0.1', '192.168.1.10', '10.0.0.1']) {
      expect(validateRouteHostname(input).ok).toBe(false);
    }
  });

  it('拒绝带端口、协议或路径', () => {
    // 端口在运行时由 Host 头剥离，写进配置只会造成「配了却匹配不上」。
    for (const input of ['a.example.com:8080', 'http://a.example.com', 'a.example.com/x', 'a b']) {
      expect(validateRouteHostname(input).ok).toBe(false);
    }
  });

  it('拒绝空值、超长域名与非法标签', () => {
    expect(validateRouteHostname('').ok).toBe(false);
    expect(validateRouteHostname('   ').ok).toBe(false);
    expect(validateRouteHostname(`${'a'.repeat(250)}.com`).ok).toBe(false);
    expect(validateRouteHostname('-bad.example.com').ok).toBe(false);
    expect(validateRouteHostname('bad-.example.com').ok).toBe(false);
    expect(validateRouteHostname('bad_label.example.com').ok).toBe(false);
    expect(validateRouteHostname('a..b').ok).toBe(false);
  });

  it('拒绝非字符串', () => {
    expect(validateRouteHostname(123).ok).toBe(false);
    expect(validateRouteHostname(null).ok).toBe(false);
    expect(validateRouteHostname(undefined).ok).toBe(false);
  });
});

describe('validateRouteHostname 接受合法域名并归一化', () => {
  it('接受普通域名', () => {
    const result = validateRouteHostname('project1.example.com');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('project1.example.com');
    }
  });

  it('统一转小写并去掉首尾空白', () => {
    // 域名比较必须大小写无关，否则大小写不同的同一域名会被当成两条路由。
    const result = validateRouteHostname('  Project1.Example.COM  ');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('project1.example.com');
    }
  });

  it('接受 localhost 与 *.localhost，便于本地免配 DNS 验证', () => {
    expect(validateRouteHostname('localhost').ok).toBe(true);
    expect(validateRouteHostname('project1.localhost').ok).toBe(true);
  });
});

describe('normalizeHostname 归一化 Host 头', () => {
  it('剥掉端口', () => {
    // 带端口的 Host 若不剥离，会导致专属域名匹配静默失效。
    expect(normalizeHostname('project1.example.com:8787')).toBe('project1.example.com');
    expect(normalizeHostname('project1.example.com:443')).toBe('project1.example.com');
  });

  it('统一转小写并去空白', () => {
    expect(normalizeHostname('  Project1.Localhost  ')).toBe('project1.localhost');
  });

  it('空 Host 返回空串', () => {
    expect(normalizeHostname('')).toBe('');
    expect(normalizeHostname('   ')).toBe('');
  });

  it('IPv6 字面量不参与匹配', () => {
    // [::1]:8787 无法作为专属域名，返回空串表示「不匹配任何路由」。
    expect(normalizeHostname('[::1]:8787')).toBe('');
  });

  it('裸域名与带端口形式归一化结果一致', () => {
    // 这是「配了域名就能匹配上」的关键不变式。
    expect(normalizeHostname('a.example.com')).toBe(normalizeHostname('a.example.com:8787'));
  });
});
