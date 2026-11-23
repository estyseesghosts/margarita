/**
 * Owns the monotonic generations that reject stale asynchronous replies (#308).
 *
 * Every map/counter here exists to answer one question: was the response that just
 * arrived still the newest authoritative work for its host, session or event stream
 * when it landed? Keeping them together gives each generation one writer and one
 * named invalidation operation.
 */
export class RefreshGenerations {
  private readonly refreshEpoch = new Map<string, number>();
  private readonly sessionEpochs = new Map<string, number>();
  private readonly resyncEpochs = new Map<string, number>();
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
