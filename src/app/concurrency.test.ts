import { describe, expect, test } from 'bun:test';

import { mapConcurrent, settleConcurrent } from './concurrency.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('bounded startup concurrency', () => {
  test('never exceeds the requested width and preserves input order', async () => {
    let active = 0;
    let peak = 0;
    const gates = new Map<number, ReturnType<typeof deferred<void>>>();
    for (let index = 0; index < 6; index += 1) gates.set(index, deferred<void>());
    const pending = mapConcurrent([0, 1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await gates.get(item)?.promise;
      active -= 1;
      return item * 10;
    });
    // Two workers start; nothing else may enter until a slot is released.
    await Promise.resolve();
    expect(peak).toBe(2);
    for (let index = 0; index < 6; index += 1) {
      gates.get(index)?.resolve();
      await Promise.resolve();
    }
    expect(await pending).toEqual([0, 10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });

  test('empty input and a width larger than the input are both safe', async () => {
    expect(await mapConcurrent([], 4, async () => 1)).toEqual([]);
    expect(await mapConcurrent([1, 2], 10, async (item) => item + 1)).toEqual([2, 3]);
  });

  test('a non-positive width is treated as one rather than unbounded', async () => {
    let active = 0;
    let peak = 0;
    await mapConcurrent([1, 2, 3], 0, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return item;
    });
    expect(peak).toBe(1);
  });

  test('settleConcurrent keeps failures local and reports input order', async () => {
    const results = await settleConcurrent([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error('unavailable');
      return item;
    });
    expect(results.map((entry) => entry.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
    if (results[1]?.status === 'rejected') {
      expect(String(results[1].reason)).toContain('unavailable');
    }
  });
});
