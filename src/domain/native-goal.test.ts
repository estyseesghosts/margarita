import { describe, expect, test } from 'bun:test';

import { goalBadge, toNativeGoal, verifiedGoal } from './native-goal.ts';

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
  test('is empty when nothing usable is known', () => {
    expect(goalBadge(undefined, undefined)).toBe('');
    expect(goalBadge({ status: 'unknown' }, undefined)).toBe('');
    expect(goalBadge({ status: 'loading' }, undefined)).toBe('');
    expect(goalBadge({ status: 'none' }, undefined)).toBe('');
  });

  test('active goals show the round', () => {
    expect(goalBadge({ status: 'verified', goal: { ...base } }, undefined)).toBe(
      '◎ goal · round 3',
    );
  });

  test('an interrupt-paused goal awaiting a follow-up says so', () => {
    const paused = { ...base, status: 'paused' as const, reason: 'Stopped by the user' };
    const state = { status: 'verified' as const, goal: paused };
    expect(goalBadge(state, 'goal_1')).toBe('◌ goal · follow-up');
    expect(goalBadge(state, 'other_goal')).toBe('◌ goal paused');
  });

  test('complete goals render as complete', () => {
    expect(
      goalBadge({ status: 'verified', goal: { ...base, status: 'complete' } }, undefined),
    ).toBe('● goal complete');
  });

  test('a failed read marks the last known goal stale, never active', () => {
    const stale = {
      status: 'unavailable' as const,
      reason: 'transport' as const,
      message: 'offline',
      sessionID: 'ses_1',
      last: { ...base },
    };
    expect(goalBadge(stale, 'goal_1')).toBe('◎ goal · stale');
    expect(goalBadge({ ...stale, last: { ...base, status: 'paused' } }, undefined)).toBe(
      '◌ goal · stale',
    );
  });

  test('an unavailable read never claims there is no goal', () => {
    expect(
      goalBadge(
        { status: 'unavailable', reason: 'unsupported', message: 'no plugin', sessionID: 's' },
        undefined,
      ),
    ).toBe('');
  });
});

describe('verifiedGoal', () => {
  test('only a verified reading counts as the current goal', () => {
    expect(verifiedGoal({ status: 'verified', goal: { ...base } })?.id).toBe('goal_1');
    expect(verifiedGoal({ status: 'none' })).toBeNull();
    expect(verifiedGoal(undefined)).toBeNull();
    expect(
      verifiedGoal({
        status: 'unavailable',
        reason: 'transport',
        message: 'offline',
        sessionID: 's',
        last: { ...base },
      }),
    ).toBeNull();
  });
});
