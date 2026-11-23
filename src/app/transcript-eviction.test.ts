import { describe, expect, test } from 'bun:test';

import { planTranscriptEviction, type TranscriptEvictionInput } from './transcript-eviction.ts';

function input(overrides: Partial<TranscriptEvictionInput> = {}): TranscriptEvictionInput {
  return {
    order: [],
    touched: 'a',
    sizes: () => 1,
    activeKey: undefined,
    inFlight: new Set(),
    countLimit: 8,
    byteBudget: 100,
    ...overrides,
  };
}

describe('transcript eviction planning (#309)', () => {
  test('touch promotes an entry to most-recent without evicting', () => {
    const plan = planTranscriptEviction(input({ order: ['b', 'c'], touched: 'b' }));
    expect(plan.order).toEqual(['b', 'c']);
    expect(plan.evicted).toEqual([]);
  });

  test('count limit evicts the least-recent entries', () => {
    const plan = planTranscriptEviction(
      input({ order: ['b', 'c', 'd'], touched: 'a', countLimit: 2 }),
    );
    expect(plan.order).toEqual(['a', 'b']);
    expect(plan.evicted).toEqual(['c', 'd']);
  });

  test('byte budget evicts least-recent entries until under budget', () => {
    const sizes: Record<string, number> = { a: 10, b: 40, c: 40, d: 40 };
    const plan = planTranscriptEviction(
      input({
        order: ['d', 'c', 'b'],
        touched: 'a',
        sizes: (key) => sizes[key] ?? 0,
        byteBudget: 60,
      }),
    );
    // Eviction walks least-recent first: b then c, leaving a + d under budget.
    expect(plan.evicted).toEqual(['b', 'c']);
    expect(plan.order).toEqual(['a', 'd']);
  });

  test('active and in-flight entries are never evicted', () => {
    const plan = planTranscriptEviction(
      input({
        order: ['old', 'inflight', 'active'],
        touched: 'new',
        sizes: () => 50,
        byteBudget: 60,
        activeKey: 'active',
        inFlight: new Set(['inflight']),
      }),
    );
    expect(plan.order).toContain('active');
    expect(plan.order).toContain('inflight');
    expect(plan.evicted).toContain('old');
  });

  test('the most-recent entry survives even when it alone exceeds the budget', () => {
    const plan = planTranscriptEviction(
      input({
        order: ['old'],
        touched: 'huge',
        sizes: (key) => (key === 'huge' ? 500 : 1),
        byteBudget: 100,
      }),
    );
    expect(plan.order).toContain('huge');
    expect(plan.evicted).toContain('old');
  });

  test('the count cap protects the active entry even below the cutoff (#331)', () => {
    const plan = planTranscriptEviction(
      input({
        order: ['new', 'b', 'c', 'active'],
        touched: 'new',
        activeKey: 'active',
        countLimit: 2,
      }),
    );
    expect(plan.order).toEqual(['new', 'active']);
    expect(plan.evicted).toEqual(['b', 'c']);
  });

  test('the count cap protects a read that is still allowed to commit (#331)', () => {
    const plan = planTranscriptEviction(
      input({
        order: ['new', 'b', 'c', 'inflight'],
        touched: 'new',
        inFlight: new Set(['inflight']),
        countLimit: 2,
      }),
    );
    expect(plan.order).toEqual(['new', 'inflight']);
    expect(plan.evicted).toEqual(['b', 'c']);
  });

  test('protected entries alone may exceed the cap instead of dropping a live page (#331)', () => {
    const plan = planTranscriptEviction(
      input({
        order: ['inflight', 'active'],
        touched: 'new',
        activeKey: 'active',
        inFlight: new Set(['inflight']),
        countLimit: 1,
      }),
    );
    expect(plan.order).toEqual(['new', 'inflight', 'active']);
    expect(plan.evicted).toEqual([]);
  });

  test('repeated order entries are planned once', () => {
    const plan = planTranscriptEviction(input({ order: ['a', 'b', 'b'], touched: 'a' }));
    expect(plan.order).toEqual(['a', 'b']);
    expect(plan.evicted).toEqual([]);
  });
});
