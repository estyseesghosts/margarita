import { describe, expect, test } from 'bun:test';

import { groupSessions } from './overview-groups.ts';
import {
  localServerID,
  parseProjectKey,
  parseSessionKey,
  projectKey,
  sessionKey,
  sessionRefOf,
} from './server-identity.ts';
import type { SessionSummary } from './session.ts';

function session(id: string, serverID: string, directory: string, updatedAt = 1): SessionSummary {
  return {
    id,
    serverID,
    projectID: 'p',
    directory,
    createdAt: 0,
    updatedAt,
    archived: false,
  };
}

describe('server identity', () => {
  test('the reserved local server keeps legacy bare keys', () => {
    const ref = { serverID: localServerID, sessionID: 'ses_a' };
    expect(sessionKey(ref)).toBe('ses_a');
    expect(parseSessionKey('ses_a')).toEqual(ref);
    expect(projectKey({ serverID: localServerID, directory: '/work/a' }, 'linux')).toBe('/work/a');
  });

  test('sessions with identical IDs on different servers never collide', () => {
    const local = sessionKey({ serverID: localServerID, sessionID: 'ses_a' });
    const remote = sessionKey({ serverID: 'srv_1', sessionID: 'ses_a' });
    const other = sessionKey({ serverID: 'srv_2', sessionID: 'ses_a' });
    expect(new Set([local, remote, other]).size).toBe(3);
    expect(parseSessionKey(remote)).toEqual({ serverID: 'srv_1', sessionID: 'ses_a' });
    expect(parseSessionKey(other)).toEqual({ serverID: 'srv_2', sessionID: 'ses_a' });
  });

  test('server IDs and session IDs round-trip through escaping', () => {
    const ref = { serverID: 'srv/with:colons', sessionID: 'ses/a:b' };
    expect(parseSessionKey(sessionKey(ref))).toEqual(ref);
  });

  test('identity does not depend on a display label or shortname', () => {
    const ref = { serverID: 'srv_1', sessionID: 'ses_a' };
    const first = sessionKey(ref);
    // Renaming a server changes only the label; the identity is the same object.
    expect(sessionKey(ref)).toBe(first);
    expect(parseSessionKey(first).serverID).toBe('srv_1');
  });

  test('legacy bare directory history keys migrate to the local server', () => {
    expect(parseProjectKey('/work/project', 'linux')).toEqual({
      serverID: localServerID,
      directory: '/work/project',
      directoryKey: '/work/project',
    });
  });

  test('project keys separate identical directories on different servers', () => {
    const local = projectKey({ serverID: localServerID, directory: '/work/project' }, 'linux');
    const remote = projectKey({ serverID: 'srv_1', directory: '/work/project' }, 'linux');
    expect(local).not.toBe(remote);
    expect(parseProjectKey(remote, 'linux')).toMatchObject({
      serverID: 'srv_1',
      directory: '/work/project',
      directoryKey: '/work/project',
    });
  });

  test('sessionRefOf carries the owning server', () => {
    expect(sessionRefOf(session('ses_a', 'srv_1', '/work/a'))).toEqual({
      serverID: 'srv_1',
      sessionID: 'ses_a',
    });
  });
});

describe('server-scoped overview groups', () => {
  test('identical session IDs and directories on two servers are separate projects', () => {
    const groups = groupSessions(
      [
        session('ses_a', localServerID, '/work/project'),
        session('ses_a', 'srv_1', '/work/project'),
      ],
      {
        platformFor: () => 'linux' as const,
        showArchived: false,
        showChildren: true,
        activityOf: (entry) => entry.updatedAt,
      },
    );
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((group) => group.key)).size).toBe(2);
    expect(new Set(groups.map((group) => group.serverID))).toEqual(
      new Set([localServerID, 'srv_1']),
    );
  });

  test('groups carry remote markers and stale state without merging activity order', () => {
    const groups = groupSessions(
      [
        session('ses_local', localServerID, '/work/lotus', 10),
        session('ses_remote', 'srv_1', '/work/lotus', 30),
      ],
      {
        platformFor: () => 'linux' as const,
        showArchived: false,
        showChildren: true,
        activityOf: (entry) => entry.updatedAt,
        serverLabelOf: (serverID) => (serverID === 'srv_1' ? 'buildbox' : undefined),
        serverOnline: (serverID) => serverID !== 'srv_1',
      },
    );
    expect(
      groups.map((group) => [group.name, group.remote, group.serverLabel, group.stale]),
    ).toEqual([
      ['lotus', true, 'buildbox', true],
      ['lotus', false, undefined, false],
    ]);
  });
});
