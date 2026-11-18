import { describe, expect, test } from 'bun:test';

import { type AgentDescriptor, defaultAgent, nextAgent, selectableAgents } from './agent-cycle.ts';
import { groupRows, groupSessions } from './overview-groups.ts';
import { directoryKey, directoryName, isWithin } from './path-identity.ts';
import type { SessionSummary } from './session.ts';
import { formatAge, formatCost, formatTokenCount, formatTokens } from './usage-format.ts';

function session(
  id: string,
  directory: string,
  updatedAt: number,
  extra: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    serverID: 'local',
    projectID: 'p',
    directory,
    createdAt: 0,
    updatedAt,
    archived: false,
    ...extra,
  };
}

const groupOptions = {
  platform: 'win32' as const,
  showArchived: false,
  showChildren: false,
  activityOf: (entry: SessionSummary) => entry.updatedAt,
};

describe('path identity', () => {
  test('windows keys ignore case, separators and trailing slashes', () => {
    expect(directoryKey('C:\\Repo\\Kohjoh\\', 'win32')).toBe(
      directoryKey('c:/repo/kohjoh', 'win32'),
    );
  });
  test('unix keys keep case', () => {
    expect(directoryKey('/src/A', 'linux')).not.toBe(directoryKey('/src/a', 'linux'));
  });
  test('basename tolerates both separators', () => {
    expect(directoryName('C:\\src\\lotus')).toBe('lotus');
    expect(directoryName('/src/lotus/')).toBe('lotus');
  });
  test('isWithin does not match sibling prefixes', () => {
    expect(isWithin('C:\\src\\lotus2', 'C:\\src\\lotus', 'win32')).toBe(false);
    expect(isWithin('C:\\SRC\\lotus\\x', 'c:\\src\\lotus', 'win32')).toBe(true);
  });
});

describe('groupSessions', () => {
  test('groups by canonical directory, newest group and session first', () => {
    const groups = groupSessions(
      [
        session('a', 'C:\\src\\kohjoh', 10),
        session('b', 'c:/src/kohjoh', 30),
        session('c', 'C:\\src\\lotus', 20),
      ],
      groupOptions,
    );
    expect(groups.map((group) => group.name)).toEqual(['kohjoh', 'lotus']);
    expect(groups[0]?.sessions.map((entry) => entry.id)).toEqual(['b', 'a']);
  });
  test('same basename in different roots stays separate', () => {
    const groups = groupSessions(
      [session('a', 'C:\\one\\app', 1), session('b', 'C:\\two\\app', 2)],
      groupOptions,
    );
    expect(groups).toHaveLength(2);
  });
  test('hides archived and child sessions by default', () => {
    const groups = groupSessions(
      [
        session('a', '/x', 1, { archived: true }),
        session('b', '/x', 2, { parentID: 'c' }),
        session('c', '/x', 3),
      ],
      { ...groupOptions, platform: 'linux' },
    );
    expect(groups[0]?.sessions.map((entry) => entry.id)).toEqual(['c']);
  });
});

describe('agent cycle', () => {
  const agents: AgentDescriptor[] = [
    { id: 'zeta', name: 'Zeta', mode: 'primary', hidden: false },
    { id: 'plan', name: 'Plan', mode: 'primary', hidden: false },
    { id: 'explore', name: 'Explore', mode: 'subagent', hidden: false },
    { id: 'build', name: 'Build', mode: 'primary', hidden: false },
    { id: 'secret', name: 'Secret', mode: 'all', hidden: true },
    { id: 'alpha', name: 'Alpha', mode: 'all', hidden: false },
  ];
  const ordered = selectableAgents(agents, ['build', 'plan']);
  test('configured order first, then alphabetical, excluding hidden/subagents', () => {
    expect(ordered.map((agent) => agent.id)).toEqual(['build', 'plan', 'alpha', 'zeta']);
  });
  test('cycles and wraps in both directions', () => {
    expect(nextAgent(ordered, 'build')?.id).toBe('plan');
    expect(nextAgent(ordered, 'zeta')?.id).toBe('build');
    expect(nextAgent(ordered, 'build', -1)?.id).toBe('zeta');
    expect(nextAgent(ordered, 'unknown')?.id).toBe('build');
  });
  test('defaults to build, else first selectable', () => {
    expect(defaultAgent(ordered, 'build')?.id).toBe('build');
    expect(defaultAgent(ordered.slice(1), 'build')?.id).toBe('plan');
  });
});

describe('usage formatting', () => {
  test('cost', () => {
    expect(formatCost(0.384)).toBe('$0.38');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.001)).toBe('<$0.01');
    expect(formatCost(undefined)).toBe('—');
    expect(formatCost(-1)).toBe('—');
  });
  test('tokens round to thousands', () => {
    expect(formatTokenCount(46_400)).toBe('46k');
    expect(formatTokenCount(2_648_309)).toBe('2.6M');
    expect(formatTokenCount(0)).toBe('0');
    expect(
      formatTokens({ input: 42_000, output: 5_000, reasoning: 0, cacheRead: 9, cacheWrite: 0 }),
    ).toBe('42k in · 5k out');
    expect(formatTokens(undefined)).toBe('— tok');
  });
  test('age', () => {
    expect(formatAge(0, 30_000)).toBe('now');
    expect(formatAge(0, 9 * 60_000)).toBe('9m');
    expect(formatAge(0, 3 * 3_600_000)).toBe('3h');
  });
});

describe('groupRows', () => {
  const sessions = Array.from({ length: 8 }, (_, index) => ({
    id: `ses_${index}`,
    serverID: 'local',
    projectID: 'p',
    directory: '/work/a',
    createdAt: 0,
    updatedAt: index,
    archived: false,
  }));
  const [group] = groupSessions(sessions, {
    platform: 'linux',
    showArchived: false,
    showChildren: false,
    activityOf: (entry) => entry.updatedAt,
  });

  test('collapses past six sessions behind a toggle, newest first', () => {
    if (group === undefined) throw new Error('missing group');
    const rows = groupRows(group, false);
    expect(rows.map((row) => row.key)).toEqual([
      'session:ses_7',
      'session:ses_6',
      'session:ses_5',
      'session:ses_4',
      'session:ses_3',
      'session:ses_2',
      `toggle:${group.key}`,
    ]);
    expect(rows.at(-1)).toMatchObject({ kind: 'toggle', expanded: false, hidden: 2 });
  });

  test('expanded shows every session and a Show less toggle', () => {
    if (group === undefined) throw new Error('missing group');
    const rows = groupRows(group, true);
    expect(rows).toHaveLength(9);
    expect(rows.at(-1)).toMatchObject({ kind: 'toggle', expanded: true });
  });

  test('no toggle at or below the limit', () => {
    if (group === undefined) throw new Error('missing group');
    expect(groupRows({ ...group, sessions: group.sessions.slice(0, 6) }, false)).toHaveLength(6);
  });
});
