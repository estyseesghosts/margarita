import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { type Backend, BackendError } from '../adapter/backend.ts';
import { sessionKey } from '../domain/server-identity.ts';
import type { SessionSummary } from '../domain/session.ts';
import { type SessionFetchDeps, SessionFetcher } from './session-fetch.ts';

function summary(id: string, serverID = 'local'): SessionSummary {
  return {
    id,
    serverID,
    projectID: 'p',
    directory: '/work',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
  };
}

function deps(backend: Backend, overrides: Partial<SessionFetchDeps> = {}): SessionFetchDeps {
  return {
    backendFor: () => backend,
    keyFor: (serverID, sessionID) => sessionKey({ serverID, sessionID }),
    pageLimit: 5,
    concurrency: 2,
    ...overrides,
  };
}

describe('session fetcher (#308)', () => {
  test('pages one host, stamps ownership and keeps the next cursor', async () => {
    const backend = new FakeBackend();
    backend.listSessionsHook = async (query) => ({
      sessions: [summary(query.cursor === undefined ? 'a' : 'b')],
      ...(query.cursor === undefined ? { nextCursor: 'page-2' } : {}),
    });
    const fetcher = new SessionFetcher(deps(backend, { pageLimit: 1 }));
    const page = await fetcher.loadServer('local', 7);
    expect(page.epoch).toBe(7);
    expect(page.cursor).toBe('page-2');
    expect(Object.keys(page.fresh)).toEqual([sessionKey({ serverID: 'local', sessionID: 'a' })]);
    expect(page.fresh[sessionKey({ serverID: 'local', sessionID: 'a' })]?.serverID).toBe('local');
  });

  test('a failed activity read keeps the successful page, cursor and rows (#341)', async () => {
    const backend = new FakeBackend();
    backend.sessions = [summary('a'), summary('b')];
    backend.activeSessionIDs = async () => {
      throw new BackendError('transport', 'session.active', 'activity offline');
    };
    const fetcher = new SessionFetcher(deps(backend));
    const page = await fetcher.loadServer('local', 7);
    // Identity and paging survive; activity is reported as a distinct, unknown outcome.
    expect(Object.keys(page.fresh)).toEqual([
      sessionKey({ serverID: 'local', sessionID: 'a' }),
      sessionKey({ serverID: 'local', sessionID: 'b' }),
    ]);
    expect(page.active).toBeUndefined();
    expect(page.activeError).toContain('activity offline');
    expect(page.epoch).toBe(7);
  });

  test('a successful activity read exposes the active set as evidence (#341)', async () => {
    const backend = new FakeBackend();
    backend.sessions = [summary('a')];
    backend.active = new Set(['a']);
    const fetcher = new SessionFetcher(deps(backend));
    const page = await fetcher.loadServer('local', 3);
    expect([...(page.active ?? [])]).toEqual(['a']);
    expect(page.activeError).toBeUndefined();
  });

  test('honours the page limit and fails closed for an unknown host', async () => {
    const backend = new FakeBackend();
    let listed = 0;
    backend.listSessionsHook = async () => {
      listed += 1;
      return { sessions: [], nextCursor: 'more' };
    };
    const fetcher = new SessionFetcher(deps(backend, { pageLimit: 2 }));
    const page = await fetcher.loadServer('remote', 1);
    expect(page.cursor).toBe('more');
    expect(listed).toBe(2);

    const closed = new SessionFetcher(
      deps(backend, {
        backendFor: () => {
          throw new BackendError('invalid', 'session.list', 'server no longer registered');
        },
      }),
    );
    let message: string | undefined;
    try {
      await closed.loadServer('gone', 1);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('session.list: server no longer registered');
  });

  test('reconciles only definite not-found results, stamped with the owning host', async () => {
    const backend = new FakeBackend();
    backend.sessions = [summary('kept', 'remote')];
    const fetcher = new SessionFetcher(deps(backend));
    const result = await fetcher.reconcile([
      { serverID: 'remote', sessionID: 'kept' },
      { serverID: 'remote', sessionID: 'missing' },
    ]);
    expect(Object.keys(result.found)).toEqual([
      sessionKey({ serverID: 'remote', sessionID: 'kept' }),
    ]);
    expect(result.found[sessionKey({ serverID: 'remote', sessionID: 'kept' })]?.serverID).toBe(
      'remote',
    );
    expect(result.deleted).toEqual([{ serverID: 'remote', sessionID: 'missing' }]);
  });

  test('a transport failure keeps the cached row', async () => {
    const backend = new FakeBackend();
    backend.getSession = async () => {
      throw new BackendError('transport', 'session.get', 'offline');
    };
    const fetcher = new SessionFetcher(deps(backend));
    const result = await fetcher.reconcile([{ serverID: 'local', sessionID: 'ses_a' }]);
    expect(result.deleted).toEqual([]);
    expect(Object.keys(result.found)).toEqual([]);
  });
});
