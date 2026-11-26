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

/** Additional sessions exposed by one `Show more`/`Older`/`Newer` step. */
export const groupPageSize = 24;

/**
 * Bounded viewing window for one project. `start` indexes the oldest visible session (0 is
 * the newest), and `count` never exceeds a page plus the collapsed rows. No expansion can
 * mount an entire workdir: paging moves this window instead of growing it.
 */
export interface OverviewGroupWindow {
  readonly start: number;
  readonly count: number;
}

export const collapsedGroupWindow: OverviewGroupWindow = {
  start: 0,
  count: collapsedSessionLimit,
};

/** The action attached to an overview group control row. */
export type GroupWindowAction = 'showMore' | 'showLess' | 'older' | 'newer';

/** Row key for the pagination row rendered below the last group. */
export const loadMoreRowKey = 'loadmore';

/** One selectable overview line: a session, a group control, or global pagination. */
export type OverviewRow =
  | Readonly<{ kind: 'session'; key: string; groupKey: string; session: SessionSummary }>
  | Readonly<{
      kind: 'toggle';
      key: string;
      groupKey: string;
      action: GroupWindowAction;
      hidden: number;
    }>
  | Readonly<{ kind: 'loadmore'; key: typeof loadMoreRowKey }>;

export function sessionRowKey(ref: SessionRef): string {
  return `session:${sessionKey(ref)}`;
}

export function toggleRowKey(groupKey: string): string {
  return `toggle:${groupKey}`;
}

export function olderRowKey(groupKey: string): string {
  return `older:${groupKey}`;
}

export function newerRowKey(groupKey: string): string {
  return `newer:${groupKey}`;
}

/**
 * Repairs a stored window after regrouping, filtering or pagination changes the group's
 * length. Stale offsets are clamped to the current session count, and an over-wide window
 * is reduced; a window from a project that no longer exists simply falls back to collapsed.
 */
export function repairGroupWindow(
  window: OverviewGroupWindow | undefined,
  total: number,
): OverviewGroupWindow {
  if (window === undefined || total <= collapsedSessionLimit) return collapsedGroupWindow;
  const count = Math.max(collapsedSessionLimit, Math.min(total, window.count));
  const start = Math.max(0, Math.min(total - count, window.start));
  return { start, count };
}

/** Applies one control action to a window. The result always has bounded `count`. */
export function moveGroupWindow(
  window: OverviewGroupWindow,
  action: GroupWindowAction,
  total: number,
): OverviewGroupWindow {
  const bounded = repairGroupWindow(window, total);
  const pageCount = Math.min(total, collapsedSessionLimit + groupPageSize);
  switch (action) {
    case 'showMore':
      return { start: 0, count: pageCount };
    case 'showLess':
      return collapsedGroupWindow;
    case 'older': {
      // A collapsed window has no Older control; paging from it first exposes one page.
      const current =
        bounded.count > collapsedSessionLimit ? bounded : { start: 0, count: pageCount };
      return {
        start: Math.min(Math.max(0, total - current.count), current.start + groupPageSize),
        count: current.count,
      };
    }
    case 'newer': {
      const current =
        bounded.count > collapsedSessionLimit ? bounded : { start: 0, count: pageCount };
      return {
        start: Math.max(0, current.start - groupPageSize),
        count: current.count,
      };
    }
    default:
      return collapsedGroupWindow;
  }
}

/** Visible rows of one group: a bounded window plus controls for hidden sessions. */
export function groupRows(group: ProjectGroup, window: OverviewGroupWindow): OverviewRow[] {
  const bounded = repairGroupWindow(window, group.sessions.length);
  const end = bounded.start + bounded.count;
  const rows: OverviewRow[] = [];
  if (bounded.start > 0) {
    rows.push({
      kind: 'toggle',
      key: newerRowKey(group.key),
      groupKey: group.key,
      action: 'newer',
      hidden: bounded.start,
    });
  }
  for (const session of group.sessions.slice(bounded.start, end)) {
    rows.push({
      kind: 'session',
      key: sessionRowKey({ serverID: session.serverID, sessionID: session.id }),
      groupKey: group.key,
      session,
    });
  }
  // A collapsed window already has Show more; Older only makes sense once paging is open.
  if (end < group.sessions.length && bounded.count > collapsedSessionLimit) {
    rows.push({
      kind: 'toggle',
      key: olderRowKey(group.key),
      groupKey: group.key,
      action: 'older',
      hidden: group.sessions.length - end,
    });
  }
  if (bounded.count > collapsedSessionLimit) {
    rows.push({
      kind: 'toggle',
      key: toggleRowKey(group.key),
      groupKey: group.key,
      action: 'showLess',
      hidden: 0,
    });
  } else if (group.sessions.length > collapsedSessionLimit) {
    rows.push({
      kind: 'toggle',
      key: toggleRowKey(group.key),
      groupKey: group.key,
      action: 'showMore',
      hidden: group.sessions.length - collapsedSessionLimit,
    });
  }
  return rows;
}
