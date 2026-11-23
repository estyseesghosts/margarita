import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import type { SessionSummary } from '../domain/session.ts';
import {
  AncestryVerifier,
  type AncestryVerifierDeps,
  type DescendantCheck,
} from './ancestry-verifier.ts';

const backend = new FakeBackend();

function summary(id: string, parentID?: string): SessionSummary {
  return {
    id,
    serverID: 'srv',
    projectID: 'proj',
    directory: '/work',
    ...(parentID === undefined ? {} : { parentID }),
    createdAt: 0,
    updatedAt: 0,
    archived: false,
  };
}

function fixture(overrides: Partial<AncestryVerifierDeps> = {}) {
  const parents = new Map<string, string | undefined>();
  let now = 0;
  let getSessionCalls = 0;
  const deps: AncestryVerifierDeps = {
    backendFor: () => backend,
    isRegistered: () => true,
    getSession: async (_backend, sessionID) => {
      getSessionCalls += 1;
      return summary(sessionID, parents.get(sessionID));
    },
    keyFor: (serverID, sessionID) => `${serverID}|${sessionID}`,
    sessionEpoch: () => 1,
    localSummary: () => undefined,
    isSessionCurrent: () => true,
    now: () => now,
    withTimeout: (check) => check,
    concurrency: 2,
    timeoutMs: 1000,
    budgetMs: 10_000,
    ...overrides,
  };
  return {
    deps,
    verifier: new AncestryVerifier(deps),
    parents,
    advance: (value: number) => {
      now = value;
    },
    getSessionCalls: () => getSessionCalls,
  };
}

describe('ancestry verifier (#310)', () => {
  test('a direct or deep parent chain is verified and cached as evidence', async () => {
    const f = fixture();
    f.parents.set('child', 'mid');
    f.parents.set('mid', 'ancestor');
    expect(await f.verifier.verifyDescendant('child', 'ancestor', 'srv')).toEqual({
      status: 'verified',
    });
    expect(f.verifier.evidence().get('srv|child')).toEqual({
      ancestor: 'ancestor',
      childEpoch: 1,
      ancestorEpoch: 1,
    });
    expect(f.getSessionCalls()).toBe(2);
  });

  test('a missing parent link is unrelated and deliberately not cached', async () => {
    const f = fixture();
    expect(await f.verifier.verifyDescendant('child', 'ancestor', 'srv')).toEqual({
      status: 'unrelated',
    });
    expect(f.verifier.evidence().size).toBe(0);
  });

  test('a cycle and an over-deep chain are unresolved with distinct reasons', async () => {
    const cycle = fixture();
    cycle.parents.set('a', 'b');
    cycle.parents.set('b', 'a');
    expect(await cycle.verifier.verifyDescendant('a', 'ancestor', 'srv')).toEqual({
      status: 'unresolved',
      error: 'the session ancestry contains a cycle',
    });

    const deep = fixture();
    for (let index = 0; index < 40; index += 1) {
      deep.parents.set(`s${index}`, `s${index + 1}`);
    }
    expect(await deep.verifier.verifyDescendant('s0', 'ancestor', 'srv')).toEqual({
      status: 'unresolved',
      error: 'the session ancestry is too deep',
    });
  });

  test('a lifetime change during the walk is unresolved, not trusted', async () => {
    let calls = 0;
    const f = fixture({
      isSessionCurrent: () => {
        calls += 1;
        return calls <= 1;
      },
    });
    f.parents.set('child', 'ancestor');
    expect(await f.verifier.verifyDescendant('child', 'ancestor', 'srv')).toEqual({
      status: 'unresolved',
      error: 'the session lifetime changed during lookup',
    });
  });

  test('matching evidence short-circuits the walk; a changed epoch re-verifies', async () => {
    let epoch = 1;
    const f = fixture({ sessionEpoch: () => epoch });
    f.parents.set('child', 'ancestor');
    expect(await f.verifier.verifyDescendant('child', 'ancestor', 'srv')).toEqual({
      status: 'verified',
    });
    expect(f.getSessionCalls()).toBe(1);
    expect(await f.verifier.verifyDescendant('child', 'ancestor', 'srv')).toEqual({
      status: 'verified',
    });
    expect(f.getSessionCalls()).toBe(1);
    epoch = 2;
    expect(await f.verifier.verifyDescendant('child', 'ancestor', 'srv')).toEqual({
      status: 'verified',
    });
    expect(f.getSessionCalls()).toBe(2);
  });

  test('concurrent checks for the same child share one walk', async () => {
    const f = fixture();
    f.parents.set('child', 'ancestor');
    const [first, second] = await Promise.all([
      f.verifier.verifyDescendant('child', 'ancestor', 'srv'),
      f.verifier.verifyDescendant('child', 'ancestor', 'srv'),
    ]);
    expect(first).toEqual({ status: 'verified' });
    expect(second).toEqual({ status: 'verified' });
    expect(f.getSessionCalls()).toBe(1);
  });

  test('verification buckets classify checks and reports the first error', async () => {
    const f = fixture();
    f.parents.set('verified', 'ancestor');
    f.parents.set('stale', 'stale');
    const result = await f.verifier.verifyUnknownDescendants(
      ['verified', 'unrelated', 'stale'],
      'ancestor',
      'srv',
    );
    expect(result.verified).toEqual(new Set(['verified']));
    expect(result.unrelated).toEqual(new Set(['unrelated']));
    expect(result.pending).toEqual(new Set(['stale']));
    expect(result.error).toBe('the session ancestry contains a cycle');
  });

  test('an exhausted global deadline marks remaining children pending', async () => {
    let now = 0;
    const racing = fixture({
      now: () => now,
      getSession: async (_backend, sessionID) => {
        now = 20_000;
        return summary(sessionID, 'ancestor');
      },
    });
    const result = await racing.verifier.verifyUnknownDescendants(
      ['first', 'second'],
      'ancestor',
      'srv',
    );
    expect(result.verified.size + result.pending.size).toBe(2);
    expect(result.error).toBe('ownership verification ran out of time');
  });

  test('per-host teardown drops only that host evidence', async () => {
    const f = fixture();
    f.parents.set('child', 'ancestor');
    await f.verifier.verifyDescendant('child', 'ancestor', 'srv');
    expect(f.verifier.evidence().size).toBe(1);
    f.verifier.forgetServer('other');
    expect(f.verifier.evidence().size).toBe(1);
    f.verifier.forgetServer('srv');
    expect(f.verifier.evidence().size).toBe(0);
  });

  test('a timed-out walk is retired so a recovered backend can be retried (#332)', async () => {
    const timeouts: Array<() => void> = [];
    let releaseFirst!: (value: SessionSummary) => void;
    let calls = 0;
    const f = fixture({
      withTimeout: (check) =>
        new Promise<DescendantCheck>((resolve) => {
          timeouts.push(() => {
            resolve({ status: 'unresolved', error: 'timed out' });
          });
          void check.then(resolve);
        }),
      getSession: async (_backend, sessionID) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<SessionSummary>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return summary(sessionID, 'ancestor');
      },
    });
    const firstTimeout = () => {
      const fire = timeouts[0];
      if (fire === undefined) throw new Error('expected a timeout for the first walk');
      fire();
    };

    const firstRun = f.verifier.verifyUnknownDescendants(['child'], 'ancestor', 'srv');
    firstTimeout();
    const first = await firstRun;
    expect(first.pending).toEqual(new Set(['child']));
    expect(first.error).toContain('timed out');

    const retryRun = f.verifier.verifyUnknownDescendants(['child'], 'ancestor', 'srv');
    // A late firing of the retired deadline cannot retire the replacement walk.
    firstTimeout();
    const retry = await retryRun;
    expect(retry.verified).toEqual(new Set(['child']));
    expect(calls).toBe(2);

    // The originally stalled RPC settling later cannot overwrite newer evidence.
    releaseFirst(summary('child'));
    await Promise.resolve();
    expect(f.verifier.evidence().get('srv|child')).toEqual({
      ancestor: 'ancestor',
      childEpoch: 1,
      ancestorEpoch: 1,
    });
  });

  test('a retired multi-hop walk issues no further ancestor RPCs after recovery (#332)', async () => {
    const timeouts: Array<() => void> = [];
    const requested: string[] = [];
    let releaseFirst!: (value: SessionSummary) => void;
    let calls = 0;
    const f = fixture({
      withTimeout: (check) =>
        new Promise<DescendantCheck>((resolve) => {
          timeouts.push(() => resolve({ status: 'unresolved', error: 'timed out' }));
          void check.then(resolve);
        }),
      getSession: async (_backend, sessionID) => {
        requested.push(sessionID);
        calls += 1;
        if (calls === 1) {
          return new Promise<SessionSummary>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return summary(sessionID, f.parents.get(sessionID));
      },
    });
    f.parents.set('child', 'mid');
    f.parents.set('mid', 'ancestor');

    const first = f.verifier.verifyDescendant('child', 'ancestor', 'srv');
    expect(requested).toEqual(['child']);
    const fire = timeouts[0];
    if (fire === undefined) throw new Error('expected a timeout for the first walk');
    fire();
    await first;

    const retry = await f.verifier.verifyDescendant('child', 'ancestor', 'srv');
    expect(retry).toEqual({ status: 'verified' });
    expect(requested).toEqual(['child', 'child', 'mid']);

    // The retired walk's deferred child response must not start the old mid-hop RPC.
    releaseFirst(summary('child', 'mid'));
    await Promise.resolve();
    await Promise.resolve();
    expect(requested).toEqual(['child', 'child', 'mid']);
    expect(f.verifier.outstandingReads()).toBe(0);
    expect(f.verifier.evidence().get('srv|child')).toEqual({
      ancestor: 'ancestor',
      childEpoch: 1,
      ancestorEpoch: 1,
    });
  });

  test('repeated retries against a stalled noncancelable backend stay bounded and recover (#332)', async () => {
    const timeouts: Array<() => void> = [];
    const releases: Array<() => void> = [];
    let calls = 0;
    let stalled = true;
    const f = fixture({
      maxOutstandingReads: 1,
      withTimeout: (check) =>
        new Promise<DescendantCheck>((resolve) => {
          timeouts.push(() => resolve({ status: 'unresolved', error: 'timed out' }));
          void check.then(resolve);
        }),
      getSession: async () => {
        calls += 1;
        if (stalled) {
          return new Promise<SessionSummary>((resolve) => {
            releases.push(() => resolve(summary('child', 'ancestor')));
          });
        }
        return summary('child', 'ancestor');
      },
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const run = f.verifier.verifyDescendant('child', 'ancestor', 'srv');
      const fire = timeouts[attempt];
      if (fire === undefined) throw new Error('expected a timeout for each attempt');
      fire();
      expect((await run).status).toBe('unresolved');
      // Retiring a timed-out flight frees its logical slot even though the wire read hangs.
      expect(f.verifier.outstandingReads()).toBe(0);
    }
    expect(calls).toBe(20);

    for (const settle of releases) settle();
    stalled = false;
    await Promise.resolve();
    expect(await f.verifier.verifyDescendant('child', 'ancestor', 'srv')).toEqual({
      status: 'verified',
    });
  });

  test('session deletion mid-walk prevents a deferred response from traversing further (#332)', async () => {
    const requested: string[] = [];
    let releaseChild!: (value: SessionSummary) => void;
    let calls = 0;
    const f = fixture({
      getSession: async (_backend, sessionID) => {
        requested.push(sessionID);
        calls += 1;
        if (calls === 1) {
          return new Promise<SessionSummary>((resolve) => {
            releaseChild = resolve;
          });
        }
        return summary(sessionID, f.parents.get(sessionID));
      },
    });
    f.parents.set('child', 'mid');
    f.parents.set('mid', 'ancestor');

    const first = f.verifier.verifyDescendant('child', 'ancestor', 'srv');
    expect(requested).toEqual(['child']);
    f.verifier.forgetSession('srv|child');
    expect(f.verifier.outstandingReads()).toBe(0);

    releaseChild(summary('child', 'mid'));
    expect((await first).status).toBe('unresolved');
    expect(requested).toEqual(['child']);
    expect(f.verifier.evidence().size).toBe(0);
  });

  test('lifecycle teardown retires pending walks and ignores their late results (#332)', async () => {
    const release: Array<(value: SessionSummary) => void> = [];
    const f = fixture({
      getSession: async () =>
        new Promise<SessionSummary>((resolve) => {
          release.push(resolve);
        }),
    });
    const first = f.verifier.verifyDescendant('child', 'ancestor', 'srv');
    expect(release).toHaveLength(1);
    f.verifier.forgetSession('srv|child');
    const second = f.verifier.verifyDescendant('child', 'ancestor', 'srv');
    expect(release).toHaveLength(2);
    f.verifier.forgetServer('srv');
    const third = f.verifier.verifyDescendant('child', 'ancestor', 'srv');
    expect(release).toHaveLength(3);
    f.verifier.dispose();

    for (const settleWalk of release) settleWalk(summary('child', 'ancestor'));
    const results = await Promise.all([first, second, third]);
    expect(results.every((result) => result.status === 'unresolved')).toBe(true);
    expect(f.verifier.evidence().size).toBe(0);
  });
});
