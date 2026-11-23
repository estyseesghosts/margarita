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
 * Plans eviction after `touched` is accessed. Count eviction runs first; byte
 * eviction then walks least-recent entries from the end. The most-recent entry
 * is kept even when it alone exceeds the budget — dropping it would force the
 * next refresh to refetch the same bytes with no memory win.
 */
export function planTranscriptEviction(input: TranscriptEvictionInput): TranscriptEviction {
  const order = [input.touched, ...input.order.filter((entry) => entry !== input.touched)];
  const evicted = new Set(order.slice(input.countLimit));
  const kept = order.slice(0, input.countLimit);

  const sizes = new Map<string, number>();
  let total = 0;
  for (const entry of kept) {
    if (evicted.has(entry)) continue;
    const size = input.sizes(entry);
    sizes.set(entry, size);
    total += size;
  }

  for (let index = kept.length - 1; index >= 0 && total > input.byteBudget; index -= 1) {
    const entry = kept[index];
    if (entry === undefined || entry === input.activeKey || input.inFlight.has(entry)) continue;
    if (index === 0) continue;
    total -= sizes.get(entry) ?? 0;
    evicted.add(entry);
  }

  return { order: kept.filter((entry) => !evicted.has(entry)), evicted: [...evicted] };
}
