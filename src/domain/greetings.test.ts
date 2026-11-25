import { describe, expect, test } from 'bun:test';

import { strings } from '../i18n/index.ts';
import type { GreetingPeriod } from './greeting-time.ts';
import { greetingCatalog, selectGreeting } from './greetings.ts';

/** Repeats a short sequence so weighting and index selection stay deterministic. */
function rng(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length]!;
}

describe('selectGreeting', () => {
  test('70% time-specific and 30% anytime for a known period', () => {
    expect(greetingCatalog.morning).toContain(selectGreeting('morning', [], rng([0.0, 0.0])));
    expect(greetingCatalog.anytime).toContain(selectGreeting('morning', [], rng([0.8, 0.0])));
  });

  test('both a relevant and a neutral greeting are reachable in every period', () => {
    const periods: GreetingPeriod[] = ['morning', 'afternoon', 'evening', 'night'];
    for (const period of periods) {
      expect(greetingCatalog[period]).toContain(selectGreeting(period, [], rng([0.0, 0.0])));
      expect(greetingCatalog.anytime).toContain(selectGreeting(period, [], rng([0.9, 0.0])));
    }
  });

  test('unavailable period selects only from the anytime pool', () => {
    expect(greetingCatalog.anytime).toContain(selectGreeting(undefined, [], rng([0.0, 0.0])));
  });

  test('avoids exact repeats across the last four, including across categories', () => {
    // Exactly four recent greetings, drawn from both the timed and anytime pools. The
    // selector may only look back four entries, so this is the full window it guards.
    const recent = [...greetingCatalog.morning.slice(0, 2), ...greetingCatalog.anytime.slice(0, 2)];
    const chosen = selectGreeting('morning', recent, rng([0.0, 0.0]));
    expect(recent).not.toContain(chosen);
    expect(Object.values(greetingCatalog).flat()).toContain(chosen);
  });

  test('relaxes gracefully when every pool is exhausted', () => {
    const all = Object.values(greetingCatalog).flat();
    expect(all).toContain(selectGreeting('morning', all, rng([0.0, 0.0])));
  });

  test('empty catalogs fall back to a non-empty greeting without looping', () => {
    const originalAnytime = greetingCatalog.anytime;
    try {
      (greetingCatalog as { anytime: readonly string[] }).anytime = [];
      expect(selectGreeting(undefined, [], rng([0.0, 0.0]))).toBe(strings.greetings.fallback);
    } finally {
      (greetingCatalog as { anytime: readonly string[] }).anytime = originalAnytime;
    }
  });
});
