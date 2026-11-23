import { describe, expect, test } from 'bun:test';

import { sessionKey } from '../domain/server-identity.ts';
import type { SessionSummary } from '../domain/session.ts';
import { descendantScope } from './descendant-scope.ts';

function session(serverID: string, id: string, parentID?: string): SessionSummary {
  return {
    id,
    serverID,
    projectID: 'p',
    directory: '/work',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    ...(parentID === undefined ? {} : { parentID }),
  };
}

function input(
  sessions: readonly SessionSummary[] = [],
  verified: ReadonlyMap<
    string,
    {
      ancestor: string;
      childEpoch: number;
      ancestorEpoch: number;
    }
  > = new Map(),
  epochs: Readonly<Record<string, number>> = {},
) {
  return {
    serverID: 'local',
    sessionID: 'parent',
    sessions: Object.fromEntries(
      sessions.map((entry) => [
        sessionKey({ serverID: entry.serverID, sessionID: entry.id }),
        entry,
      ]),
    ),
    verified,
    sessionEpoch: (key: string) => epochs[key] ?? 0,
    keyFor: (serverID: string, sessionID: string) => sessionKey({ serverID, sessionID }),
  };
}

describe('descendant request scope (#310)', () => {
  test('includes local descendants and excludes siblings and other hosts', () => {
    const scope = descendantScope(
      input([
        session('local', 'parent'),
        session('local', 'child', 'parent'),
        session('local', 'grandchild', 'child'),
        session('local', 'sibling', 'other-parent'),
        session('remote', 'remote-child', 'parent'),
      ]),
    );
    expect([...scope].toSorted()).toEqual(['child', 'grandchild', 'parent']);
  });

  test('includes a verified child not yet present in the session index', () => {
    const childKey = sessionKey({ serverID: 'local', sessionID: 'unlisted' });
    const verified = new Map([[childKey, { ancestor: 'parent', childEpoch: 3, ancestorEpoch: 0 }]]);
    const scope = descendantScope(input([session('local', 'parent')], verified, { [childKey]: 3 }));
    expect([...scope].toSorted()).toEqual(['parent', 'unlisted']);
  });

  test('rejects stale lifetime evidence and cross-host ancestors', () => {
    const staleKey = sessionKey({ serverID: 'local', sessionID: 'stale' });
    const remoteKey = sessionKey({ serverID: 'remote', sessionID: 'remote-child' });
    const verified = new Map([
      [staleKey, { ancestor: 'parent', childEpoch: 2, ancestorEpoch: 1 }],
      [remoteKey, { ancestor: 'parent', childEpoch: 1, ancestorEpoch: 1 }],
    ]);
    const scope = descendantScope(input([session('local', 'parent')], verified, { [staleKey]: 9 }));
    expect([...scope]).toEqual(['parent']);
  });
});
