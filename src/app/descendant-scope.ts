/**
 * Who may own a permission/form request shown for one conversation (#310).
 *
 * Pure scope computation: local parent links plus server-verified descendants,
 * always scoped to one host and to the lifetimes captured at verification time.
 * Sibling sessions are never included, even with identical IDs on another host.
 */
import { parseSessionKey } from '../domain/server-identity.ts';
import type { SessionSummary } from '../domain/session.ts';

/** A verified child -> viewed-ancestor relationship with both lifetimes captured. */
export interface VerifiedDescendant {
  readonly ancestor: string;
  readonly childEpoch: number;
  readonly ancestorEpoch: number;
}

/** Explicit inputs for one scope computation. */
export interface DescendantScopeInput {
  readonly serverID: string;
  readonly sessionID: string;
  readonly sessions: Readonly<Record<string, SessionSummary>>;
  readonly verified: ReadonlyMap<string, VerifiedDescendant>;
  readonly sessionEpoch: (key: string) => number;
  readonly keyFor: (serverID: string, sessionID: string) => string;
}

/** The attached session plus its descendants on the same host. */
export function descendantScope(input: DescendantScopeInput): Set<string> {
  const scope = new Set([input.sessionID]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of Object.values(input.sessions)) {
      if (
        session.serverID === input.serverID &&
        session.parentID !== undefined &&
        scope.has(session.parentID) &&
        !scope.has(session.id)
      ) {
        scope.add(session.id);
        changed = true;
      }
    }
  }
  // Include children verified from server ancestry even when the local index has not
  // listed them yet. Lifetime epochs keep the association from surviving deletion or
  // ID reuse (#274).
  const ancestorKey = input.keyFor(input.serverID, input.sessionID);
  const ancestorEpoch = input.sessionEpoch(ancestorKey);
  for (const [childKey, verified] of input.verified) {
    if (verified.ancestor !== input.sessionID || verified.ancestorEpoch !== ancestorEpoch) continue;
    const child = parseSessionKey(childKey);
    if (child.serverID !== input.serverID) continue;
    if (input.sessionEpoch(childKey) !== verified.childEpoch) continue;
    scope.add(child.sessionID);
  }
  return scope;
}
