import type { WorkerStatus } from './worker.ts';

/**
 * Server-confirmed shell job from `experimental.job.list({ kind: 'shell' })` (#103).
 * v2.3.1 moves a timed-out foreground shell to the background instead of killing it; the
 * transcript message still says `timeout`, so the running job is the only authoritative
 * evidence that the command is still alive. No lifecycle is invented from tool names.
 */
export type ShellJob = Readonly<{
  id: string;
  /** Matches `SessionMessageShell.shellID`, the stable identity of the command. */
  shellID: string;
  sessionID: string;
  status: WorkerStatus;
  title?: string;
  startedAt: number;
  completedAt?: number;
}>;

/** True only when the server reports this shell as actively running. */
export function shellRunningInBackground(
  jobs: readonly ShellJob[] | undefined,
  shellID: string | undefined,
): boolean {
  if (shellID === undefined || jobs === undefined) return false;
  return jobs.some((job) => job.shellID === shellID && job.status === 'running');
}

/** Freshness of the cached job list, supplied by the caller's last refresh outcome. */
export type ShellJobFreshness = 'confirmed' | 'stale' | 'unavailable' | undefined;

/**
 * What the transcript may honestly say about a timed-out shell (#259). Only a confirmed
 * list supports "still running"; retained rows after a failed refresh are last-known.
 */
export type ShellBackgroundState =
  'confirmed-running' | 'last-known-running' | 'not-reported' | 'confirmed-not-running';

export function shellBackgroundState(
  jobs: readonly ShellJob[] | undefined,
  shellID: string | undefined,
  freshness: ShellJobFreshness,
): ShellBackgroundState {
  if (shellID === undefined || jobs === undefined) return 'not-reported';
  const job = jobs.find((entry) => entry.shellID === shellID);
  if (job === undefined)
    return freshness === 'confirmed' ? 'confirmed-not-running' : 'not-reported';
  if (job.status !== 'running') return 'confirmed-not-running';
  return freshness === 'confirmed' ? 'confirmed-running' : 'last-known-running';
}
