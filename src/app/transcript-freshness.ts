/**
 * Pure stale/fresh decisions for transcript lifecycle (#309, fifth slice).
 *
 * A failed read is not authoritative and a resync is not a confirmation of every transcript.
 * These rules decide which transcripts must be marked stale and which failures deserve a
 * bounded retry, using only explicit inputs. The controller still owns the store writes,
 * timers, backend calls and job RPCs; it executes the commands returned here.
 */
/** Inputs for deciding which transcripts a resync left stale. */
export interface ResyncFreshnessInput {
  readonly serverID: string;
  /** Server-qualified transcript keys currently in the store. */
  readonly keys: readonly string[];
  /** Attached conversation on the resynced host, read after the awaits; never captured early. */
  readonly attachedSessionID: string | undefined;
  /** Generations committed before the resync began. */
  readonly committedBefore: ReadonlyMap<string, number>;
  /** Current committed generation for a key. */
  readonly committedNow: (key: string) => number;
  /** Which host owns a qualified key. */
  readonly sessionServerOf: (key: string) => string;
  /** Which session a qualified key names. */
  readonly sessionIDOf: (key: string) => string;
}

/** Sets one transcript's stale flag. */
export interface StaleFlagCommand {
  readonly kind: 'set-stale';
  readonly key: string;
  readonly stale: boolean;
}

/**
 * A transcript stays fresh only when it is the attached conversation AND it committed a
 * newer page during the resync. A detached session is stale even if an old read landed;
 * sessions on other hosts are never touched.
 */
export function planResyncStaleFlags(input: ResyncFreshnessInput): StaleFlagCommand[] {
  const commands: StaleFlagCommand[] = [];
  for (const key of input.keys) {
    if (input.sessionServerOf(key) !== input.serverID) continue;
    const isAttached = input.attachedSessionID === input.sessionIDOf(key);
    const refreshed = input.committedNow(key) > (input.committedBefore.get(key) ?? 0);
    commands.push({ kind: 'set-stale', key, stale: !isAttached || !refreshed });
  }
  return commands;
}

/** Inputs for classifying one failed transcript read. */
export interface TranscriptFailureInput {
  /** Retry-key ("serverID sessionID") and store key for this session. */
  readonly key: string;
  readonly qualifiedKey: string;
  readonly sessionID: string;
  readonly serverID: string;
  /** Whether the session still exists on a registered host and the controller is alive. */
  readonly current: boolean;
  readonly hasTranscript: boolean;
  readonly refreshJobs: boolean;
  readonly dirtyJobs: boolean;
  readonly retryable: boolean;
  /** Returns the next backoff attempt, or undefined when the budget is exhausted. */
  readonly nextAttempt: () => number | undefined;
}

/** One observable effect of a failed transcript read, in order. */
export type TranscriptFailureCommand =
  | { kind: 'reset-retries'; key: string }
  | { kind: 'mark-stale'; qualifiedKey: string }
  | { kind: 'refresh-jobs'; sessionID: string; serverID: string }
  | {
      kind: 'schedule-retry';
      key: string;
      attempt: number;
      sessionID: string;
      serverID: string;
      dirtyJobs: boolean;
    };

/**
 * Keeps the last confirmed transcript and marks it stale. Job hints are independent of
 * transcript success; a permanent failure resets the retry chain instead of retrying forever.
 */
export function classifyTranscriptFailure(
  input: TranscriptFailureInput,
): TranscriptFailureCommand[] {
  if (!input.current) return [{ kind: 'reset-retries', key: input.key }];
  const commands: TranscriptFailureCommand[] = [];
  if (input.hasTranscript) {
    commands.push({ kind: 'mark-stale', qualifiedKey: input.qualifiedKey });
  }
  if (input.refreshJobs || input.dirtyJobs) {
    commands.push({ kind: 'refresh-jobs', sessionID: input.sessionID, serverID: input.serverID });
  }
  if (!input.retryable) {
    commands.push({ kind: 'reset-retries', key: input.key });
    return commands;
  }
  const attempt = input.nextAttempt();
  if (attempt === undefined) return commands;
  commands.push({
    kind: 'schedule-retry',
    key: input.key,
    attempt,
    sessionID: input.sessionID,
    serverID: input.serverID,
    dirtyJobs: input.dirtyJobs,
  });
  return commands;
}
