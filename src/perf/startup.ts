/**
 * Monotonic cold-start timeline (#345).
 *
 * Every stage is recorded in memory with `performance.now()` and serialized once at the end of
 * startup or on failure. No stage writes to disk, stdout, or a log on the hot path, and no
 * stage accepts transcript, credential, or URL content: the payload is only stage names and
 * millisecond offsets.
 */

/** Ordered, user-visible startup milestones. */
export const startupStages = [
  'process-entry',
  'execute-entry',
  'config-loaded',
  'profiles-loaded',
  'connection-ready',
  'state-loaded',
  'assembly-ready',
  'renderer-created',
  'ui-mounted',
  'first-frame',
  'session-page-ready',
  'catalog-ready',
  'session-index-complete',
  'request-hydration-ready',
  'post-mount-maintenance',
  'composer-ready',
] as const;

export type StartupStage = (typeof startupStages)[number];

export type StartupStageRecord = Readonly<{
  stage: StartupStage;
  /** Milliseconds since process entry. */
  atMs: number;
  /** Milliseconds since the previous recorded stage, when there is one. */
  deltaMs?: number;
}>;

export type StartupTimelineSnapshot = Readonly<{
  clock: 'monotonic';
  stages: readonly StartupStageRecord[];
  /** Elapsed milliseconds between two stages, present only when both were recorded. */
  spans: Readonly<Record<string, number>>;
  /** Stages that are not applicable or were never reached. */
  missing: readonly StartupStage[];
}>;

export interface StartupTimeline {
  /** Records one stage at the current monotonic time; later calls for the same stage win. */
  mark(stage: StartupStage): void;
  /** Records one stage at an explicit monotonic time (used for controller-owned milestones). */
  markAt(stage: StartupStage, atMs: number): void;
  /** True when the stage has been recorded. */
  has(stage: StartupStage): boolean;
  /** Serializes the recorded stages and named spans. Idempotent and side-effect free. */
  snapshot(): StartupTimelineSnapshot;
}

export type StartupTimelineOptions = Readonly<{
  /** Monotonic clock in milliseconds. Production and benchmarks use performance.now. */
  clock?: () => number;
}>;

/**
 * Creates one in-memory timeline. `atMs` values are milliseconds since the timeline's origin,
 * which callers should place at process entry. Stages may be recorded out of order because the
 * renderer, controller and deferred maintenance run independently; the snapshot preserves
 * insertion order and computes deltas in that order.
 */
export function createStartupTimeline(options: StartupTimelineOptions = {}): StartupTimeline {
  const clock = options.clock ?? (() => performance.now());
  const origin = clock();
  const records = new Map<StartupStage, number>();

  return {
    mark(stage) {
      records.set(stage, Math.max(0, clock() - origin));
    },
    markAt(stage, atMs) {
      records.set(stage, Math.max(0, atMs));
    },
    has(stage) {
      return records.has(stage);
    },
    snapshot() {
      const stages: StartupStageRecord[] = [];
      let previous: number | undefined;
      for (const [stage, atMs] of records) {
        stages.push({
          stage,
          atMs,
          ...(previous === undefined ? {} : { deltaMs: Math.max(0, atMs - previous) }),
        });
        previous = atMs;
      }
      return {
        clock: 'monotonic',
        stages,
        spans: startupSpans(records),
        missing: startupStages.filter((stage) => !records.has(stage)),
      };
    },
  };
}

/** The named distinctions the startup ticket requires; absent means "not measured". */
export const startupSpanPairs = [
  ['process-entry', 'first-frame'],
  ['process-entry', 'session-page-ready'],
  ['process-entry', 'composer-ready'],
  ['process-entry', 'session-index-complete'],
  ['session-page-ready', 'session-index-complete'],
  ['session-page-ready', 'composer-ready'],
  ['session-page-ready', 'request-hydration-ready'],
] as const;

function startupSpans(records: ReadonlyMap<StartupStage, number>): Record<string, number> {
  const spans: Record<string, number> = {};
  for (const [from, to] of startupSpanPairs) {
    const start = records.get(from);
    const end = records.get(to);
    if (start === undefined || end === undefined) continue;
    spans[`${from}->${to}`] = Math.max(0, end - start);
  }
  return spans;
}
