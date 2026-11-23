/**
 * Monotone UI revision guard for goal snapshots (#314).
 *
 * A late read or an out-of-order save must never make the displayed goal plan
 * regress. This guard owns the last revision admitted for each server-qualified
 * session key; the controller still owns the store update and notices.
 */
export class GoalRevisionGuard {
  private readonly revisions = new Map<string, number>();

  /** Last revision committed to the UI for `key`, if any. */
  revision(key: string): number | undefined {
    return this.revisions.get(key);
  }

  /** True when a snapshot at `revision` is new enough to update the UI. */
  admits(key: string, revision: number): boolean {
    const seen = this.revisions.get(key);
    return seen === undefined || revision >= seen;
  }

  /** Records a committed revision; returns false and records nothing if stale. */
  commit(key: string, revision: number): boolean {
    if (!this.admits(key, revision)) return false;
    this.revisions.set(key, revision);
    return true;
  }

  forget(key: string): void {
    this.revisions.delete(key);
  }

  keys(): IterableIterator<string> {
    return this.revisions.keys();
  }
}
