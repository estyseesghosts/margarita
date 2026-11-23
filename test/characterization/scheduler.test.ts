import { describe, expect, test } from 'bun:test';

import { FakeScheduler } from './scheduler.ts';

describe('deterministic timer scheduler (#326)', () => {
  test('time is frozen until a test advances it', () => {
    const scheduler = new FakeScheduler(1000);
    const calls: number[] = [];
    scheduler.setTimeout(() => {
      calls.push(scheduler.now());
    }, 50);
    expect(scheduler.now()).toBe(1000);
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.advanceBy(49);
    expect(calls).toEqual([]);
    scheduler.advanceBy(1);
    expect(calls).toEqual([1050]);
    expect(scheduler.pendingCount()).toBe(0);
    expect(scheduler.now()).toBe(1050);
  });

  test('timers fire in due-time order and chained zero-delay work runs in the same advance', () => {
    const scheduler = new FakeScheduler();
    const calls: string[] = [];
    scheduler.setTimeout(() => {
      calls.push('late');
    }, 20);
    scheduler.setTimeout(() => {
      calls.push('early');
      scheduler.setTimeout(() => {
        calls.push('chained');
      }, 0);
    }, 5);
    scheduler.advanceBy(20);
    expect(calls).toEqual(['early', 'chained', 'late']);
  });

  test('runDue never advances virtual time and cancellation removes only the owned timer', () => {
    const scheduler = new FakeScheduler();
    let fired = false;
    const cancel = scheduler.setTimeout(() => {
      fired = true;
    }, 0);
    const later = scheduler.setTimeout(() => {}, 10);
    expect(scheduler.pendingCount()).toBe(2);
    scheduler.runDue();
    expect(fired).toBe(true);
    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.now()).toBe(1000);
    scheduler.clearTimeout(cancel);
    scheduler.clearTimeout(later);
    expect(scheduler.pendingCount()).toBe(0);
    scheduler.advanceBy(100);
    expect(scheduler.now()).toBe(1100);
  });

  test('dispose drops every owned timer', () => {
    const scheduler = new FakeScheduler();
    scheduler.setTimeout(() => {}, 1);
    scheduler.setTimeout(() => {}, 500);
    scheduler.dispose();
    expect(scheduler.pendingCount()).toBe(0);
    scheduler.advanceBy(1000);
    expect(scheduler.now()).toBe(2000);
  });
});
