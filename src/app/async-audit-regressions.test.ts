import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import { composerFrom } from '../domain/composer.ts';
import type { SessionSummary } from '../domain/session.ts';
import { AppController, type ServerAdmin } from './controller.ts';

const sessionID = 'ses_same';

function session(serverID: string, revert = false): SessionSummary {
  return {
    id: sessionID,
    serverID,
    projectID: 'p',
    directory: '/work',
    createdAt: 0,
    updatedAt: 1,
    archived: false,
    ...(revert
      ? {
          revert: {
            messageID: 'm_user',
            files: [
              {
                file: 'a.ts',
                patch: '',
                additions: 1,
                deletions: 0,
                status: 'modified' as const,
                truncated: false,
              },
            ],
          },
        }
      : {}),
  };
}

async function flush(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await Bun.sleep(0);
}

function backendFor(
  registered: Set<string>,
  local: FakeBackend,
  remote: FakeBackend,
): (id: string) => FakeBackend | undefined {
  return (id) => {
    if (!registered.has(id)) return undefined;
    return id === 'remote' ? remote : local;
  };
}

async function harness(
  admin?: ServerAdmin,
  prepare?: (local: FakeBackend, remote: FakeBackend) => void,
) {
  const local = new FakeBackend();
  const remote = new FakeBackend();
  local.serverID = 'local';
  remote.serverID = 'remote';
  local.sessions = [session('local', true)];
  remote.sessions = [session('remote')];
  prepare?.(local, remote);
  const registered = new Set(['local', 'remote']);
  const controller = new AppController({
    backend: local,
    backendFor: backendFor(registered, local, remote),
    serverIDs: () => [...registered],
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work',
    version: 'test',
    now: () => 1000,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
    ...(admin === undefined ? {} : { serverAdmin: admin }),
  });
  await controller.bootstrap();
  return { local, remote, controller, registered };
}

function adminWith(unpair: ServerAdmin['unpair']): ServerAdmin {
  return {
    list: () => [
      { serverID: 'local', label: 'local', baseUrl: 'http://l', state: 'online', active: true },
      {
        serverID: 'remote',
        label: 'buildbox',
        baseUrl: 'http://r',
        state: 'online',
        active: false,
      },
    ],
    rename: async () => [],
    unpair,
  };
}

describe('revert completions are bound to their own dialog (#197, #199)', () => {
  test('a late revert result cannot close another overlay or reload another host', async () => {
    const { local, remote, controller } = await harness();
    controller.openSession(sessionID, 'local');
    await flush();
    expect(controller.state.overlay.kind).toBe('revert');
    const gate = Promise.withResolvers<void>();
    const realCommit = local.commitRevert.bind(local);
    local.commitRevert = async (id: string) => {
      await gate.promise;
      await realCommit(id);
    };
    controller.revertKey({ name: 'return' });
    await flush();
    controller.openSession(sessionID, 'remote');
    controller.closeOverlay();
    controller.setComposer(composerFrom('/help'));
    await controller.submit();
    expect(controller.state.overlay.kind).toBe('help');
    const remoteCalls = remote.calls.length;
    gate.resolve();
    await flush();
    expect(controller.state.overlay.kind).toBe('help');
    // The completed revert reloads its owner (local); the remote host is never queried for it.
    const goalReads = remote.calls.slice(remoteCalls).filter((call) => call.name === 'getGoal');
    expect(goalReads).toEqual([]);
    controller.dispose();
  });

  test('a failing read restores only its own dialog', async () => {
    const { local, controller } = await harness();
    controller.openSession(sessionID, 'local');
    await flush();
    const gate = Promise.withResolvers<SessionSummary>();
    local.getSession = () => gate.promise;
    controller.revertKey({ name: 'return' });
    controller.openSession(sessionID, 'remote');
    controller.closeOverlay();
    controller.setComposer(composerFrom('/help'));
    await controller.submit();
    gate.reject(new Error('boom'));
    await flush();
    expect(controller.state.overlay.kind).toBe('help');
    controller.dispose();
  });
});

describe('unpair with credential cleanup pending (#195)', () => {
  test('evicts the removed host UI state and warns that deletion is queued', async () => {
    const calls: string[] = [];
    const { controller } = await harness(
      adminWith(async (id) => {
        calls.push(id);
        return { credentialCleanup: 'pending', error: 'keyring locked' };
      }),
    );
    const key = 'server:remote/session:ses_same';
    expect(controller.state.sessions[key]).toBeDefined();
    controller.setComposer(composerFrom('/unpair buildbox'));
    await controller.submit();
    expect(calls).toEqual(['remote']);
    expect(controller.state.sessions[key]).toBeUndefined();
    expect(controller.state.notice?.text).toContain('retried');
    controller.dispose();
  });

  test('a failure before removal keeps the host state', async () => {
    const { controller } = await harness(
      adminWith(async () => {
        throw new Error('disk full');
      }),
    );
    controller.setComposer(composerFrom('/unpair buildbox'));
    await controller.submit();
    expect(controller.state.sessions['server:remote/session:ses_same']).toBeDefined();
    expect(controller.state.notice?.tone).toBe('error');
    controller.dispose();
  });
});

async function pagedHarness() {
  const fixture = await harness(undefined, (_local, remote) => {
    remote.listSessionsHook = async () => ({
      sessions: [session('remote')],
      nextCursor: 'more',
    });
  });
  expect(fixture.controller.state.serverPages['remote']?.complete).toBe(false);
  return fixture;
}

describe('pagination follow-ups (#196)', () => {
  test('a host removed during pagination is never contacted afterwards', async () => {
    const { remote, controller, registered } = await pagedHarness();
    const gate = Promise.withResolvers<{ sessions: SessionSummary[] }>();
    remote.listSessionsHook = () => gate.promise;
    remote.active = new Set([sessionID]);
    const pending = controller.loadMoreSessions();
    await flush();
    registered.delete('remote');
    const before = remote.calls.filter((call) => call.name === 'listPermissions').length;
    gate.resolve({ sessions: [] });
    await pending;
    expect(remote.calls.filter((call) => call.name === 'listPermissions').length).toBe(before);
    expect(controller.state.sessionsLoading).toBe(false);
    controller.dispose();
  });

  test('a permission refresh failure does not reject pagination', async () => {
    const { remote, controller } = await pagedHarness();
    remote.active = new Set([sessionID]);
    remote.listSessionsHook = async () => ({ sessions: [session('remote')] });
    remote.listPermissions = async () => {
      throw new Error('permissions down');
    };
    await controller.loadMoreSessions();
    expect(controller.state.sessionsLoading).toBe(false);
    expect(controller.state.serverPages['remote']?.complete).toBe(true);
    controller.dispose();
  });
});

describe('actions on a remote session never use the launch backend (#178)', () => {
  test('interrupt and rename go to the owning host only', async () => {
    const { local, remote, controller } = await harness();
    controller.openSession(sessionID, 'remote');
    await flush();
    const localBefore = local.calls.length;
    await controller.interrupt();
    controller.setComposer(composerFrom('/rename new title'));
    await controller.submit();
    await flush();
    const names = (calls: typeof remote.calls) => calls.map((call) => call.name);
    expect(names(remote.calls)).toContain('interrupt');
    expect(names(remote.calls)).toContain('renameSession');
    expect(names(local.calls.slice(localBefore))).not.toContain('interrupt');
    expect(names(local.calls.slice(localBefore))).not.toContain('renameSession');
    controller.dispose();
  });
});
