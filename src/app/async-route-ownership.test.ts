import { expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { defaultConfig } from '../config/config.ts';
import type { GoalStore } from '../config/goal-store.ts';
import { emptyState } from '../config/local-state.ts';
import { composerFrom } from '../domain/composer.ts';
import type { FileDiff } from '../domain/diff.ts';
import { emptyGoalPlan } from '../domain/goal-plan.ts';
import type { SessionSummary } from '../domain/session.ts';
import { AppController } from './controller.ts';

const sessionID = 'ses_same';

function session(serverID: string): SessionSummary {
  return {
    id: sessionID,
    serverID,
    projectID: 'p',
    directory: '/work',
    createdAt: 0,
    updatedAt: 1,
    archived: false,
  };
}

function diff(file: string): FileDiff[] {
  return [{ file, patch: '', additions: 1, deletions: 0, status: 'added', truncated: false }];
}

async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await Bun.sleep(0);
}

async function harness(goalStore?: GoalStore) {
  const local = new FakeBackend();
  const remote = new FakeBackend();
  local.serverID = 'local';
  remote.serverID = 'remote';
  local.sessions = [session('local')];
  remote.sessions = [session('remote')];
  const controller = new AppController({
    backend: local,
    backendFor: (id) => (id === 'local' ? local : id === 'remote' ? remote : undefined),
    serverIDs: () => ['local', 'remote'],
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work',
    version: 'test',
    now: () => 1000,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
    ...(goalStore === undefined ? {} : { goalStore }),
  });
  await controller.bootstrap();
  controller.openSession(sessionID, 'local');
  await flush();
  return { local, remote, controller };
}

test('diff results and errors cannot replace another host or a newer request', async () => {
  const { local, remote, controller } = await harness();
  const older = Promise.withResolvers<FileDiff[]>();
  local.sessionDiff = () => older.promise;
  remote.sessionDiff = async () => diff('remote.txt');
  const first = controller.openDiff('session');
  controller.openSession(sessionID, 'remote');
  await controller.openDiff('session');
  older.resolve(diff('local.txt'));
  await first;
  expect(controller.state.overlay.kind).toBe('diff');
  if (controller.state.overlay.kind === 'diff') {
    expect(controller.state.overlay.serverID).toBe('remote');
    expect(controller.state.overlay.files[0]?.file).toBe('remote.txt');
  }

  const stale = Promise.withResolvers<FileDiff[]>();
  remote.sessionDiff = () => stale.promise;
  const pending = controller.openDiff('session');
  remote.sessionDiff = async () => diff('new.txt');
  await controller.openDiff('session');
  stale.reject(new Error('late error'));
  await pending;
  if (controller.state.overlay.kind !== 'diff') throw new Error('diff closed unexpectedly');
  expect(controller.state.overlay.files[0]?.file).toBe('new.txt');
  expect(controller.state.overlay.error).toBeUndefined();
  controller.dispose();
});

test('closing a pending diff keeps it closed', async () => {
  const { local, controller } = await harness();
  const reply = Promise.withResolvers<FileDiff[]>();
  local.sessionDiff = () => reply.promise;
  const pending = controller.openDiff('session');
  controller.closeOverlay();
  reply.resolve(diff('late.txt'));
  await pending;
  expect(controller.state.overlay.kind).toBe('none');
  controller.dispose();
});

test('turn diff uses the initiating host transcript boundary', async () => {
  const { local, controller } = await harness();
  local.messages = {
    [sessionID]: [{ kind: 'user', id: 'local_turn', createdAt: 2, text: 'work', attachments: [] }],
  };
  controller.openSession(sessionID, 'local');
  await flush();
  await controller.openDiff('turn');
  expect(local.calls.findLast((call) => call.name === 'sessionDiff')?.args[1]).toEqual({
    from: 'local_turn',
  });
  controller.dispose();
});

test('compaction refreshes the originating host after navigation', async () => {
  const { local, remote, controller } = await harness();
  const reply = Promise.withResolvers<void>();
  local.compactSession = () => reply.promise;
  controller.setComposer(composerFrom('/compact'));
  const pending = controller.submit();
  await flush();
  controller.openSession(sessionID, 'remote');
  await flush();
  const localBefore = local.calls.filter((call) => call.name === 'listInbox').length;
  const remoteBefore = remote.calls.filter((call) => call.name === 'listInbox').length;
  reply.resolve();
  await pending;
  expect(local.calls.filter((call) => call.name === 'listInbox')).toHaveLength(localBefore + 1);
  expect(remote.calls.filter((call) => call.name === 'listInbox')).toHaveLength(remoteBefore);
  expect(controller.state.notice?.text).toContain('local');
  controller.dispose();
});

test('a second compaction request is rejected while the first is unacknowledged', async () => {
  const { local, controller } = await harness();
  const reply = Promise.withResolvers<void>();
  let calls = 0;
  local.compactSession = () => {
    calls += 1;
    return reply.promise;
  };
  controller.setComposer(composerFrom('/compact'));
  const first = controller.submit();
  await flush();
  controller.setComposer(composerFrom('/compact'));
  await controller.submit();
  expect(calls).toBe(1);
  expect(controller.state.notice?.text).toBe('Compaction already pending');
  reply.resolve();
  await first;
  controller.dispose();
});

test('a late fork remains on its origin host without replacing a newer route or overlay', async () => {
  const { local, controller } = await harness();
  const reply = Promise.withResolvers<SessionSummary>();
  local.forkSession = () => reply.promise;
  controller.setComposer(composerFrom('/fork'));
  const pending = controller.submit();
  await flush();
  controller.openSession(sessionID, 'remote');
  controller.setComposer(composerFrom('remote draft'));
  controller.setOverlay({ kind: 'help' });
  reply.resolve({ ...session('local'), id: 'forked' });
  await pending;
  expect(controller.state.route).toEqual({ kind: 'conversation', serverID: 'remote', sessionID });
  expect(controller.state.composer.text).toBe('remote draft');
  expect(controller.state.overlay.kind).toBe('help');
  expect(controller.state.sessions['forked']?.serverID).toBe('local');
  controller.dispose();
});

test('a fork still opens when its originating route remains unchanged', async () => {
  const { controller } = await harness();
  controller.setComposer(composerFrom('/fork'));
  await controller.submit();
  expect(controller.state.route).toEqual({
    kind: 'conversation',
    serverID: 'local',
    sessionID: `${sessionID}_fork`,
  });
  controller.dispose();
});

test('a fork reports failed goal persistence and respects a modal opened while saving', async () => {
  const save = Promise.withResolvers<ReturnType<typeof emptyGoalPlan>>();
  const goalStore: GoalStore = {
    load: async (ref) =>
      ref.sessionID === sessionID ? emptyGoalPlan('local', sessionID, 'p') : undefined,
    save: () => save.promise,
  };
  const { controller } = await harness(goalStore);
  controller.setComposer(composerFrom('/fork'));
  const pending = controller.submit();
  await flush();
  controller.setOverlay({ kind: 'help' });
  save.reject(new Error('disk full'));
  await pending;
  expect(controller.state.route).toEqual({ kind: 'conversation', serverID: 'local', sessionID });
  expect(controller.state.overlay.kind).toBe('help');
  expect(controller.state.sessions[`${sessionID}_fork`]?.serverID).toBe('local');
  expect(controller.state.goals[`${sessionID}_fork`]).toBeUndefined();
  expect(controller.state.notice?.text).toContain('goal could not be saved');
  controller.dispose();
});
