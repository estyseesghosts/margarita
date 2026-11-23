/**
 * Pure LRU/byte-budget eviction planning for cached transcripts (#309).
 *
 * Detached sessions keep only summaries: both the entry count and the retained
 * bytes are bounded. The active route and any in-flight read are never evicted,
 * so a slow refresh cannot lose its destination. This module computes what to
 * evict and the new order from explicit inputs; the caller owns the store write.
 */
export interface TranscriptEvictionInput {
  /** Current least-recently-modified order, most-recent first. */
  readonly order: readonly string[];
  /** The entry just touched; it becomes most-recent and is never evicted here. */
  readonly touched: string;
  /** Retained bytes for one entry's messages. */
  readonly sizes: (key: string) => number;
  /** The attached conversation, protected from eviction. */
  readonly activeKey: string | undefined;
  /** Sessions whose read is still allowed to commit, protected from eviction. */
  readonly inFlight: ReadonlySet<string>;
  readonly countLimit: number;
  readonly byteBudget: number;
}

/** The outcome of one touch: the new order and the entries to drop. */
export interface TranscriptEviction {
  readonly order: string[];
  readonly evicted: string[];
}

/**
 * Plans eviction after `touched` is accessed. Protected entries (the touched
 * entry, the active route and live reads) are separated from cacheable entries
 * *before* either cap is applied, so a count slice cannot evict an entry the
 * contract promises to retain (#331). When protected entries alone exceed a
 * limit the cache temporarily stays over budget; dropping an active page or a
 * read that can still commit would force an immediate refetch with no win.
 */
export function planTranscriptEviction(input: TranscriptEvictionInput): TranscriptEviction {
  const order = [...new Set([input.touched, ...input.order])];
  const isProtected = (entry: string): boolean =>
    entry === input.touched || entry === input.activeKey || input.inFlight.has(entry);
  const evicted = new Set<string>();
  const cacheable = order.filter((entry) => !isProtected(entry));
  const countAllowance = Math.max(0, input.countLimit - (order.length - cacheable.length));
  for (const entry of cacheable.slice(countAllowance)) evicted.add(entry);

  const kept = order.filter((entry) => !evicted.has(entry));
  const sizes = new Map<string, number>();
  let total = 0;
  for (const entry of kept) {
    const size = input.sizes(entry);
    sizes.set(entry, size);
    total += size;
  }

  for (let index = kept.length - 1; index > 0 && total > input.byteBudget; index -= 1) {
    const entry = kept[index];
    if (entry === undefined || isProtected(entry)) continue;
    total -= sizes.get(entry) ?? 0;
    evicted.add(entry);
  }

  return { order: kept.filter((entry) => !evicted.has(entry)), evicted: [...evicted] };
}
