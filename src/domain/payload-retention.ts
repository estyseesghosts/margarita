/**
 * Bounded preview retention for large canonical payloads (#356).
 *
 * Display state keeps a bounded preview so folding, projection and rendering never carry a
 * megabyte-scale string. The full source stays reachable exactly once through a WeakMap keyed
 * by the canonical part/tool object; deleting or evicting that object releases both together.
 * This is not a global permanent cache and never duplicates the full source.
 */

export type PayloadLimits = Readonly<{ text: number; diff: number }>;

/** Chosen after profiling 1 MB prose/reasoning and multi-MB diffs in the benchmark. */
export const payloadLimits: PayloadLimits = {
  text: 16 * 1024,
  diff: 32 * 1024,
};

const retained = new WeakMap<object, string>();

function preview(full: string, limit: number): string {
  const head = Math.ceil((limit * 3) / 4);
  const tail = Math.max(0, limit - head);
  const omitted = full.length - head - tail;
  return `${full.slice(0, head)}\n… ${omitted} characters retained; full content is available to copy or inspect …\n${tail === 0 ? '' : full.slice(-tail)}`;
}

/**
 * Returns `full` when it fits. Otherwise stores it once under `owner` and returns a bounded
 * preview. `owner` must be the canonical object that will be held by the message/tool part.
 */
export function retainPayload(owner: object, full: string, limit: number): string {
  if (full.length <= limit) return full;
  retained.set(owner, full);
  return preview(full, limit);
}

/** Full retained source for copy/export/inspect, or the bounded fallback. */
export function retainedPayload(owner: object, fallback: string): string {
  return retained.get(owner) ?? fallback;
}

/** True when `owner` has a full source separate from its preview. */
export function hasRetainedPayload(owner: object): boolean {
  return retained.has(owner);
}
