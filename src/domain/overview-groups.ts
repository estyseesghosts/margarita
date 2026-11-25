import { directoryName } from './path-identity.ts';
import { localServerID, projectKey, sessionKey, type SessionRef } from './server-identity.ts';
import type { SessionSummary } from './session.ts';

export type ProjectGroup = Readonly<{
  key: string;
  /** Server that owns every session in this group. */
  serverID: string;
  /** Display shortname; absent for the local server. */
  serverLabel?: string;
  /** True when this project lives on a paired remote server. */
  remote: boolean;
  /** True when the group is shown from cache while its server is offline. */
  stale: boolean;
  name: string;
  directory: string;
  sessions: readonly SessionSummary[];
  latestAt: number;
}>;

export type GroupOptions = Readonly<{
  /**
   * Path style of the server that owns each session. Paths are compared with the owning
   * server's OS rules — never the frontend's — so case-distinct Linux directories are not
   * merged by a Windows frontend, and Windows drive/UNC paths compare case-insensitively.
   */
  platformFor: (serverID: string) => NodeJS.Platform;
  showArchived: boolean;
  showChildren: boolean;
  /** Stable activity time per session; avoids rows jumping on every streamed token. */
  activityOf: (session: SessionSummary) => number;
  /** Display shortname per server; absent/undefined means the local server. */
  serverLabelOf?: (serverID: string) => string | undefined;
  /** False when a server is offline/unauthorized but its cached sessions stay visible. */
  serverOnline?: (serverID: string) => boolean;
  /** Group projects (default) or all sessions of one server together. */
  groupBy?: 'project' | 'server';
  /** Order groups by most recent activity (default) or by display name. */
  sortBy?: 'activity' | 'name';
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
    const key =
      options.groupBy === 'server'
        ? `server:${session.serverID}`
        : projectKey(
            { serverID: session.serverID, directory: session.directory },
            options.platformFor(session.serverID),
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
    const serverLabel = options.serverLabelOf?.(first.serverID);
    groups.push({
      key,
      serverID: first.serverID,
      ...(serverLabel === undefined ? {} : { serverLabel }),
      remote: first.serverID !== localServerID,
      stale: options.serverOnline?.(first.serverID) === false,
      name:
        options.groupBy === 'server' && serverLabel !== undefined
          ? serverLabel
          : directoryName(first.directory),
      directory: first.directory,
      sessions: sorted,
      latestAt: options.activityOf(first),
    });
  }
  return groups.toSorted((left, right) => {
    if (options.sortBy === 'name') {
      const byName = left.name.localeCompare(right.name);
      if (byName !== 0) return byName;
    } else {
      const delta = right.latestAt - left.latestAt;
      if (delta !== 0) return delta;
    }
    return left.key.localeCompare(right.key);
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
