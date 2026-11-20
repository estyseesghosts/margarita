import type { TranscriptNode } from './transcript.ts';

/**
 * Server-confirmed background subagent job, normalized from `experimental.job.list`.
 * No client-side progress is invented: `status` is the server's own job state, and a
 * missing job means "not reported", never "finished".
 */
export type WorkerStatus = 'running' | 'completed' | 'error' | 'cancelled';

export type WorkerJob = Readonly<{
  id: string;
  /** Session the worker actually ran in; its transcript is where the result lives. */
  childSessionID: string;
  agent: string;
  description: string;
  title?: string;
  status: WorkerStatus;
  startedAt: number;
  completedAt?: number;
}>;

export type WorkerNode = Extract<TranscriptNode, { kind: 'worker' }>;

/** Worker rows share the generic expansion store, scoped by the active route prefix. */
export function workerNodeKey(id: string): string {
  return `worker:${id}`;
}

const statusLabels: Record<WorkerStatus, string> = {
  running: 'running',
  completed: 'returned',
  error: 'failed',
  cancelled: 'cancelled',
};

/** Honest display label; `completed` means the worker returned, not that its work was correct. */
export function workerStatusLabel(status: WorkerStatus): string {
  return statusLabels[status];
}

/**
 * Deterministic worker rows: running first, then oldest first, then id. The server's array
 * order is not stable, and two hosts driving the same parent must produce the same layout.
 */
export function workerNodes(
  jobs: readonly WorkerJob[],
  expanded: ReadonlySet<string>,
): WorkerNode[] {
  const order: Record<WorkerStatus, number> = {
    running: 0,
    error: 1,
    cancelled: 2,
    completed: 3,
  };
  return jobs
    .toSorted(
      (a, b) =>
        order[a.status] - order[b.status] || a.startedAt - b.startedAt || a.id.localeCompare(b.id),
    )
    .map((worker) => ({
      kind: 'worker' as const,
      key: workerNodeKey(worker.id),
      worker,
      expanded: expanded.has(workerNodeKey(worker.id)),
    }));
}
