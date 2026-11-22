import { describe, expect, test } from 'bun:test';

import { percentile, sampleOperation, summarizeSamples, timeAsync } from './measure.ts';

describe('performance measurement helpers (#282)', () => {
  test('percentiles use nearest rank and clamp to the sample range', () => {
    const sorted = [1, 2, 3, 4, 5];
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 0.5)).toBe(3);
    expect(percentile(sorted, 0.95)).toBe(5);
    expect(percentile(sorted, 1)).toBe(5);
    expect(percentile([], 0.5)).toBe(0);
  });

  test('summary includes count, mean and ordered tails', () => {
    const stats = summarizeSamples([4, 1, 3, 2]);
    expect(stats).toEqual({
      count: 4,
      minMs: 1,
      p50Ms: 2,
      p95Ms: 4,
      p99Ms: 4,
      maxMs: 4,
      meanMs: 2.5,
    });
    expect(summarizeSamples([])).toEqual({
      count: 0,
      minMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      meanMs: 0,
    });
  });

  test('a controlled clock records exactly the injected delay', async () => {
    let clock = 1000;
    const measured = await timeAsync(
      async () => {
        clock += 7;
        return 'done';
      },
      () => clock,
    );
    expect(measured).toEqual({ result: 'done', elapsedMs: 7 });
  });

  test('sampling warms up without recording that iteration', async () => {
    let clock = 0;
    let calls = 0;
    const stats = await sampleOperation(
      () => {
        calls += 1;
        clock += calls === 1 ? 100 : 3;
      },
      3,
      1,
      () => clock,
    );
    expect(calls).toBe(4);
    expect(stats.count).toBe(3);
    expect(stats.p50Ms).toBe(3);
  });

  test('a deliberately inserted 100 ms stage is visible in every sample (#301)', async () => {
    const stats = await sampleOperation(
      async () => {
        await Bun.sleep(100);
      },
      3,
      0,
    );
    expect(stats.count).toBe(3);
    expect(stats.minMs).toBeGreaterThanOrEqual(90);
    expect(stats.p50Ms).toBeGreaterThanOrEqual(90);
  });
});
