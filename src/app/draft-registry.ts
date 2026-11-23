/**
 * Route-scoped draft identity and revisions (#311).
 *
 * Drafts are frontend-owned and must never collide across hosts. This service
 * owns the stable key for each route and the monotone revision that guards
 * late paste/editor/submission results; it does not own draft text or attachments.
 */
import { sessionKey } from '../domain/server-identity.ts';
import type { Route } from './app-state.ts';

/** Project-key computation supplied by the owning controller's platform rules. */
export interface DraftRegistryDeps {
  projectKey(directory: string, serverID: string): string;
}

/** Owns route keys and per-route draft revisions. */
export class DraftRegistry {
  private readonly revisions = new Map<string, number>();

  constructor(private readonly deps: DraftRegistryDeps) {}

  /** Stable, server-qualified key for a route; two hosts never share a draft. */
  keyFor(route: Route): string {
    switch (route.kind) {
      case 'overview':
        return 'overview';
      case 'new':
        return `new:${this.deps.projectKey(route.directory, route.serverID)}`;
      default:
        return sessionKey({ serverID: route.serverID, sessionID: route.sessionID });
    }
  }

  /** Current revision; a parked route keeps its value until its draft is edited. */
  revision(key: string): number {
    return this.revisions.get(key) ?? 0;
  }

  /** Bumps one route's revision and returns the new value. */
  bump(key: string): number {
    const next = this.revision(key) + 1;
    this.revisions.set(key, next);
    return next;
  }
}
