/**
 * Reads the authoritative session index for one host (#308).
 *
 * Host identity, the server-qualified key function and the read generation are
 * explicit inputs. The fetcher never selects navigation, writes the reactive
 * store or falls back to a different server when a host is gone.
 */
import type { Backend } from '../adapter/backend.ts';
import { BackendError } from '../adapter/backend.ts';
import type { SessionRef } from '../domain/server-identity.ts';
import { sessionKey } from '../domain/server-identity.ts';
import type { SessionSummary } from '../domain/session.ts';

/** Explicit dependencies for one index read. */
export interface SessionFetchDeps {
  /** Fails closed for an unknown or removed server; never returns another host's backend. */
  readonly backendFor: (serverID: string) => Backend;
  readonly keyFor: (serverID: string, sessionID: string) => string;
  readonly pageLimit: number;
  readonly concurrency: number;
}

/** One host's paged snapshot, stamped with the generation it was admitted under. */
export interface ServerSessionPage {
  readonly serverID: string;
  readonly epoch: number;
  readonly fresh: Record<string, SessionSummary>;
  /**
   * Last-known active session IDs, present only when the activity read succeeded. Absence
   * means running evidence is stale/unknown — never "every session stopped" (#341).
   */
  readonly active?: ReadonlySet<string>;
  /** Diagnostic when the activity read failed; identity and paging remain valid (#341). */
  readonly activeError?: string;
  readonly cursor?: string;
}

/** Cached rows a listing omitted, resolved individually against their owning hosts. */
export interface ReconciledSessions {
  readonly found: Record<string, SessionSummary>;
  readonly deleted: SessionRef[];
}

/** One page of session rows, independent of the slower activity capability. */
export interface SessionPageSlice {
  readonly sessions: readonly SessionSummary[];
  readonly nextCursor?: string;
}

/** The current active-session set, or a truthful failure that leaves evidence unknown. */
export interface SessionActivity {
  readonly active?: ReadonlySet<string>;
  readonly activeError?: string;
}

/** Owns paged session reads and definite-not-found reconciliation. */
export class SessionFetcher {
  constructor(private readonly deps: SessionFetchDeps) {}

  /**
   * Reads exactly one page (#347). The caller publishes it immediately and keeps the cursor
   * for the next page, so a slow server or later pages never withhold usable rows.
   */
  async loadPage(serverID: string, cursor?: string): Promise<SessionPageSlice> {
    const backend = this.deps.backendFor(serverID);
    const page = await backend.listSessions(cursor === undefined ? {} : { cursor });
    return {
      sessions: page.sessions.map((session) => ({ ...session, serverID })),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  /**
   * Reads activity independently of identity/pagination. A failed lookup is reported, never
   * treated as "every session stopped" (#341, #347).
   */
  async loadActivity(serverID: string): Promise<SessionActivity> {
    try {
      return { active: await this.deps.backendFor(serverID).activeSessionIDs() };
    } catch (error) {
      return { activeError: error instanceof Error ? error.message : 'Activity lookup failed' };
    }
  }

  /**
   * Bounded full read kept as the correctness reference and for non-interactive callers.
   * Interactive startup uses `loadPage` progressively instead.
   */
  async loadServer(serverID: string, epoch: number): Promise<ServerSessionPage> {
    const backend = this.deps.backendFor(serverID);
    const loaded: SessionSummary[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await backend.listSessions(cursor === undefined ? {} : { cursor });
      // Trust the backend's server stamp when present; otherwise this server owns the row.
      loaded.push(...page.sessions.map((session) => ({ ...session, serverID })));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < this.deps.pageLimit);
    const page: ServerSessionPage = {
      serverID,
      fresh: Object.fromEntries(
        loaded.map((session) => [this.deps.keyFor(serverID, session.id), session]),
      ),
      epoch,
      ...(cursor === undefined ? {} : { cursor }),
    };
    // Activity is a separate, less authoritative capability than session identity and
    // pagination. A failed activity lookup must not throw away a successful listing: report
    // the cause distinctly and leave running evidence unknown (#341). The caller's epoch and
    // registration guards still reject the whole page if the host was replaced mid-read.
    const activity = await this.loadActivity(serverID);
    return {
      ...page,
      ...(activity.active === undefined ? {} : { active: activity.active }),
      ...(activity.activeError === undefined ? {} : { activeError: activity.activeError }),
    };
  }

  async reconcile(refs: readonly SessionRef[]): Promise<ReconciledSessions> {
    const found: Record<string, SessionSummary> = {};
    const deleted: SessionRef[] = [];
    for (let start = 0; start < refs.length; start += this.deps.concurrency) {
      await Promise.all(
        refs.slice(start, start + this.deps.concurrency).map(async (ref) => {
          try {
            found[sessionKey(ref)] = {
              ...(await this.deps.backendFor(ref.serverID).getSession(ref.sessionID)),
              serverID: ref.serverID,
            };
          } catch (error) {
            if (error instanceof BackendError && error.kind === 'not-found') deleted.push(ref);
            // Any other failure proves nothing: keep the row. A host removed mid-
            // reconciliation is not reconcilable here and is skipped entirely.
          }
        }),
      );
    }
    return { found, deleted };
  }
}
