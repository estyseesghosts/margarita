/**
 * Pure routing for input-request events (#310).
 *
 * A `global` elicitation or a child-session form belongs to the viewed parent
 * conversation, whose bucket presents the card. An event for a session not yet
 * in the loaded index may also be a child, so the attached conversation is
 * refreshed as well; the caller's scope rule still filters out sibling forms.
 * Host ownership and descendant scope are explicit inputs, so cross-host events
 * can never route to a view on a different server.
 */
export interface RequestTargetInput {
  readonly eventSessionID: string;
  readonly serverID: string;
  /** Whether the event's session is in the loaded index for this host. */
  readonly isKnown: (sessionID: string) => boolean;
  /** The attached conversation, when the route is one on any host. */
  readonly attached: { readonly serverID: string; readonly sessionID: string } | undefined;
  /** The attached conversation plus its verified descendants on a host. */
  readonly scope: (sessionID: string, serverID: string) => ReadonlySet<string>;
}

/** Buckets that must be refreshed for one input-request event, in stable order. */
export function inputRequestRefreshTargets(input: RequestTargetInput): string[] {
  const targets = new Set<string>();
  const known = input.isKnown(input.eventSessionID);
  if (input.eventSessionID !== 'global' && known) targets.add(input.eventSessionID);
  const attached = input.attached;
  if (attached === undefined || attached.serverID !== input.serverID) return [...targets];
  if (input.eventSessionID === 'global' || !known) {
    targets.add(attached.sessionID);
  } else if (input.scope(attached.sessionID, input.serverID).has(input.eventSessionID)) {
    targets.add(attached.sessionID);
  }
  return [...targets];
}
