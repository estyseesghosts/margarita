import { directoryKey, directoryName } from './path-identity.ts';
import type { SessionSummary } from './session.ts';

export type ProjectGroup = Readonly<{
  key: string;
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
    const key = directoryKey(session.directory, options.platform);
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
