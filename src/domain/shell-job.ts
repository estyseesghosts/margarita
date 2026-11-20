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
