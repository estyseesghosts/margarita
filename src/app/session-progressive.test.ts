import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import type { SessionPage } from '../adapter/backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import type { SessionSummary } from '../domain/session.ts';
import { AppController } from './controller.ts';

function summary(id: string, serverID = 'local'): SessionSummary {
  return {
    id,
    serverID,
    projectID: 'p',
    directory: '/work/progressive',
    title: id,
    createdAt: 0,
    updatedAt: 1,
    archived: false,
  };
}

function pageHook(
  pages: readonly (readonly SessionSummary[])[],
): (query: { cursor?: string }) => Promise<SessionPage> {
  return async (query) => {
    const index = query.cursor === undefined ? 0 : Number(query.cursor);
    return {
      sessions: [...(pages[index] ?? [])],
      ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}),
    };
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function controllerFor(
  backend: FakeBackend,
  overrides: Partial<ConstructorParameters<typeof AppController>[0]> = {},
): AppController {
  return new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/progressive',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
    ...overrides,
  });
}

describe('progressive session index (#347)', () => {
  test('page 1 is published while page 2 and activity are still gated', async () => {
    const backend = new FakeBackend();
    const page2 = deferred<void>();
    const activity = deferred<Set<string>>();
    const base = pageHook([[summary('s0')], [summary('s1')]]);
    backend.listSessionsHook = async (query) => {
      if (query.cursor === '1') await page2.promise;
      return base(query);
    };
    backend.activeSessionIDs = async () => activity.promise;
    const controller = controllerFor(backend);
    await controller.bootstrap();
    expect(Object.keys(controller.state.sessions)).toEqual(['s0']);
    expect(controller.state.sessionsComplete).toBe(false);
    expect(controller.state.sessionsLoading).toBe(false);
    // A slow activity endpoint did not withhold the rows it describes.
    page2.resolve();
    await controller.settleSessionIndex();
    expect(Object.keys(controller.state.sessions).toSorted()).toEqual(['s0', 's1']);
    expect(controller.state.sessionsComplete).toBe(true);
    expect(controller.state.startup.indexCompleteAt).toBeDefined();
    activity.resolve(new Set());
    await Promise.resolve();
    controller.dispose();
  });

  test('a completed index reconciles cached rows the full page walk omitted', async () => {
    const backend = new FakeBackend();
    backend.sessions = [summary('gone')];
    const controller = controllerFor(backend);
    await controller.bootstrap();
    expect(controller.state.sessions['gone']).toBeDefined();

    backend.sessions = [];
    backend.listSessionsHook = pageHook([[summary('a')], [summary('b')]]);
    await controller.loadSessions();
    // Page 1 has a continuation cursor: it is not proof that an older cached row vanished.
    expect(controller.state.sessions['gone']).toBeDefined();
    await controller.settleSessionIndex();
    expect(controller.state.sessions['gone']).toBeUndefined();
    expect(Object.keys(controller.state.sessions).toSorted()).toEqual(['a', 'b']);
    expect(controller.state.sessionsComplete).toBe(true);
    controller.dispose();
  });

  test('duplicate rows across page boundaries are merged once', async () => {
    const backend = new FakeBackend();
    backend.listSessionsHook = pageHook([
      [summary('s0'), summary('s1')],
      [summary('s1'), summary('s2')],
    ]);
    const controller = controllerFor(backend);
    await controller.bootstrap();
    await controller.settleSessionIndex();
    expect(Object.keys(controller.state.sessions).toSorted()).toEqual(['s0', 's1', 's2']);
    controller.dispose();
  });

  test('a newer refresh drops a late page from the superseded walk', async () => {
    const backend = new FakeBackend();
    const secondPage = deferred<SessionPage>();
    backend.listSessionsHook = async (query) => {
      if (query.cursor === '1') return secondPage.promise;
      return {
        sessions: [summary('old')],
        nextCursor: '1',
      };
    };
    const controller = controllerFor(backend);
    await controller.bootstrap();
    expect(controller.state.sessions['old']).toBeDefined();

    backend.listSessionsHook = async () => ({ sessions: [summary('new')] });
    await controller.loadSessions();
    secondPage.resolve({ sessions: [summary('stale')] });
    await controller.settleSessionIndex();
    expect(controller.state.sessions['stale']).toBeUndefined();
    expect(Object.keys(controller.state.sessions).toSorted()).toEqual(['new']);
    expect(controller.state.sessionsComplete).toBe(true);
    controller.dispose();
  });

  test('unpairing a host during pagination cannot resurrect its rows', async () => {
    const remote = new FakeBackend();
    remote.serverID = 'srv_r';
    const second = deferred<void>();
    remote.listSessionsHook = async (query) => {
      if (query.cursor === '1') await second.promise;
      return {
        sessions: query.cursor === '1' ? [summary('r2', 'srv_r')] : [summary('r1', 'srv_r')],
        ...(query.cursor === undefined ? { nextCursor: '1' } : {}),
      };
    };
    remote.activeSessionIDs = async () => new Set();
    let ids = ['local', 'srv_r'];
    const local = new FakeBackend();
    local.sessions = [summary('l1')];
    const controller = controllerFor(local, {
      serverIDs: () => ids,
      backendFor: (serverID) => (serverID === 'srv_r' ? remote : local),
    });
    await controller.bootstrap();
    expect(controller.state.sessions['server:srv_r/session:r1']).toBeDefined();
    ids = ['local'];
    second.resolve();
    await controller.settleSessionIndex();
    expect(controller.state.sessions['server:srv_r/session:r2']).toBeUndefined();
    // Cached rows already confirmed stay until the registry-level unpair cleanup runs; the
    // late page must not add new rows for a host that is no longer registered.
    expect(controller.state.sessions['server:srv_r/session:r1']).toBeDefined();
    controller.dispose();
  });

  test('a failed later page keeps earlier rows and leaves the cursor retryable', async () => {
    const backend = new FakeBackend();
    const base = pageHook([[summary('s0')], [summary('s1')], [summary('s2')]]);
    backend.listSessionsHook = async (query) => {
      if (query.cursor === '2') throw new Error('cursor read failed');
      return base(query);
    };
    const controller = controllerFor(backend);
    await controller.bootstrap();
    await controller.settleSessionIndex();
    expect(Object.keys(controller.state.sessions).toSorted()).toEqual(['s0', 's1']);
    expect(controller.state.sessionsComplete).toBe(false);
    expect(controller.state.serverPages['local']?.cursor).toBe('2');
    expect(controller.state.sessionsError).toContain('cursor read failed');

    // The same cursor is retryable and never duplicates the rows already committed.
    backend.listSessionsHook = base;
    await controller.loadMoreSessions();
    expect(Object.keys(controller.state.sessions).toSorted()).toEqual(['s0', 's1', 's2']);
    expect(controller.state.sessionsComplete).toBe(true);
    controller.dispose();
  });

  test('a cursor that never advances is not treated as completion', async () => {
    const backend = new FakeBackend();
    backend.listSessionsHook = async () => ({ sessions: [summary('s0')], nextCursor: 'same' });
    const controller = controllerFor(backend);
    await controller.bootstrap();
    await controller.settleSessionIndex();
    expect(controller.state.sessionsComplete).toBe(false);
    expect(controller.state.serverPages['local']?.error).toContain('did not advance');
    controller.dispose();
  });
});
