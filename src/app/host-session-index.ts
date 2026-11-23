/**
 * Per-host stream status and index health reporting (#308, first slice).
 *
 * The viewed conversation's footer must reflect its own host, not the launch server's badge
 * (#109), so status is keyed by host with the launch badge only as a fallback. A transition
 * also decides which reactive and reconnect effects belong inside the store batch and which
 * must run after it. The health rule is shared by the full and paged index reads so a stale
 * or removed host can never publish a health result. The controller supplies all inputs and
 * executes the returned commands; this module owns no store, backend or navigation.
 */
import type { StreamStatus } from '../adapter/event-pump.ts';

/** One effect of a stream-status transition, in execution order. */
export type HostStreamCommand =
  | { kind: 'bump-overview' }
  | { kind: 'clear-runtime'; serverID: string }
  | { kind: 'set-badge'; status: StreamStatus }
  | { kind: 'show-lost-notice' }
  | { kind: 'resync'; serverID: string };

/** Explicit inputs for one host's status transition. */
export interface StreamTransitionContext {
  readonly serverID: string;
  readonly status: StreamStatus;
  readonly launchServerID: string;
  /** The launch badge before the transition; a reconnect→live edge triggers a resync. */
  readonly launchBadge: StreamStatus;
}

/** Ordered effects split at the reactive batch boundary. */
export interface StreamTransition {
  /** Effects that share the store batch with the status write. */
  readonly batched: readonly HostStreamCommand[];
  /** Effects that run after the batch has committed. */
  readonly after: readonly HostStreamCommand[];
}

/** The part of a paged-read result that decides whether health may be reported. */
export interface HealthReport {
  readonly serverID: string;
  readonly epoch: number;
  readonly ok: boolean;
  readonly cause?: unknown;
}

/** One host health report to forward to the owning connection manager. */
export interface HostHealthCommand {
  readonly serverID: string;
  readonly result: { ok: true } | { ok: false; error: unknown };
}

/** Owns per-host stream status and decides the effects of each transition. */
export class HostSessionIndex {
  private readonly statusByServer = new Map<string, StreamStatus>();

  /** A host's own status, falling back to the launch badge (#109). */
  statusOf(serverID: string, fallback: StreamStatus): StreamStatus {
    return this.statusByServer.get(serverID) ?? fallback;
  }

  /** Records a transition and returns its ordered effects. */
  transition(context: StreamTransitionContext): StreamTransition {
    this.statusByServer.set(context.serverID, context.status);
    const batched: HostStreamCommand[] = [{ kind: 'bump-overview' }];
    if (context.status === 'reconnecting') {
      batched.push({ kind: 'clear-runtime', serverID: context.serverID });
    }
    if (context.serverID !== context.launchServerID) return { batched, after: [] };
    const after: HostStreamCommand[] = [{ kind: 'set-badge', status: context.status }];
    if (context.status === 'reconnecting') after.push({ kind: 'show-lost-notice' });
    if (context.status === 'live' && context.launchBadge === 'reconnecting') {
      after.push({ kind: 'resync', serverID: context.serverID });
    }
    return { batched, after };
  }
}

/**
 * Keeps only registered, still-current results and derives the health reports to emit.
 * Shared by the full and paged index reads; both previously duplicated this filter and map.
 */
export function healthCommands<T extends HealthReport>(
  results: readonly T[],
  registered: ReadonlySet<string>,
  isCurrent: (serverID: string, epoch: number) => boolean,
): { applied: T[]; health: HostHealthCommand[] } {
  const applied = results.filter(
    (result) => registered.has(result.serverID) && isCurrent(result.serverID, result.epoch),
  );
  return {
    applied,
    health: applied.map((result) => ({
      serverID: result.serverID,
      result: result.ok ? { ok: true } : { ok: false, error: result.cause },
    })),
  };
}
