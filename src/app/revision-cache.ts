/**
 * Single-entry memo keyed by a reactive revision and a scope key (#316).
 *
 * Overview projections are expensive and must be reused until the state they
 * depend on changes. The invalidation inputs are explicit — a revision counter
 * and a scope key (plus an optional discriminator) — so a new dependency cannot
 * silently forget to invalidate a derived view. This replaces hand-written
 * `if (cached?.revision === ...)` blocks with one tested primitive.
 */
export class RevisionCache<T> {
  private entry: { revision: number; key: string; extra: string | undefined; value: T } | undefined;

  /** Returns the cached value or computes and stores it for this invalidation key. */
  get(revision: number, key: string, compute: () => T, extra?: string): T {
    const entry = this.entry;
    if (
      entry !== undefined &&
      entry.revision === revision &&
      entry.key === key &&
      entry.extra === extra
    ) {
      return entry.value;
    }
    const value = compute();
    this.entry = { revision, key, extra, value };
    return value;
  }
}
