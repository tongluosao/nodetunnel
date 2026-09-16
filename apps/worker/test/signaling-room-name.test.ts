import { describe, expect, it } from 'vitest';
import { signalingRoomName } from '../src/signaling/object-name.js';

/**
 * 信令房间命名映射测试。
 *
 * 这个映射决定「谁和谁在同一个房间」，映射错了会导致访客找不到主机，
 * 或者更糟 —— 被路由进另一个隧道的房间。因此必须稳定且可预测。
 */
describe('信令房间命名', () => {
  it('由 tunnel id 生成稳定的房间名', () => {
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(signalingRoomName(id)).toBe(signalingRoomName(id));
  });

  it('房间名带固定前缀，便于在面板中辨认', () => {
    expect(signalingRoomName('any-tunnel-id')).toMatch(/^room-[0-9a-f]{8}$/);
  });

  it('不同 tunnel 映射到不同房间', () => {
    const a = signalingRoomName('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    const b = signalingRoomName('7c9e6679-7425-40de-944b-e07fc1f90ae7');
    expect(a).not.toBe(b);
  });

  it('空 id 回退到固定名称，不产生非法房间名', () => {
    expect(signalingRoomName('')).toBe('unassigned');
    expect(signalingRoomName('   ')).toBe('unassigned');
  });

  it('首尾空白不影响映射结果', () => {
    // 避免因为一个多余的空白把同一个隧道分到两个房间。
    expect(signalingRoomName(' abc ')).toBe(signalingRoomName('abc'));
  });
});
