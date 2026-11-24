/**
 * Bounded concurrency for independent startup reads (#346, #348).
 *
 * `Promise.all` over an arbitrary number of paired servers or active sessions is unbounded by
 * construction: twenty hosts each spawning PowerShell, or hundreds of sessions each issuing
 * permission/form RPCs, would multiply process and network pressure. These helpers cap the
 * number of operations in flight while preserving input order in the result array.
 */

/** Maps items with at most `limit` operations running at once. Rejects on the first failure. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.floor(limit));
  const completed: { index: number; value: R }[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      completed.push({ index, value: await operation(item, index) });
    }
  });
  await Promise.all(workers);
  return completed.toSorted((left, right) => left.index - right.index).map((entry) => entry.value);
}

/**
 * Like `mapConcurrent`, but one failing item never aborts the others. The settled result keeps
 * input order so callers can report per-item outcomes truthfully.
 */
export async function settleConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const completed = await mapConcurrent(items, limit, async (item, index) => {
    try {
      return { status: 'fulfilled', value: await operation(item, index) } as const;
    } catch (reason) {
      return { status: 'rejected', reason } as const;
    }
  });
  return completed.map((entry): PromiseSettledResult<R> =>
    entry.status === 'fulfilled'
      ? { status: 'fulfilled', value: entry.value }
      : { status: 'rejected', reason: entry.reason },
  );
}
