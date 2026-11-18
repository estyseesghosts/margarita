import { describe, expect, test } from 'bun:test';

import { filterSessions, nextTab, tabCounts } from './overview-tabs.ts';
import type { SessionSummary } from './session.ts';

function session(id: string, serverID: string, archived = false): SessionSummary {
  return {
    id,
    serverID,
    projectID: 'p',
    directory: '/work/a',
    createdAt: 0,
    updatedAt: 0,
    archived,
  };
}

const statuses: Record<string, 'idle' | 'failed' | 'needs-input' | 'working'> = {
  ses_idle: 'idle',
  ses_work: 'working',
  ses_wait: 'needs-input',
  ses_fail: 'failed',
};

const context = {
  statusOf: (entry: SessionSummary) => statuses[entry.id] ?? 'idle',
  online: () => true,
};

const sessions = [
  session('ses_idle', 'local'),
  session('ses_work', 'local'),
  session('ses_wait', 'srv_1'),
  session('ses_fail', 'srv_2'),
];

describe('overview tabs', () => {
  test('membership across all five tabs uses the shared classifier', () => {
    expect(filterSessions(sessions, 'all', context)).toHaveLength(4);
    expect(filterSessions(sessions, 'local', context).map((s) => s.id)).toEqual([
      'ses_idle',
      'ses_work',
    ]);
    expect(filterSessions(sessions, 'remotes', context).map((s) => s.id)).toEqual([
      'ses_wait',
      'ses_fail',
    ]);
    expect(filterSessions(sessions, 'active', context).map((s) => s.id)).toEqual([
      'ses_work',
      'ses_wait',
    ]);
    expect(filterSessions(sessions, 'needs-input', context).map((s) => s.id)).toEqual(['ses_wait']);
  });

  test('counts come from the same membership and no row is duplicated within a tab', () => {
    expect(tabCounts(sessions, context)).toEqual({
      all: 4,
      local: 2,
      remotes: 2,
      active: 2,
      'needs-input': 1,
    });
  });

  test('offline hosts never count as active or needs input', () => {
    const offline = { statusOf: context.statusOf, online: () => false };
    expect(filterSessions(sessions, 'active', offline)).toEqual([]);
    expect(filterSessions(sessions, 'needs-input', offline)).toEqual([]);
  });

  test('tab cycling wraps', () => {
    expect(nextTab('all', 1)).toBe('local');
    expect(nextTab('all', -1)).toBe('needs-input');
  });
});
