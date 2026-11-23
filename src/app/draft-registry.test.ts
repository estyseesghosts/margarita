import { describe, expect, test } from 'bun:test';

import { projectKey, sessionKey } from '../domain/server-identity.ts';
import { DraftRegistry } from './draft-registry.ts';

function registry(): DraftRegistry {
  return new DraftRegistry({
    projectKey: (directory, serverID) => projectKey({ serverID, directory }, 'linux'),
  });
}

describe('draft registry (#311)', () => {
  test('keys are stable and server-qualified', () => {
    const drafts = registry();
    expect(drafts.keyFor({ kind: 'overview' })).toBe('overview');
    expect(drafts.keyFor({ kind: 'new', serverID: 'local', directory: '/work' })).not.toBe(
      drafts.keyFor({ kind: 'new', serverID: 'remote', directory: '/work' }),
    );
    expect(drafts.keyFor({ kind: 'conversation', serverID: 'local', sessionID: 'ses_same' })).toBe(
      sessionKey({ serverID: 'local', sessionID: 'ses_same' }),
    );
    expect(
      drafts.keyFor({ kind: 'conversation', serverID: 'remote', sessionID: 'ses_same' }),
    ).not.toBe(drafts.keyFor({ kind: 'conversation', serverID: 'local', sessionID: 'ses_same' }));
  });

  test('revisions are per route and only change on bump', () => {
    const drafts = registry();
    const local = drafts.keyFor({ kind: 'conversation', serverID: 'local', sessionID: 'ses' });
    const remote = drafts.keyFor({ kind: 'conversation', serverID: 'remote', sessionID: 'ses' });
    expect(drafts.revision(local)).toBe(0);
    expect(drafts.bump(local)).toBe(1);
    expect(drafts.revision(local)).toBe(1);
    expect(drafts.revision(remote)).toBe(0);
    expect(drafts.revision(local)).toBe(1);
    expect(drafts.bump(local)).toBe(2);
    expect(drafts.bump(remote)).toBe(1);
  });

  test('an origin captured before an edit no longer matches its revision', () => {
    const drafts = registry();
    const key = drafts.keyFor({ kind: 'new', serverID: 'local', directory: '/work' });
    const captured = drafts.revision(key);
    expect(drafts.revision(key) === captured).toBe(true);
    drafts.bump(key);
    expect(drafts.revision(key) === captured).toBe(false);
  });
});
