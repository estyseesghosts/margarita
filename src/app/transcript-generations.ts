/**
 * Transcript read generations and per-session commit watermarks (#309).
 *
 * Two overlapping reads of one live session can resolve out of order; only the
 * newer one may replace the cached page. This owner hands out globally monotonic
 * read generations and remembers the newest page committed for each session key,
 * so a stale response is rejected without touching the store.
 */
export class TranscriptGenerations {
  private readSeq = 0;
  private readonly committed = new Map<string, number>();

  /** Admits a new read and returns its globally monotonic generation. */
  nextRead(): number {
    this.readSeq += 1;
    return this.readSeq;
  }

  /** Newest generation already committed for `key`, or 0 when none. */
  committedGeneration(key: string): number {
    return this.committed.get(key) ?? 0;
  }

  /** True when `generation` is newer than the last committed page for `key`. */
  shouldCommit(key: string, generation: number): boolean {
    return generation > this.committedGeneration(key);
  }

  /** Records that `generation` was committed for `key`. */
  commit(key: string, generation: number): void {
    this.committed.set(key, generation);
  }

  forget(key: string): void {
    this.committed.delete(key);
  }
}
