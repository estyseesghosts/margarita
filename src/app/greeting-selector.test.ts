import { describe, expect, test } from 'bun:test';

import { GreetingSelector } from './greeting-selector.ts';

describe('greeting selector (#318)', () => {
  test('a key keeps its first greeting across calls and clock changes', () => {
    const selector = new GreetingSelector();
    const first = selector.for('overview', 'morning', () => 0);
    expect(selector.for('overview', 'evening', () => 0.9)).toBe(first);
    expect(selector.for('overview', undefined, () => 0.5)).toBe(first);
  });

  test('different keys can select different greetings', () => {
    const selector = new GreetingSelector();
    const a = selector.for('a', 'morning', () => 0);
    const b = selector.for('b', 'morning', () => 0.99);
    expect(a).not.toBe(b);
  });

  test('recent history avoids exact repeats across keys', () => {
    const selector = new GreetingSelector();
    // rng=0 always picks index 0 of a pool; the recent-history rule must skip it
    // for later keys so the same greeting is not shown twice in a row.
    const first = selector.for('a', 'morning', () => 0);
    const second = selector.for('b', 'morning', () => 0);
    expect(second).not.toBe(first);
  });
});
