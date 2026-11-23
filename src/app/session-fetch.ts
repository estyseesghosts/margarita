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
  readonly active: Set<string>;
  readonly cursor?: string;
}

/** Cached rows a listing omitted, resolved individually against their owning hosts. */
export interface ReconciledSessions {
  readonly found: Record<string, SessionSummary>;
  readonly deleted: SessionRef[];
}

/** Owns paged session reads and definite-not-found reconciliation. */
export class SessionFetcher {
  constructor(private readonly deps: SessionFetchDeps) {}

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
    const active = await backend.activeSessionIDs();
    return {
      serverID,
      fresh: Object.fromEntries(
        loaded.map((session) => [this.deps.keyFor(serverID, session.id), session]),
      ),
      active,
      epoch,
      ...(cursor === undefined ? {} : { cursor }),
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
