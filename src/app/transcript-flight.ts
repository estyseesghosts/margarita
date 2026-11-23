/**
 * Single-flight signal coalescing for transcript reads (#309).
 *
 * Several events can ask for the same session's transcript while one read is in
 * flight. Rather than starting overlapping reads, later signals are recorded as
 * dirty hints and drained once the flight settles — including after a failure,
 * so an observed update is never lost (#295). This tracker owns that bookkeeping
 * and flight identity; scheduling, retries and store writes stay with the
 * controller. A read that outlives its session lifetime cannot close or drain a
 * replacement read that reused the same server/session key (#333).
 */
export interface DrainedHints {
  readonly dirty: boolean;
  readonly dirtyJobs: boolean;
}

/** Identity of one transcript read; late completions carry the old identity. */
export interface TranscriptFlight {
  readonly key: string;
  readonly sequence: number;
}

export class TranscriptFlightTracker {
  private readonly inFlight = new Map<string, TranscriptFlight>();
  private readonly dirty = new Set<string>();
  private readonly jobsDirty = new Set<string>();
  private nextSequence = 1;

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

  /** Registers a read and returns its identity. The caller owns the read promise. */
  begin(key: string): TranscriptFlight {
    const flight: TranscriptFlight = { key, sequence: this.nextSequence };
    this.nextSequence += 1;
    this.inFlight.set(key, flight);
    return flight;
  }

  /** Whether this exact read still owns its key. */
  isCurrent(flight: TranscriptFlight): boolean {
    return this.inFlight.get(flight.key)?.sequence === flight.sequence;
  }

  /** Ends a flight only while it is still current; reports whether it was. */
  end(flight: TranscriptFlight): boolean {
    if (!this.isCurrent(flight)) return false;
    this.inFlight.delete(flight.key);
    return true;
  }

  /** Drains both hints for a flight that is still current. */
  drain(flight: TranscriptFlight): DrainedHints {
    if (!this.isCurrent(flight)) return { dirty: false, dirtyJobs: false };
    return { dirty: this.dirty.delete(flight.key), dirtyJobs: this.jobsDirty.delete(flight.key) };
  }

  /** Drops one lifetime's flight and hints on deletion or ID reuse (#333). */
  retire(key: string): void {
    this.inFlight.delete(key);
    this.dirty.delete(key);
    this.jobsDirty.delete(key);
  }

  /** Retires every matching lifetime without touching still-valid sessions. */
  retireWhere(matches: (key: string) => boolean): void {
    const targets = new Set<string>();
    for (const key of this.inFlight.keys()) {
      if (matches(key)) targets.add(key);
    }
    for (const key of this.dirty) {
      if (matches(key)) targets.add(key);
    }
    for (const key of this.jobsDirty) {
      if (matches(key)) targets.add(key);
    }
    for (const key of targets) this.retire(key);
  }

  /** Clears all owned flights and hints on controller teardown. */
  dispose(): void {
    this.inFlight.clear();
    this.dirty.clear();
    this.jobsDirty.clear();
  }

  inFlightKeys(): readonly string[] {
    return [...this.inFlight.keys()];
  }
}
