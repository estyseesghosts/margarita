import { directoryName } from './path-identity.ts';
import { projectKey, sessionKey, type SessionRef } from './server-identity.ts';
import type { SessionSummary } from './session.ts';

export type ProjectGroup = Readonly<{
  key: string;
  /** Server that owns every session in this group. */
  serverID: string;
  name: string;
  directory: string;
  sessions: readonly SessionSummary[];
  latestAt: number;
}>;

export type GroupOptions = Readonly<{
  platform: NodeJS.Platform;
  showArchived: boolean;
  showChildren: boolean;
  /** Stable activity time per session; avoids rows jumping on every streamed token. */
  activityOf: (session: SessionSummary) => number;
}>;

/**
 * Groups sessions by canonical project directory. Groups sort by most recent activity;
 * sessions inside a group sort by activity then ID so ordering is deterministic.
 */
export function groupSessions(
  sessions: readonly SessionSummary[],
  options: GroupOptions,
): ProjectGroup[] {
  const buckets = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    if (session.archived && !options.showArchived) continue;
    if (session.parentID !== undefined && !options.showChildren) continue;
    const key = projectKey(
      { serverID: session.serverID, directory: session.directory },
      options.platform,
    );
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [session]);
    else bucket.push(session);
  }
  const groups: ProjectGroup[] = [];
  for (const [key, entries] of buckets) {
    const sorted = entries.toSorted((left, right) => {
      const delta = options.activityOf(right) - options.activityOf(left);
      return delta !== 0 ? delta : left.id.localeCompare(right.id);
    });
    const first = sorted[0];
    if (first === undefined) continue;
    groups.push({
      key,
      serverID: first.serverID,
      name: directoryName(first.directory),
      directory: first.directory,
      sessions: sorted,
      latestAt: options.activityOf(first),
    });
  }
  return groups.toSorted((left, right) => {
    const delta = right.latestAt - left.latestAt;
    return delta !== 0 ? delta : left.key.localeCompare(right.key);
  });
}

/** Sessions shown per project before the rest collapse behind a toggle row. */
export const collapsedSessionLimit = 6;

/** Row key for the pagination row rendered below the last group. */
export const loadMoreRowKey = 'loadmore';

/** One selectable overview line: a session, the inline toggle, or pagination. */
export type OverviewRow =
  | Readonly<{ kind: 'session'; key: string; groupKey: string; session: SessionSummary }>
  | Readonly<{ kind: 'toggle'; key: string; groupKey: string; expanded: boolean; hidden: number }>
  | Readonly<{ kind: 'loadmore'; key: typeof loadMoreRowKey }>;

export function sessionRowKey(ref: SessionRef): string {
  return `session:${sessionKey(ref)}`;
}

export function toggleRowKey(groupKey: string): string {
  return `toggle:${groupKey}`;
}

/** Visible rows of one group: up to the limit when collapsed, plus a toggle when needed. */
export function groupRows(group: ProjectGroup, expanded: boolean): OverviewRow[] {
  const shown = expanded ? group.sessions : group.sessions.slice(0, collapsedSessionLimit);
  const rows: OverviewRow[] = shown.map((session) => ({
    kind: 'session',
    key: sessionRowKey({ serverID: session.serverID, sessionID: session.id }),
    groupKey: group.key,
    session,
  }));
  const hidden = group.sessions.length - collapsedSessionLimit;
  if (hidden > 0) {
    rows.push({
      kind: 'toggle',
      key: toggleRowKey(group.key),
      groupKey: group.key,
      expanded,
      hidden,
    });
  }
  return rows;
}
