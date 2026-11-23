import { describe, expect, test } from 'bun:test';

import { RefreshGenerations } from './refresh-generations.ts';

describe('refresh generations (#308)', () => {
  test('refresh epochs are per host and a newer read retires the older', () => {
    const generations = new RefreshGenerations();
    expect(generations.isRefreshCurrent('local', 0)).toBe(false);
    const local = generations.nextRefresh('local');
    const remote = generations.nextRefresh('remote');
    expect(local).toBe(1);
    expect(remote).toBe(1);
    expect(generations.isRefreshCurrent('local', local)).toBe(true);
    expect(generations.isRefreshCurrent('remote', remote)).toBe(true);
    const newer = generations.nextRefresh('local');
    expect(generations.isRefreshCurrent('local', local)).toBe(false);
    expect(generations.isRefreshCurrent('local', newer)).toBe(true);
    expect(generations.isRefreshCurrent('remote', remote)).toBe(true);
  });

  test('session lifetimes are bumped, never reused after teardown', () => {
    const generations = new RefreshGenerations();
    const key = 'remote:ses_same';
    const first = generations.sessionEpoch(key);
    expect(generations.isSessionCurrent(key, first)).toBe(true);
    generations.invalidateSession(key);
    const second = generations.sessionEpoch(key);
    expect(second).toBeGreaterThan(first);
    expect(generations.isSessionCurrent(key, first)).toBe(false);
    expect(generations.isSessionCurrent(key, second)).toBe(true);
    expect(generations.sessionKeys()).toContain(key);
  });

  test('resync epochs are independent of session refresh epochs', () => {
    const generations = new RefreshGenerations();
    const resync = generations.nextResync('local');
    const refresh = generations.nextRefresh('local');
    expect(generations.isResyncCurrent('local', resync)).toBe(true);
    expect(generations.isRefreshCurrent('local', refresh)).toBe(true);
    expect(generations.nextResync('local')).toBeGreaterThan(resync);
    expect(generations.isResyncCurrent('local', resync)).toBe(false);
  });

  test('event and usage stamps stay monotonic when one session is forgotten', () => {
    const generations = new RefreshGenerations();
    const before = generations.eventClock();
    const event = generations.nextEventSequence('local:ses_a');
    const usage = generations.nextUsageSequence('local:ses_a');
    expect(event).toBeGreaterThan(before);
    expect(usage).toBeGreaterThan(before);
    expect(generations.eventSequence('local:ses_a')).toBe(event);
    expect(generations.usageEvidence('local:ses_a')).toBe(usage);

    generations.forgetEvents('local:ses_a');
    generations.forgetUsage('local:ses_a');
    expect(generations.eventSequence('local:ses_a')).toBe(0);
    expect(generations.usageEvidence('local:ses_a')).toBe(0);
    expect(generations.eventClock()).toBe(event);
    expect(generations.usageClock()).toBe(usage);
    expect(generations.nextEventSequence('local:ses_b')).toBeGreaterThan(event);
    expect(generations.usageKeys()).toEqual([]);
  });
});
