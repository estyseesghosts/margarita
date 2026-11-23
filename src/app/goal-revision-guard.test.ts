import { describe, expect, test } from 'bun:test';

import { GoalRevisionGuard } from './goal-revision-guard.ts';

describe('goal revision guard (#314)', () => {
  test('the first snapshot is always admitted', () => {
    const guard = new GoalRevisionGuard();
    expect(guard.revision('local:ses')).toBeUndefined();
    expect(guard.admits('local:ses', 0)).toBe(true);
    expect(guard.commit('local:ses', 0)).toBe(true);
    expect(guard.revision('local:ses')).toBe(0);
  });

  test('older snapshots are rejected, equal and newer ones committed', () => {
    const guard = new GoalRevisionGuard();
    guard.commit('local:ses', 5);
    expect(guard.admits('local:ses', 4)).toBe(false);
    expect(guard.commit('local:ses', 4)).toBe(false);
    expect(guard.revision('local:ses')).toBe(5);
    expect(guard.commit('local:ses', 5)).toBe(true);
    expect(guard.commit('local:ses', 6)).toBe(true);
    expect(guard.revision('local:ses')).toBe(6);
  });

  test('revisions are per session key and teardown forgets one key', () => {
    const guard = new GoalRevisionGuard();
    guard.commit('local:a', 3);
    guard.commit('remote:a', 9);
    expect(guard.revision('remote:a')).toBe(9);
    guard.forget('local:a');
    expect(guard.revision('local:a')).toBeUndefined();
    expect([...guard.keys()]).toEqual(['remote:a']);
    expect(guard.commit('local:a', 1)).toBe(true);
  });
});
