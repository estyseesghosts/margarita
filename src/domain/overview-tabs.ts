import { localServerID } from './server-identity.ts';
import type { SessionStatus } from './session-status.ts';
import type { SessionSummary } from './session.ts';

/** Five filters over the same aggregated session index. */
export type OverviewTab = 'all' | 'local' | 'remotes' | 'active' | 'needs-input';

export const overviewTabs: readonly OverviewTab[] = [
  'all',
  'local',
  'remotes',
  'active',
  'needs-input',
];

export type TabContext = Readonly<{
  statusOf: (session: SessionSummary) => SessionStatus;
  online: (serverID: string) => boolean;
}>;

/** Membership uses the shared status classifier; stale/unknown never counts as active. */
export function sessionInTab(
  session: SessionSummary,
  tab: OverviewTab,
  context: TabContext,
): boolean {
  switch (tab) {
    case 'all':
      return true;
    case 'local':
      return session.serverID === localServerID;
    case 'remotes':
      return session.serverID !== localServerID;
    case 'active': {
      if (!context.online(session.serverID)) return false;
      const status = context.statusOf(session);
      return status === 'working' || status === 'needs-input';
    }
    case 'needs-input':
      return context.online(session.serverID) && context.statusOf(session) === 'needs-input';
    default:
      return false;
  }
}

export function filterSessions(
  sessions: readonly SessionSummary[],
  tab: OverviewTab,
  context: TabContext,
): SessionSummary[] {
  return sessions.filter((session) => sessionInTab(session, tab, context));
}

/** Counts over the same index. Callers label partially paginated data as loaded counts. */
export function tabCounts(
  sessions: readonly SessionSummary[],
  context: TabContext,
): Record<OverviewTab, number> {
  const counts: Record<OverviewTab, number> = {
    all: 0,
    local: 0,
    remotes: 0,
    active: 0,
    'needs-input': 0,
  };
  for (const session of sessions) {
    for (const tab of overviewTabs) {
      if (sessionInTab(session, tab, context)) counts[tab] += 1;
    }
  }
  return counts;
}

export function nextTab(current: OverviewTab, direction: -1 | 1): OverviewTab {
  const index = overviewTabs.indexOf(current);
  const next = (index + direction + overviewTabs.length) % overviewTabs.length;
  return overviewTabs[next] ?? 'all';
}
