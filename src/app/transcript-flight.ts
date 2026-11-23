/**
 * Single-flight signal coalescing for transcript reads (#309).
 *
 * Several events can ask for the same session's transcript while one read is in
 * flight. Rather than starting overlapping reads, later signals are recorded as
 * dirty hints and drained once the flight settles — including after a failure,
 * so an observed update is never lost (#295). This tracker owns that bookkeeping;
 * scheduling, retries and store writes stay with the controller.
 */
export interface DrainedHints {
  readonly dirty: boolean;
  readonly dirtyJobs: boolean;
}

export class TranscriptFlightTracker {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private readonly jobsDirty = new Set<string>();

  isInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  /** Coalesces a new signal into dirty hints when a read is already in flight. */
  coalesce(key: string, refreshJobs: boolean): boolean {
    if (!this.inFlight.has(key)) return false;
    this.dirty.add(key);
    if (refreshJobs) this.jobsDirty.add(key);
    return true;
  }

  begin(key: string, run: Promise<void>): void {
    this.inFlight.set(key, run);
  }

  end(key: string): void {
    this.inFlight.delete(key);
  }

  /** Drains both hints for a settled key so they survive success and failure alike. */
  drain(key: string): DrainedHints {
    return { dirty: this.dirty.delete(key), dirtyJobs: this.jobsDirty.delete(key) };
  }

  inFlightKeys(): readonly string[] {
    return [...this.inFlight.keys()];
  }
}
