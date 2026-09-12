import { describe, expect, it } from 'vitest';
import { relayObjectName } from '../src/relay/object-name.js';

/**
 * 中继对象名映射。
 *
 * 该映射决定「哪个组网路由到哪个 Durable Object 实例」，
 * 是组网隔离的基础，因此单独测试。
 */
describe('relayObjectName', () => {
  it('空组网名回退到 primary', () => {
    expect(relayObjectName('')).toBe('primary');
    expect(relayObjectName('   ')).toBe('primary');
  });

  it('不同组网名映射到不同对象名', () => {
    const a = relayObjectName('network-a');
    const b = relayObjectName('network-b');
    expect(a).not.toBe(b);
  });

  it('同一组网名始终映射到同一对象名（稳定）', () => {
    expect(relayObjectName('tunnel-alpha')).toBe(relayObjectName('tunnel-alpha'));
  });

  it('对首尾空白不敏感', () => {
    expect(relayObjectName('  tunnel-alpha  ')).toBe(relayObjectName('tunnel-alpha'));
  });

  it('结果为合法的 Durable Object 名称（ASCII 且长度受限）', () => {
    const name = relayObjectName('任意中文组网名 with spaces/and:符号');
    expect(name).toMatch(/^[A-Za-z0-9-]+$/);
    expect(name.length).toBeLessThanOrEqual(64);
  });
});
