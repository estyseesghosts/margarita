/**
 * Pure route-ownership rules for event and resync admission (#308).
 *
 * Events are hints scoped to one host: the overview belongs to the project being
 * viewed, while a conversation belongs to its owning server. These rules decide
 * which host a route is attached to and which conversation, if any, is the
 * attached one on a given host — always read from the current route, never a
 * captured one, so a navigation during an await keeps the new route fresh (#275).
 */
import type { Route } from './app-state.ts';

/** The host a route belongs to; the overview uses the viewed project's host. */
export function routeServerFor(route: Route, overviewServerID: string): string {
  return route.kind === 'overview' ? overviewServerID : route.serverID;
}

/** The attached conversation on `serverID`, if the current route is one on that host. */
export function attachedSessionFor(route: Route, serverID: string): string | undefined {
  return route.kind === 'conversation' && route.serverID === serverID ? route.sessionID : undefined;
}
