import { describe, expect, test } from 'bun:test';

import { goalBadge, toNativeGoal } from './native-goal.ts';

const base = {
  id: 'goal_1',
  objective: 'Ship the native goal',
  status: 'active' as const,
  rounds: 3,
  maxRounds: 50,
};

describe('toNativeGoal', () => {
  test('decodes a complete active goal', () => {
    expect(toNativeGoal({ ...base, reason: 'round done', stalls: 1 })).toEqual({
      ...base,
      reason: 'round done',
      stalls: 1,
    });
  });

  test('decodes paused and complete goals', () => {
    expect(
      toNativeGoal({
        id: 'g',
        objective: 'o',
        status: 'paused',
        rounds: 0,
        maxRounds: 50,
        reason: 'Stopped by the user',
      }),
    ).toMatchObject({ status: 'paused', reason: 'Stopped by the user' });
    expect(
      toNativeGoal({ id: 'g', objective: 'o', status: 'complete', rounds: 9, maxRounds: 50 }),
    ).toMatchObject({ status: 'complete', rounds: 9 });
  });

  test('null means no goal is set', () => {
    expect(toNativeGoal(null)).toBeNull();
  });

  test('rejects wire garbage instead of guessing', () => {
    expect(toNativeGoal(undefined)).toBeNull();
    expect(toNativeGoal('goal')).toBeNull();
    expect(toNativeGoal({ ...base, status: 'paused-ish' })).toBeNull();
    expect(toNativeGoal({ ...base, rounds: '3' })).toBeNull();
    expect(toNativeGoal({ ...base, maxRounds: Number.NaN })).toBeNull();
    expect(toNativeGoal({ objective: 'x', status: 'active', rounds: 0, maxRounds: 50 })).toBeNull();
  });
});

describe('goalBadge', () => {
  test('is empty without a goal', () => {
    expect(goalBadge(null, undefined)).toBe('');
  });

  test('active goals show the round', () => {
    expect(goalBadge({ ...base }, undefined)).toBe('◎ goal · round 3');
  });

  test('an interrupt-paused goal awaiting a follow-up says so', () => {
    const paused = { ...base, status: 'paused' as const, reason: 'Stopped by the user' };
    expect(goalBadge(paused, 'goal_1')).toBe('◌ goal · follow-up');
    expect(goalBadge(paused, 'other_goal')).toBe('◌ goal paused');
  });

  test('complete goals render as complete', () => {
    expect(goalBadge({ ...base, status: 'complete' }, undefined)).toBe('● goal complete');
  });
});
