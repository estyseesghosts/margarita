/**
 * Owns the monotonic generations that reject stale asynchronous replies (#308).
 *
 * Every map/counter here exists to answer one question: was the response that just
 * arrived still the newest authoritative work for its host, session or event stream
 * when it landed? Keeping them together gives each generation one writer and one
 * named invalidation operation.
 */
/** One worker/shell refresh pair, each kind advancing independently. */
export interface JobEpochs {
  readonly worker: number;
  readonly shell: number;
}

/** Kind of job list a refresh reads. */
export type JobKind = 'worker' | 'shell';

export class RefreshGenerations {
  private readonly refreshEpoch = new Map<string, number>();
  private readonly sessionEpochs = new Map<string, number>();
  private readonly resyncEpochs = new Map<string, number>();
  private readonly jobEpochs = new Map<string, JobEpochs>();
  private readonly runningEventSeq = new Map<string, number>();
  private readonly usageByKey = new Map<string, number>();
  private runningEventSequence = 0;
  private usageEventSequence = 0;

  /** Starts a new snapshot refresh for one host; older replies become stale. */
  nextRefresh(serverID: string): number {
    const next = (this.refreshEpoch.get(serverID) ?? 0) + 1;
    this.refreshEpoch.set(serverID, next);
    return next;
  }

  /** True while `epoch` is still the newest refresh admitted for this host. */
  isRefreshCurrent(serverID: string, epoch: number): boolean {
    return this.refreshEpoch.get(serverID) === epoch;
  }

  /** Current lifetime of a server-qualified session key. */
  sessionEpoch(key: string): number {
    return this.sessionEpochs.get(key) ?? 0;
  }

  /** True while a captured session epoch still names the current lifetime. */
  isSessionCurrent(key: string, epoch: number): boolean {
    return this.sessionEpoch(key) === epoch;
  }

  /** Bumps a lifetime rather than deleting it, so an old value cannot be reused. */
  invalidateSession(key: string): void {
    this.sessionEpochs.set(key, this.sessionEpoch(key) + 1);
  }

  /** All session keys with a tracked lifetime, for host teardown. */
  sessionKeys(): readonly string[] {
    return [...this.sessionEpochs.keys()];
  }

  /** Starts a new reconnect resync for one host. */
  nextResync(serverID: string): number {
    const next = (this.resyncEpochs.get(serverID) ?? 0) + 1;
    this.resyncEpochs.set(serverID, next);
    return next;
  }

  /** True while a resync is still the newest one for its host. */
  isResyncCurrent(serverID: string, epoch: number): boolean {
    return this.resyncEpochs.get(serverID) === epoch;
  }

  /** Starts a new refresh for one job kind; the other kind is untouched. */
  nextJobRefresh(key: string, kind: JobKind): number {
    const current = this.jobEpochs.get(key) ?? { worker: 0, shell: 0 };
    const epoch = current[kind] + 1;
    this.jobEpochs.set(key, { ...current, [kind]: epoch });
    return epoch;
  }

  isJobRefreshCurrent(key: string, kind: JobKind, epoch: number): boolean {
    return (this.jobEpochs.get(key)?.[kind] ?? 0) === epoch;
  }

  /** Bumps both kinds rather than deleting them, so old replies cannot pass again. */
  invalidateJobRefresh(key: string): void {
    const current = this.jobEpochs.get(key) ?? { worker: 0, shell: 0 };
    this.jobEpochs.set(key, { worker: current.worker + 1, shell: current.shell + 1 });
  }

  jobKeys(): readonly string[] {
    return [...this.jobEpochs.keys()];
  }

  /** Current global execution-event clock, captured before a snapshot read. */
  eventClock(): number {
    return this.runningEventSequence;
  }

  /** Newest execution-event stamp observed for a session key. */
  eventSequence(key: string): number {
    return this.runningEventSeq.get(key) ?? 0;
  }

  /** Stamps a new execution event for one session key. */
  nextEventSequence(key: string): number {
    this.runningEventSequence += 1;
    this.runningEventSeq.set(key, this.runningEventSequence);
    return this.runningEventSequence;
  }

  forgetEvents(key: string): void {
    this.runningEventSeq.delete(key);
  }

  /** Current global usage-event clock. */
  usageClock(): number {
    return this.usageEventSequence;
  }

  /** Newest usage-event stamp observed for a session key. */
  usageEvidence(key: string): number {
    return this.usageByKey.get(key) ?? 0;
  }

  /** Stamps a new usage event for one session key. */
  nextUsageSequence(key: string): number {
    this.usageEventSequence += 1;
    this.usageByKey.set(key, this.usageEventSequence);
    return this.usageEventSequence;
  }

  forgetUsage(key: string): void {
    this.usageByKey.delete(key);
  }

  /** All session keys with retained usage evidence, for host teardown. */
  usageKeys(): readonly string[] {
    return [...this.usageByKey.keys()];
  }
}
