/**
 * Pure snapshot-commit and page-derivation logic for session refresh (#308).
 *
 * Session refresh has several correctness rules that are easy to break and hard
 * to see inside a large controller method: one host's failure must not clobber
 * another's rows; a live usage event newer than the snapshot wins over the
 * snapshot's cost/tokens; and a host removed mid-flight must not resurrect rows.
 * This module owns the pure part of that commit so it can be tested without a
 * store, backend or controller.
 */
import type { SessionSummary } from '../domain/session.ts';

/** The verified per-host result a refresh produces before it is committed. */
export interface SnapshotResult {
  readonly serverID: string;
  readonly ok: boolean;
  readonly error: string | undefined;
  readonly fresh: Readonly<Record<string, SessionSummary>>;
  readonly active: ReadonlySet<string>;
  readonly cursor: string | undefined;
  /** Usage clock captured before the read; newer evidence must survive the commit. */
  readonly usageSeq: number;
}

/** One host's page metadata after a refresh. */
export interface SessionPage {
  readonly cursor?: string;
  readonly complete: boolean;
  readonly loading: boolean;
  readonly error?: string;
}

/**
 * Merges one verified snapshot into the cached rows.
 *
 * `found` are cached rows the listing omitted but reconciliation confirmed.
 * `fresh` is the authoritative listing. When a live usage event landed after the
 * snapshot was captured, its cost/tokens are kept instead of the older snapshot
 * values (#272); otherwise the server's row wins wholesale.
 */
export function mergeCommittedSessions(
  current: Readonly<Record<string, SessionSummary>>,
  fresh: Readonly<Record<string, SessionSummary>>,
  found: Readonly<Record<string, SessionSummary>>,
  usageSeq: number,
  usageEvidence: (key: string) => number,
): Record<string, SessionSummary> {
  const merged: Record<string, SessionSummary> = {};
  for (const [key, summary] of Object.entries(fresh)) {
    const existing = current[key];
    const liveUsageAdvanced = usageEvidence(key) > usageSeq;
    merged[key] =
      liveUsageAdvanced && existing !== undefined
        ? {
            ...summary,
            ...(existing.cost === undefined ? {} : { cost: existing.cost }),
            ...(existing.tokens === undefined ? {} : { tokens: existing.tokens }),
          }
        : summary;
  }
  return { ...current, ...found, ...merged };
}

/**
 * Derives one host's page metadata from its refresh result. An absent cursor
 * proves exhaustion only when the listing actually succeeded: a failed read has
 * no cursor either, but its rows were never enumerated (#327).
 */
export function sessionPage(result: Pick<SnapshotResult, 'ok' | 'cursor' | 'error'>): SessionPage {
  return {
    ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
    complete: result.ok && result.cursor === undefined,
    loading: false,
    ...(result.ok ? {} : { error: result.error ?? 'Could not reach the server' }),
  };
}

/** Aggregate loading/complete/cursor/error flags for a whole refresh. */
export interface SessionFlags {
  readonly complete: boolean;
  readonly cursor: string | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
}

/**
 * Global completeness is derived from the current, registered per-host page state after
 * commits, never from a refresh's own result list: stale or discarded results, an empty
 * `every([])`, and a failed/unattempted host must never be promoted to complete (#327).
 * A full refresh still carries the aggregate cursor, but only a refresh that committed a
 * host publishes aggregate flags, so a newer in-flight refresh keeps its loading/error state.
 */
export function sessionFlags(
  applied: readonly SnapshotResult[],
  committedCount: number,
  allServersComplete: () => boolean,
  serverID: string | undefined,
): SessionFlags {
  return {
    complete: committedCount > 0 && allServersComplete(),
    cursor:
      serverID === undefined
        ? applied.find((result) => result.cursor !== undefined)?.cursor
        : undefined,
    loading: committedCount > 0,
    error: applied.find((result) => !result.ok)?.error,
  };
}
