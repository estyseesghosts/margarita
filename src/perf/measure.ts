/**
 * Labelled, opt-in measurement helpers for the performance harness (#282). These are pure
 * and cheap when unused; production paths never import them.
 */

export type BenchStats = Readonly<{
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}>;

/** Nearest-rank percentile over an ascending sample list. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const bounded = Math.min(1, Math.max(0, fraction));
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(bounded * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function summarizeSamples(samples: readonly number[]): BenchStats {
  if (samples.length === 0) {
    return { count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 };
  }
  const sorted = samples.toSorted((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? 0,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? 0,
    meanMs: sum / sorted.length,
  };
}

/** Runs one operation, returning elapsed milliseconds from the injected clock. */
export async function timeAsync<T>(
  operation: () => T | Promise<T>,
  clock: () => number = () => performance.now(),
): Promise<{ result: T; elapsedMs: number }> {
  const start = clock();
  const result = await operation();
  return { result, elapsedMs: clock() - start };
}

/** Warm up, then collect one elapsed sample per iteration. */
export async function sampleOperation(
  operation: () => unknown,
  iterations: number,
  warmup = 1,
  clock: () => number = () => performance.now(),
): Promise<BenchStats> {
  for (let index = 0; index < Math.max(0, warmup); index += 1) await operation();
  const samples: number[] = [];
  for (let index = 0; index < Math.max(0, iterations); index += 1) {
    samples.push((await timeAsync(operation, clock)).elapsedMs);
  }
  return summarizeSamples(samples);
}
