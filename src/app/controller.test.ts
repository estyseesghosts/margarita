import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBackend } from '../../test/fake-backend.ts';
import { BackendError, type BackendErrorKind, type PromptDraft } from '../adapter/backend.ts';
import { defaultConfig } from '../config/config.ts';
import type { AppConfig } from '../config/config.ts';
import { GoalConflictError, type GoalStore } from '../config/goal-store.ts';
import { emptyState, type LocalState } from '../config/local-state.ts';
import { composerFrom } from '../domain/composer.ts';
import { emptyGoalPlan, type GoalPlanV1 } from '../domain/goal-plan.ts';
import { buildKeymap } from '../domain/keymap.ts';
import type { GoalQueryFailure, NativeGoal } from '../domain/native-goal.ts';
import { directoryKey } from '../domain/path-identity.ts';
import { sessionKey } from '../domain/server-identity.ts';
import type { SessionSummary } from '../domain/session.ts';
import type { ToolCall, TranscriptMessage } from '../domain/transcript.ts';
import type { WorkerJob } from '../domain/worker.ts';
import { AppController } from './controller.ts';
import type { ControllerDeps, ProjectFileListing } from './controller.ts';
import { routeKey } from './key-router.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeController(
  listFiles: (root: string) => Promise<string[] | ProjectFileListing>,
  backend: FakeBackend = new FakeBackend(),
  now: () => number = () => 10_000,
  overrides: Partial<ControllerDeps> = {},
) {
  return new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now,
    saveLocalState: async () => {},
    listFiles,
    requestExit: () => {},
    ...overrides,
  });
}

async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await Bun.sleep(0);
}

/** A plain (non-modifier) key for the inspector's search-field tests. */
function inspectorKeyEvent(name: string, text?: string) {
  return {
    name,
    ctrl: false,
    alt: false,
    shift: false,
    ...(text === undefined ? {} : { text }),
  };
}

test('MCP catalogs retain confirmed project names through failures and late loads', async () => {
  const backend = new FakeBackend();
  const controller = makeController(async () => [], backend);
  backend.mcpServers = ['lotus'];
  await controller.loadCatalog('/one', 'local');
  backend.mcpServers = ['sentry'];
  await controller.loadCatalog('/two', 'local');
  expect(controller.mcpServersFor('local', '/one')).toEqual(['lotus']);
  expect(controller.mcpServersFor('local', '/two')).toEqual(['sentry']);
  const pending = deferred<string[]>();
  backend.listMcpServers = () => pending.promise;
  const late = controller.loadCatalog('/one', 'local');
  backend.listMcpServers = async () => {
    throw new Error('offline');
  };
  await controller.loadCatalog('/two', 'local');
  pending.resolve(['incorrect']);
  await late;
  expect(controller.mcpServersFor('local', '/one')).toEqual(['lotus']);
  expect(controller.mcpServersFor('local', '/two')).toEqual(['sentry']);
  controller.dispose();
});

test('/btw reports the capability gap without sending anything (#100)', async () => {
  const backend = new FakeBackend();
  const controller = makeController(async () => [], backend);
  await submitCommand(controller, '/btw why is the sky blue?');
  expect(controller.state.notice?.text).toContain('desktop-only');
  expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
  expect(backend.calls.some((call) => call.name === 'command')).toBe(false);
  controller.dispose();
});

test('greeting is chosen once per route and stays stable (#128)', () => {
  const controller = makeController(async () => []);
  const first = controller.greetingFor('new:local:/work');
  expect(first).not.toBe('');
  expect(controller.greetingFor('new:local:/work')).toBe(first);
  expect(controller.greetingFor('conversation:local:ses_a')).toBeTypeOf('string');
  controller.dispose();
});

describe('bounded draft undo/redo (#96)', () => {
  test('undo and redo restore text and cursor, and a new edit invalidates redo', () => {
    const controller = makeController(async () => []);
    controller.setComposer(composerFrom('hello'));
    controller.setComposer({ text: 'hello world', cursor: 11 });
    controller.undo();
    expect(controller.state.composer).toEqual(composerFrom('hello'));
    controller.redo();
    expect(controller.state.composer).toEqual({ text: 'hello world', cursor: 11 });
    controller.undo();
    controller.setComposer(composerFrom('new branch'));
    controller.redo();
    expect(controller.state.composer.text).toBe('new branch');
    controller.dispose();
  });

  test('consecutive typing coalesces into one undo step', () => {
    let time = 0;
    const controller = makeController(
      async () => [],
      new FakeBackend(),
      () => time,
    );
    controller.setComposer(composerFrom('h'));
    time = 100;
    controller.setComposer(composerFrom('he'));
    time = 200;
    controller.setComposer(composerFrom('hel'));
    controller.undo();
    expect(controller.state.composer.text).toBe('');
    controller.redo();
    expect(controller.state.composer.text).toBe('hel');
    time = 1000;
    controller.setComposer(composerFrom('x'));
    controller.undo();
    expect(controller.state.composer.text).toBe('hel');
    controller.dispose();
  });

  test('undo/redo never touches attachments and histories are route-scoped', async () => {
    const controller = makeController(async () => [], attachedBackend());
    await attach(controller, 'ses_a');
    controller.setComposer(composerFrom('first draft'));
    controller.attachImage(pngBytes, 'image/png', 'shot.png');
    controller.setComposer(composerFrom('first draft edited'));
    controller.openOverview();
    controller.setComposer(composerFrom('other draft'));
    controller.undo();
    expect(controller.state.composer.text).toBe('');
    expect(controller.state.attachments).toHaveLength(0);
    controller.openSession('ses_a');
    controller.undo();
    expect(controller.state.composer.text).toBe('first draft');
    expect(controller.state.attachments.map((item) => item.name)).toEqual(['shot.png']);
    controller.dispose();
  });
});

describe('@file completion', () => {
  test('shows only the latest query when requests resolve out of order', async () => {
    const scan = deferred<string[]>();
    const controller = makeController(() => scan.promise);

    controller.setComposer(composerFrom('@src/a'));
    controller.setComposer(composerFrom('@docs'));
    scan.resolve(['src/a.ts', 'docs/b.md']);
    await flush();

    expect(controller.state.completion).toEqual({
      kind: 'file',
      items: [{ label: '@docs/b.md', detail: '', insert: '@docs/b.md ' }],
      index: 0,
      start: 0,
    });
    controller.dispose();
  });

  test('launches at most one traversal per directory while typing', async () => {
    const scan = deferred<string[]>();
    let traversals = 0;
    const controller = makeController(() => {
      traversals += 1;
      return scan.promise;
    });

    controller.setComposer(composerFrom('@a'));
    controller.setComposer(composerFrom('@ab'));
    controller.setComposer(composerFrom('@abc'));
    scan.resolve(['abc-one.ts', 'abc-two.ts']);
    await flush();

    expect(traversals).toBe(1);
    expect(controller.state.completion?.items.map((item) => item.label)).toEqual([
      '@abc-one.ts',
      '@abc-two.ts',
    ]);
    controller.dispose();
  });

  test('ordinary prose never triggers a file lookup, even with an older mention (#291)', async () => {
    let traversals = 0;
    const controller = makeController(async () => {
      traversals += 1;
      return [] as string[];
    });
    const prose = 'word '.repeat(5000);
    controller.setComposer(composerFrom(`@old\n${prose}`));
    await flush();
    expect(traversals).toBe(0);
    expect(controller.state.completion).toBeUndefined();
    controller.dispose();
  });

  test('a project switch mid-scan cannot inject completions from the old project', async () => {
    const scan = deferred<string[]>();
    const controller = makeController(() => scan.promise);

    controller.setComposer(composerFrom('@a'));
    controller.startNewSession('/elsewhere');
    scan.resolve(['old-project-file.ts']);
    await flush();

    expect(controller.state.completion).toBeUndefined();
    controller.dispose();
  });

  test('an incomplete scan keeps partial matches but retries after a bounded backoff (#300)', async () => {
    let now = 10_000;
    let scans = 0;
    const controller = makeController(
      async () => {
        scans += 1;
        return scans === 1
          ? { files: ['src/a.ts'], complete: false, detail: 'scan stopped: time limit' }
          : { files: ['src/a.ts', 'src/ab.ts'], complete: true };
      },
      new FakeBackend(),
      () => now,
    );

    controller.setComposer(composerFrom('@src/a'));
    await flush();
    expect(scans).toBe(1);
    expect(controller.state.completion?.items.map((item) => item.label)).toEqual(['@src/a.ts']);

    // Inside the backoff window the partial snapshot is still usable without another traversal.
    controller.setComposer(composerFrom('@src/ab'));
    await flush();
    expect(scans).toBe(1);

    now += 4_000;
    controller.setComposer(composerFrom('@src/a'));
    await flush();
    expect(scans).toBe(2);
    expect(controller.state.completion?.items.map((item) => item.label)).toEqual([
      '@src/a.ts',
      '@src/ab.ts',
    ]);

    // A complete snapshot is authoritative and is reused indefinitely.
    controller.setComposer(composerFrom('@src/ab'));
    await flush();
    expect(scans).toBe(2);
    controller.dispose();
  });

  test('persistent incomplete scans do not rescan for every typed character (#300)', async () => {
    let scans = 0;
    const controller = makeController(async () => {
      scans += 1;
      return { files: ['a.ts'], complete: false, detail: '1 unreadable directory' };
    });

    for (let index = 0; index < 30; index += 1) {
      controller.setComposer(composerFrom(`@a${'b'.repeat(index)}`));
    }
    await flush();

    expect(scans).toBe(1);
    expect(controller.state.completion).toBeUndefined();
    controller.dispose();
  });
});

/** Two hosts whose sessions share a directory string, with distinct file indexes. */
function completionController(listFiles: (root: string) => Promise<string[]>) {
  const backendA = new FakeBackend();
  backendA.sessions = [{ ...fakeSession('ses_a'), directory: '/work/app' }];
  const backendB = new FakeBackend();
  backendB.serverID = 'srv_1';
  backendB.sessions = [{ ...fakeSession('ses_b'), directory: '/work/app' }];
  backendB.findProjectFiles = async () => ['b1.ts', 'b2.ts'];
  const controller = new AppController({
    backend: backendA,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles,
    requestExit: () => {},
    serverIDs: () => ['srv_1'],
    backendFor: (serverID: string) => (serverID === 'srv_1' ? backendB : backendA),
    serverInfo: () => ({ online: true }),
  });
  return { controller, backendA, backendB };
}

describe('completion results are scoped to the viewed host (#112)', () => {
  test('a late completion from another host with the same directory is rejected', async () => {
    const scan = deferred<string[]>();
    const { controller } = completionController(() => scan.promise);
    try {
      await controller.bootstrap();
      // Seed host B's draft with '@x' so switching back to it keeps the same mention
      // without starting a fresh completion request.
      controller.openSession('ses_b', 'srv_1');
      controller.setComposer(composerFrom('@x'));
      controller.openSession('ses_a', 'local');
      // Host A's slow scan is in flight with the same '@x' mention and directory string.
      controller.setComposer(composerFrom('@x'));
      // Switch to host B while A's scan is still pending.
      controller.openSession('ses_b', 'srv_1');
      scan.resolve(['x1.ts', 'x2.ts']); // host A's late result (would match '@x' locally)
      await flush();
      // A's late results must never populate B's completion.
      expect(controller.state.completion).toBeUndefined();
    } finally {
      controller.dispose();
    }
  });

  test("the current host's own completion results remain after another host's late result", async () => {
    const scanA = deferred<string[]>();
    const { controller } = completionController(() => scanA.promise);
    try {
      await controller.bootstrap();
      controller.openSession('ses_a', 'local');
      controller.setComposer(composerFrom('@x')); // host A's slow scan is in flight
      // Switch to host B and re-trigger completion on B.
      controller.openSession('ses_b', 'srv_1');
      controller.setComposer(composerFrom('@x'));
      await flush(); // let B's own completion resolve
      scanA.resolve(['x1.ts', 'x2.ts']); // host A's late result (would match '@x' locally)
      await flush();
      expect(controller.state.completion?.items.map((item) => item.label)).toEqual([
        '@b1.ts',
        '@b2.ts',
      ]);
    } finally {
      controller.dispose();
    }
  });

  test('switching sessions on the same host during a pending completion cannot restore the old overlay', async () => {
    const scan = deferred<string[]>();
    const backend = new FakeBackend();
    backend.sessions = [
      { ...fakeSession('ses_a'), directory: '/work/app' },
      { ...fakeSession('ses_b'), directory: '/work/app' },
    ];
    const controller = makeController(() => scan.promise, backend);
    try {
      await controller.bootstrap();
      controller.openSession('ses_a');
      controller.setComposer(composerFrom('@x')); // slow scan in flight
      controller.openSession('ses_b'); // switch to another session on the same host
      scan.resolve(['x1.ts']);
      await flush();
      expect(controller.state.completion).toBeUndefined();
      expect(controller.state.route).toEqual({
        kind: 'conversation',
        serverID: 'local',
        sessionID: 'ses_b',
      });
    } finally {
      controller.dispose();
    }
  });
});

describe('startup shell before indexing (#287)', () => {
  test('marks loading, becomes ready after the launch host, and does not wait for a remote', async () => {
    const remoteGate = deferred<void>();
    const local = new FakeBackend();
    local.sessions = [fakeSession('ses_local')];
    const remote = new FakeBackend();
    remote.serverID = 'srv_remote';
    remote.sessions = [{ ...fakeSession('ses_r'), serverID: 'srv_remote' }];
    remote.listSessionsHook = async () => {
      await remoteGate.promise;
      return { sessions: remote.sessions };
    };
    const controller = makeController(
      async () => [],
      local,
      () => 10_000,
      {
        serverIDs: () => ['local', 'srv_remote'],
        backendFor: (serverID) => (serverID === 'srv_remote' ? remote : local),
      },
    );

    const booting = controller.bootstrap();
    // `bootstrap` sets the phase synchronously, before its first await, so the first frame
    // can show a genuine loading state rather than a false empty overview.
    expect(controller.state.startup.phase).toBe('loading');
    await flush();
    expect(controller.state.startup.phase).toBe('ready');
    expect(controller.state.startup.readyAt).toBeDefined();
    expect(controller.state.sessions['ses_local']).toBeDefined();
    const remoteKey = sessionKey({ serverID: 'srv_remote', sessionID: 'ses_r' });
    expect(controller.state.sessions[remoteKey]).toBeUndefined();

    remoteGate.resolve();
    await booting;
    expect(controller.state.sessions[remoteKey]).toBeDefined();
    expect(controller.state.startup.phase).toBe('ready');
    controller.dispose();
  });

  test('an offline remote stays non-fatal while the launch host is usable', async () => {
    const local = new FakeBackend();
    local.sessions = [fakeSession('ses_local')];
    const remote = new FakeBackend();
    remote.serverID = 'srv_remote';
    remote.listSessionsHook = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const controller = makeController(
      async () => [],
      local,
      () => 10_000,
      {
        serverIDs: () => ['local', 'srv_remote'],
        backendFor: (serverID) => (serverID === 'srv_remote' ? remote : local),
      },
    );

    await controller.bootstrap();
    expect(controller.state.startup.phase).toBe('ready');
    expect(controller.state.sessions['ses_local']).toBeDefined();
    expect(controller.state.serverPages['srv_remote']?.error).toContain('ECONNREFUSED');
    expect(controller.state.serverPages['srv_remote']?.complete).toBe(false);
    expect(controller.state.sessionsComplete).toBe(false);
    controller.dispose();
  });

  test('a launch-host failure marks the phase failed and still propagates to the CLI', async () => {
    const backend = new FakeBackend();
    backend.listSessionsHook = () => Promise.reject(new Error('launch unreachable'));
    const controller = makeController(async () => [], backend);

    const outcome = await controller.bootstrap().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome instanceof Error ? outcome.message : '').toContain('launch unreachable');
    expect(controller.state.startup.phase).toBe('failed');
    expect(controller.state.startup.detail).toContain('launch unreachable');
    controller.dispose();
  });

  test('prompts wait for startup while local controls stay available', async () => {
    const catalog = deferred<void>();
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.listAgentsHook = async () => {
      await catalog.promise;
      return [];
    };
    let exits = 0;
    const controller = makeController(
      async () => [],
      backend,
      () => 10_000,
      {
        requestExit: () => {
          exits += 1;
        },
      },
    );

    const booting = controller.bootstrap();
    expect(controller.state.startup.phase).toBe('loading');
    controller.setComposer(composerFrom('hello'));
    await controller.submit();
    expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
    expect(controller.state.notice?.text).toContain('Still loading sessions');

    // A frontend-local command needs no catalog and must not be held back.
    controller.setComposer(composerFrom('/quit'));
    await controller.submit();
    expect(exits).toBe(1);

    catalog.resolve();
    await booting;
    expect(controller.state.startup.phase).toBe('ready');
    controller.openSession('ses_a');
    await flush();
    controller.setComposer(composerFrom('hello'));
    await controller.submit();
    expect(backend.calls.filter((call) => call.name === 'prompt')).toHaveLength(1);
    controller.dispose();
  });
});

function remoteController(remoteFiles: string[], directory: string, cwd: string) {
  const backend = new FakeBackend();
  backend.remoteFiles = remoteFiles;
  backend.sessions = [{ ...fakeSession('ses_remote'), directory }];
  const controller = new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'win32',
    cwd,
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    remoteFilesystem: true,
    requestExit: () => {},
  });
  return { backend, controller };
}

/** Two-host controller: a local active session plus an idle remote session on srv_1. */
function multiServerController() {
  const local = new FakeBackend();
  const remote = new FakeBackend();
  remote.serverID = 'srv_1';
  local.sessions = [{ ...fakeSession('ses_local'), directory: '/work/kohjoh' }];
  remote.sessions = [{ ...fakeSession('ses_remote'), directory: '/remote/proj' }];
  // The local session is active so it lists under the "active" tab; the remote one is idle.
  local.active.add('ses_local');
  const controller = new AppController({
    backend: local,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    requestExit: () => {},
    serverIDs: () => ['srv_1'],
    backendFor: (serverID: string) => (serverID === 'srv_1' ? remote : local),
    serverInfo: () => ({ online: true }),
  });
  return { controller, local, remote };
}

/** Controller seeded with persisted history; captures every persisted local-state snapshot. */
function historyController(localState: LocalState, backend: FakeBackend = new FakeBackend()) {
  const saved: { value?: LocalState } = {};
  const controller = new AppController({
    backend,
    config: defaultConfig,
    localState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async (state) => {
      saved.value = state;
    },
    listFiles: () => Promise.resolve([]),
    requestExit: () => {},
  });
  return { controller, saved };
}

/** Walks the overview selection (from the composer) onto the session for `directory`. */
function selectRowForDirectory(controller: AppController, directory: string): void {
  controller.focusOverviewComposer();
  const rows = controller.overviewRows();
  const targetIndex = rows.findIndex(
    (row) => row.kind === 'session' && row.session.directory === directory,
  );
  if (targetIndex < 0) throw new Error(`no overview row for ${directory}`);
  // From the composer, one Up lands on the last row; each further Up steps back one row.
  const ups = rows.length - targetIndex;
  for (let i = 0; i < ups; i += 1) controller.moveOverviewSelection(-1);
  const row = controller.selectedOverviewRow();
  if (row?.kind !== 'session' || row.session.directory !== directory) {
    throw new Error(`failed to select ${directory}`);
  }
}

const catalogAgentA = { id: 'agent-a', name: 'agent-a', mode: 'primary' as const, hidden: false };
const catalogAgentB = { id: 'agent-b', name: 'agent-b', mode: 'primary' as const, hidden: false };
const catalogAgentC = { id: 'agent-c', name: 'agent-c', mode: 'primary' as const, hidden: false };
const catalogModelA = {
  providerID: 'p',
  modelID: 'model-a',
  name: 'model-a',
  enabled: true,
  variants: [],
};
const catalogModelB = {
  providerID: 'p',
  modelID: 'model-b',
  name: 'model-b',
  enabled: true,
  variants: [],
};
const catalogModelC = {
  providerID: 'p',
  modelID: 'model-c',
  name: 'model-c',
  enabled: true,
  variants: [],
};

/** Multi-host controller: A (local) serves /proj-a and /proj-c; B (srv_1) serves /proj-b. */
function catalogController() {
  const backendA = new FakeBackend();
  const backendB = new FakeBackend();
  backendB.serverID = 'srv_1';
  // Per-directory catalogs: host A's /proj-a and /proj-c, host B's /proj-b are disjoint.
  backendA.listAgents = async (directory?: string) => {
    if (directory === '/proj-a') return [catalogAgentA];
    if (directory === '/proj-c') return [catalogAgentC];
    return [];
  };
  backendA.listModels = async (directory?: string) => {
    if (directory === '/proj-a') return [catalogModelA];
    if (directory === '/proj-c') return [catalogModelC];
    return [];
  };
  backendA.defaultModel = async (directory?: string) => {
    if (directory === '/proj-a') return catalogModelA;
    if (directory === '/proj-c') return catalogModelC;
    return undefined;
  };
  backendB.listAgents = async (directory?: string) =>
    directory === '/proj-b' ? [catalogAgentB] : [];
  backendB.listModels = async (directory?: string) =>
    directory === '/proj-b' ? [catalogModelB] : [];
  backendB.defaultModel = async (directory?: string) =>
    directory === '/proj-b' ? catalogModelB : undefined;
  backendA.sessions = [{ ...fakeSession('ses_a'), directory: '/proj-a' }];
  backendA.sessions.push({ ...fakeSession('ses_c'), directory: '/proj-c' });
  backendB.sessions = [{ ...fakeSession('ses_b'), serverID: 'srv_1', directory: '/proj-b' }];
  const controller = new AppController({
    backend: backendA,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    requestExit: () => {},
    serverIDs: () => ['srv_1'],
    backendFor: (serverID: string) => (serverID === 'srv_1' ? backendB : backendA),
    serverInfo: () => ({ online: true }),
  });
  return {
    controller,
    backendA,
    backendB,
    agentA: catalogAgentA,
    agentB: catalogAgentB,
    modelA: catalogModelA,
    modelB: catalogModelB,
    modelC: catalogModelC,
  };
}

/** Two-host controller: local ('/proj-a', '/shared') and remote srv_1 ('/proj-b', '/shared'). */
function twoHostController() {
  const backendA = new FakeBackend();
  const backendB = new FakeBackend();
  backendB.serverID = 'srv_1';
  backendA.sessions = [
    { ...fakeSession('ses_a'), directory: '/proj-a' },
    { ...fakeSession('ses_same'), directory: '/shared' },
  ];
  backendB.sessions = [
    { ...fakeSession('ses_b'), serverID: 'srv_1', directory: '/proj-b' },
    { ...fakeSession('ses_same'), serverID: 'srv_1', directory: '/shared' },
  ];
  const controller = new AppController({
    backend: backendA,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    requestExit: () => {},
    serverIDs: () => ['srv_1'],
    backendFor: (serverID: string) => (serverID === 'srv_1' ? backendB : backendA),
    serverInfo: () => ({ online: true }),
  });
  return { controller, backendA, backendB };
}

function isPromptDraft(value: unknown): value is PromptDraft {
  return typeof value === 'object' && value !== null && 'text' in value && 'files' in value;
}

function promptDraft(backend: FakeBackend): PromptDraft {
  const call = backend.calls.find((entry) => entry.name === 'prompt');
  if (call === undefined) throw new Error('prompt was not recorded');
  if (!isPromptDraft(call.args[1])) throw new Error('prompt draft missing');
  return call.args[1];
}

describe('agent switch confirmation, picker admission and session isolation (#132, #146, #163)', () => {
  test('a delayed agent switch blocks admission until the server confirms it (#132)', async () => {
    const backend = new FakeBackend();
    backend.agents = [agentFor('build'), agentFor('plan')];
    backend.sessions = [fakeSession('ses_a')];
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realSwitch = backend.switchAgent.bind(backend);
    backend.switchAgent = async (sessionID, agent) => {
      await gate;
      await realSwitch(sessionID, agent);
    };
    const switching = controller.cycleAgent(1);
    await flush();
    controller.setComposer(composerFrom('hello'));
    await controller.submit();
    expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
    expect(controller.state.notice?.text).toContain('Agent selection pending');
    release();
    await switching;
    expect(controller.currentAgentID()).toBe('plan');
    await controller.submit();
    expect(backend.calls.filter((call) => call.name === 'prompt')).toHaveLength(1);
    controller.dispose();
  });

  test('a rejected switch restores the previous agent and blocks sending (#132)', async () => {
    const backend = new FakeBackend();
    backend.agents = [agentFor('build'), agentFor('plan')];
    backend.sessions = [fakeSession('ses_a')];
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    backend.switchAgent = async () => {
      throw new Error('switch rejected');
    };
    await controller.cycleAgent(1);
    expect(controller.currentAgentID()).toBe('build');
    controller.setComposer(composerFrom('hello'));
    await controller.submit();
    expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
    expect(controller.state.notice?.text).toContain('unconfirmed');
    controller.dispose();
  });

  test('an omitted summary agent resolves from the latest transcript evidence (#225)', async () => {
    const backend = new FakeBackend();
    backend.agents = [agentFor('build'), agentFor('plan')];
    backend.sessions = [agentlessSession('ses_a')];
    backend.messages = {
      ses_a: [
        { kind: 'user', id: 'u1', createdAt: 1, text: 'switch', attachments: [] },
        { kind: 'agent-switched', id: 's1', createdAt: 2, agent: 'plan' },
        {
          kind: 'assistant',
          id: 'a1',
          createdAt: 3,
          agent: 'plan',
          model: { providerID: 'opencode', modelID: 'longcat' },
          parts: [],
        },
      ],
    };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    expect(controller.currentAgentID()).toBe('plan');
    // Shift+Tab advances from the resolved agent, not from "unknown".
    await controller.cycleAgent(1);
    expect(backend.calls.find((call) => call.name === 'switchAgent')?.args).toEqual([
      'ses_a',
      'build',
    ]);
    expect(controller.currentAgentID()).toBe('build');
    controller.dispose();
  });

  test('an unknown agent is not invented as Build (#225)', async () => {
    const backend = new FakeBackend();
    backend.agents = [agentFor('build'), agentFor('plan')];
    backend.sessions = [agentlessSession('ses_a')];
    backend.messages = { ses_a: [] };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    expect(controller.currentAgentID()).toBeUndefined();
    expect(controller.currentAgentID()).not.toBe('build');
    controller.dispose();
  });

  test('a successful switch is accepted when the summary omits the optional agent (#225)', async () => {
    const backend = new FakeBackend();
    backend.agents = [agentFor('build'), agentFor('plan')];
    const withoutAgent = agentlessSession('ses_a');
    backend.sessions = [withoutAgent];
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    backend.getSession = async () => withoutAgent;
    await controller.cycleAgent(1);
    expect(backend.calls.find((call) => call.name === 'switchAgent')?.args).toEqual([
      'ses_a',
      'build',
    ]);
    expect(controller.currentAgentID()).toBe('build');
    expect(controller.state.notice?.text ?? '').not.toContain('unconfirmed');
    controller.dispose();
  });

  test('a newer external switch supersedes a locally confirmed agent (#253)', async () => {
    const backend = new FakeBackend();
    backend.agents = [agentFor('build'), agentFor('plan')];
    backend.sessions = [agentlessSession('ses_a')];
    backend.messages = { ses_a: [] };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    expect(controller.currentAgentID()).toBeUndefined();
    // Keep the summary `agent`-less like a v2 server that omits the optional field.
    backend.switchAgent = async (sessionID, agent) => {
      backend.calls.push({ name: 'switchAgent', args: [sessionID, agent] });
    };
    await controller.cycleAgent(1);
    expect(controller.currentAgentID()).toBe('build');

    // Another client switches to Plan; the summary still omits `agent`, but the newest
    // transcript evidence is newer than the one the local acknowledgement accounted for.
    backend.messages = {
      ses_a: [{ kind: 'agent-switched', id: 's2', createdAt: 20_000, agent: 'plan' }],
    };
    controller.openSession('ses_a');
    await flush();
    expect(controller.currentAgentID()).toBe('plan');
    controller.dispose();
  });

  test('an older transcript message cannot undo a locally confirmed switch (#253)', async () => {
    const backend = new FakeBackend();
    backend.agents = [agentFor('build'), agentFor('plan')];
    backend.sessions = [agentlessSession('ses_a')];
    backend.messages = {
      ses_a: [{ kind: 'agent-switched', id: 's1', createdAt: 2, agent: 'plan' }],
    };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    expect(controller.currentAgentID()).toBe('plan');

    // Confirm Build without letting the summary gain an `agent` field, then reload the
    // same older transcript page. The acknowledgement must remain authoritative.
    backend.switchAgent = async (sessionID, agent) => {
      backend.calls.push({ name: 'switchAgent', args: [sessionID, agent] });
    };
    await controller.cycleAgent(1);
    expect(controller.currentAgentID()).toBe('build');
    controller.openSession('ses_a');
    await flush();
    expect(controller.currentAgentID()).toBe('build');
    controller.dispose();
  });

  test('deleting and recreating a session does not leak its confirmed agent (#253)', async () => {
    const backend = new FakeBackend();
    backend.agents = [agentFor('build'), agentFor('plan')];
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [] };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    expect(controller.currentAgentID()).toBe('build');

    controller.onEvents('local', [{ kind: 'session-deleted', sessionID: 'ses_a' }], false);
    backend.sessions = [agentlessSession('ses_a')];
    controller.openSession('ses_a');
    await flush();
    expect(controller.currentAgentID()).toBeUndefined();
    controller.dispose();
  });

  test('a delayed keyboard picker open is dropped after navigation (#146)', async () => {
    const backend = new FakeBackend();
    backend.agents = [agentFor('build')];
    backend.sessions = [fakeSession('ses_a')];
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.listAgents = async () => {
      await gate;
      return [agentFor('build')];
    };
    controller.startNewSession('/other'); // kicks off a held catalog load
    await flush();
    const opening = controller.openAgentPicker(); // no footer token: centralized admission
    controller.startNewSession('/third'); // navigate away while the catalog is pending
    release();
    await opening;
    expect(controller.state.overlay.kind).toBe('none');
    controller.dispose();
  });

  test('a prompt in session B is not blocked by session A admitting (#163)', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a'), fakeSession('ses_b')];
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realPrompt = backend.prompt.bind(backend);
    backend.prompt = async (sessionID, draft) => {
      if (sessionID === 'ses_a') await gate; // hold only A, not B
      return realPrompt(sessionID, draft);
    };
    controller.setComposer(composerFrom('from A'));
    const sendingA = controller.submit();
    controller.openSession('ses_b');
    await flush();
    controller.setComposer(composerFrom('from B'));
    await controller.submit();
    expect(backend.calls.filter((call) => call.name === 'prompt')).toHaveLength(1);
    expect(promptDraft(backend).text).toBe('from B');
    release();
    await sendingA;
    controller.dispose();
  });
});

describe('remote @file resolution (issue #9)', () => {
  test('resolves a relative mention against the server project directory', async () => {
    const { backend, controller } = remoteController(
      ['src/main.ts', 'README.md'],
      '/srv/proj',
      'C:\\Users\\me\\proj',
    );
    await controller.bootstrap();
    await controller.sendToSession('ses_remote', 'inspect @src/main.ts');

    expect(promptDraft(backend).files).toEqual([
      {
        uri: 'file:///srv/proj/src/main.ts',
        name: 'src/main.ts',
        mention: { start: 8, end: 20, text: '@src/main.ts' },
      },
    ]);
    controller.dispose();
  });

  test('resolves an absolute mention inside the server project', async () => {
    const { backend, controller } = remoteController(
      ['src/main.ts'],
      '/srv/proj',
      'C:\\Users\\me\\proj',
    );
    await controller.bootstrap();
    await controller.sendToSession('ses_remote', 'inspect @/srv/proj/src/main.ts');

    expect(promptDraft(backend).files).toEqual([
      {
        uri: 'file:///srv/proj/src/main.ts',
        name: '/srv/proj/src/main.ts',
        mention: { start: 8, end: 30, text: '@/srv/proj/src/main.ts' },
      },
    ]);
    controller.dispose();
  });

  test('windows client paths resolve against a windows server case-insensitively', async () => {
    const { backend, controller } = remoteController(
      ['src\\main.ts'],
      'C:\\Users\\u\\proj',
      'C:\\Users\\me\\proj',
    );
    await controller.bootstrap();
    await controller.sendToSession('ses_remote', 'inspect @SRC\\MAIN.TS');

    expect(promptDraft(backend).files).toEqual([
      {
        uri: 'file:///C:/Users/u/proj/src/main.ts',
        name: 'SRC\\MAIN.TS',
        mention: { start: 8, end: 20, text: '@SRC\\MAIN.TS' },
      },
    ]);
    controller.dispose();
  });

  test('a cross-shape absolute mention is reported and not sent', async () => {
    const { backend, controller } = remoteController(
      ['src/main.ts'],
      '/srv/proj',
      'C:\\Users\\me\\proj',
    );
    await controller.bootstrap();
    await controller.sendToSession('ses_remote', 'inspect @C:\\proj\\a.ts');

    expect(promptDraft(backend).files).toEqual([]);
    expect(controller.state.notice?.text).toBe(
      'Could not resolve on the server: @C:\\proj\\a.ts. The reference was not sent.',
    );
    controller.dispose();
  });

  test('a reference escaping the project is reported and not sent', async () => {
    const { backend, controller } = remoteController(
      ['src/main.ts'],
      '/srv/proj',
      'C:\\Users\\me\\proj',
    );
    await controller.bootstrap();
    await controller.sendToSession('ses_remote', 'inspect @../outside.ts');

    expect(promptDraft(backend).files).toEqual([]);
    expect(controller.state.notice?.text).toBe(
      'Could not resolve on the server: @../outside.ts. The reference was not sent.',
    );
    controller.dispose();
  });

  test('a missing server file is reported and not sent', async () => {
    const { backend, controller } = remoteController(
      ['src/main.ts'],
      '/srv/proj',
      'C:\\Users\\me\\proj',
    );
    await controller.bootstrap();
    await controller.sendToSession('ses_remote', 'inspect @src/missing.ts');

    expect(promptDraft(backend).files).toEqual([]);
    expect(controller.state.notice?.text).toBe(
      'Could not resolve on the server: @src/missing.ts. The reference was not sent.',
    );
    controller.dispose();
  });

  test('completion is served by the server file index, not the local filesystem', async () => {
    const { backend, controller } = remoteController(
      ['src/main.ts', 'docs/remote.md'],
      '/srv/proj',
      'C:\\Users\\me\\proj',
    );
    controller.setComposer(composerFrom('@main'));
    await flush();

    expect(backend.calls.some((entry) => entry.name === 'findProjectFiles')).toBe(true);
    expect(controller.state.completion?.items.map((item) => item.label)).toEqual(['@src/main.ts']);
    controller.dispose();
  });
});

describe('directory and line-range attachments (#98)', () => {
  test('a one-based range becomes start/end query parameters on the file URI', async () => {
    const { backend, controller } = remoteController(
      ['src/app.ts'],
      '/srv/proj',
      'C:\\Users\\me\\proj',
    );
    await controller.bootstrap();
    await controller.sendToSession('ses_remote', 'read @src/app.ts#20-45');
    expect(promptDraft(backend).files[0]?.uri).toBe('file:///srv/proj/src/app.ts?start=20&end=45');
    expect(promptDraft(backend).files[0]?.mention?.text).toBe('@src/app.ts#20-45');
    controller.dispose();
  });

  test('an invalid range never sends a malformed attachment', async () => {
    const { backend, controller } = remoteController(
      ['src/app.ts'],
      '/srv/proj',
      'C:\\Users\\me\\proj',
    );
    await controller.bootstrap();
    await controller.sendToSession('ses_remote', 'read @src/app.ts#45-20');
    expect(promptDraft(backend).files).toEqual([]);
    expect(controller.state.notice?.text).toContain('Invalid line range');
    controller.dispose();
  });

  test('a verified remote directory is attached through the server directory index', async () => {
    const { backend, controller } = remoteController([], '/srv/proj', 'C:\\Users\\me\\proj');
    backend.remoteDirectories = ['src'];
    await controller.bootstrap();
    await controller.sendToSession('ses_remote', 'inspect @src');
    const draft = promptDraft(backend);
    expect(draft.files[0]?.uri).toBe('file:///srv/proj/src');
    expect(backend.calls.some((call) => call.name === 'findProjectDirectories')).toBe(true);
    controller.dispose();
  });
});

describe('typed agent attachments (#99)', () => {
  test('adjacent agent and ranged file mentions keep their server and spans (#173)', async () => {
    const { backend, controller } = remoteController(
      ['src/app.ts'],
      '/srv/proj',
      'C:\\Users\\me\\proj',
    );
    backend.agents = [agentFor('reviewer')];
    try {
      await controller.bootstrap();
      await controller.sendToSession('ses_remote', 'ask @reviewer,@src/app.ts#2-4');
      const draft = promptDraft(backend);
      expect(draft.agents).toEqual([
        { name: 'reviewer', mention: { start: 4, end: 13, text: '@reviewer' } },
      ]);
      expect(draft.files[0]?.uri).toBe('file:///srv/proj/src/app.ts?start=2&end=4');
      expect(draft.files[0]?.mention).toEqual({ start: 14, end: 29, text: '@src/app.ts#2-4' });
    } finally {
      controller.dispose();
    }
  });

  test('a bare @agent mention is sent as an agent attachment, not a file lookup', async () => {
    const backend = new FakeBackend();
    backend.agents = [agentFor('reviewer')];
    backend.sessions = [fakeSession('ses_a')];
    const controller = makeController(async () => [], backend);
    await controller.loadCatalog('/work/kohjoh', 'local');
    await attach(controller, 'ses_a');
    await controller.sendToSession('ses_a', 'ask @reviewer about this');
    const draft = promptDraft(backend);
    expect(draft.agents).toEqual([
      { name: 'reviewer', mention: { start: 4, end: 13, text: '@reviewer' } },
    ]);
    expect(backend.calls.some((call) => call.name === 'findProjectFiles')).toBe(false);
    controller.dispose();
  });

  test('agent completion is distinguished from files and scoped to the catalog', async () => {
    const backend = new FakeBackend();
    backend.agents = [agentFor('reviewer')];
    const controller = makeController(async () => [], backend);
    await controller.loadCatalog('/work/kohjoh', 'local');
    controller.setComposer(composerFrom('@rev'));
    await flush();
    expect(controller.state.completion?.items.map((item) => item.label)).toEqual(['@reviewer']);
    expect(controller.state.completion?.items[0]?.detail).toBe('agent');
    controller.dispose();
  });

  test('a subagent-only agent is a valid @attachment but not a primary selection (#133)', async () => {
    const backend = new FakeBackend();
    backend.agents = [agentFor('build'), { ...agentFor('reviewer'), mode: 'subagent' }];
    backend.sessions = [fakeSession('ses_a')];
    const controller = makeController(async () => [], backend);
    await controller.loadCatalog('/work/kohjoh', 'local');
    expect(controller.state.agents.map((agent) => agent.id)).toEqual(['build']);
    expect(controller.state.mentionAgents.map((agent) => agent.id)).toEqual(['build', 'reviewer']);
    await attach(controller, 'ses_a');
    await controller.sendToSession('ses_a', 'ask @reviewer about this');
    expect(promptDraft(backend).agents).toEqual([
      { name: 'reviewer', mention: { start: 4, end: 13, text: '@reviewer' } },
    ]);
    expect(backend.calls.some((call) => call.name === 'findProjectFiles')).toBe(false);
    controller.dispose();
  });

  test('completion suggests only mention-eligible agents from the verified snapshot (#133/#134)', async () => {
    const backend = new FakeBackend();
    backend.agents = [agentFor('build'), { ...agentFor('reviewer'), mode: 'subagent' }];
    const controller = makeController(async () => [], backend);
    await controller.loadCatalog('/work/kohjoh', 'local');
    controller.setComposer(composerFrom('@rev'));
    await flush();
    expect(controller.state.completion?.items.map((item) => item.label)).toEqual(['@reviewer']);
    controller.dispose();
  });

  test('an unverifiable catalog fails closed for @name but not for plain prompts (#134)', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    let catalogAvailable = true;
    backend.listAgents = async () => {
      if (!catalogAvailable) throw new Error('catalog broken');
      return [agentFor('reviewer')];
    };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a'); // catalog loads successfully at first
    catalogAvailable = false;
    // Navigate away and back so the session's catalog must reload — and now cannot be verified.
    controller.startNewSession('/other');
    await flush();
    controller.openSession('ses_a');
    await flush();
    controller.setComposer(composerFrom('ask @reviewer about this'));
    await controller.submit();
    expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
    expect(controller.state.composer.text).toBe('ask @reviewer about this');
    expect(controller.state.notice?.text).toContain('Cannot verify');

    catalogAvailable = true;
    await controller.loadCatalog('/work/kohjoh', 'local');
    controller.setComposer(composerFrom('just a plain prompt'));
    await controller.submit();
    expect(promptDraft(backend).text).toBe('just a plain prompt');
    controller.dispose();
  });
});

function pagedSessions(count: number): SessionSummary[] {
  return Array.from({ length: count }, (_, index) => fakeSession(`s${index}`));
}

function onePerPageHook(
  pages: SessionSummary[],
): (query: { cursor?: string }) => Promise<{ sessions: SessionSummary[]; nextCursor?: string }> {
  return async (query) => {
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const slice = pages.slice(start, start + 1);
    return {
      sessions: slice,
      ...(start + 1 < pages.length ? { nextCursor: String(start + 1) } : {}),
    };
  };
}

describe('continue/resume attach (issues #10 #11)', () => {
  test('findLatestSessionIn pages past the first pages for the target directory only', async () => {
    const backend = new FakeBackend();
    // 600 sessions in other directories; one older matching session in /work/kohjoh.
    const pages = Array.from({ length: 600 }, (_, index) => ({
      ...fakeSession(`other-${index}`),
      directory: '/elsewhere',
      updatedAt: 10_000 + index,
    }));
    const match = { ...fakeSession('match'), updatedAt: 5 };
    backend.listSessionsHook = async (query) => {
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      if (query.directory === '/work/kohjoh') {
        return start === 0 ? { sessions: [match] } : { sessions: [] };
      }
      const slice = pages.slice(start, start + 100);
      return {
        sessions: slice,
        ...(start + 100 < pages.length ? { nextCursor: String(start + 100) } : {}),
      };
    };
    const controller = makeController(() => Promise.resolve([]), backend);
    const found = await controller.findLatestSessionIn('/work/kohjoh');
    expect(found?.id).toBe('match');
    expect(controller.state.sessions['match']?.directory).toBe('/work/kohjoh');
    controller.dispose();
  });

  test('findLatestSessionIn excludes archived and child sessions', async () => {
    const backend = new FakeBackend();
    const archived = { ...fakeSession('archived'), archived: true, updatedAt: 99 };
    const child = { ...fakeSession('child'), parentID: 'parent', updatedAt: 100 };
    const fresh = { ...fakeSession('fresh'), updatedAt: 50 };
    backend.listSessionsHook = async (query) =>
      query.directory === '/work/kohjoh'
        ? { sessions: [archived, child, fresh] }
        : { sessions: [] };
    const controller = makeController(() => Promise.resolve([]), backend);
    const found = await controller.findLatestSessionIn('/work/kohjoh');
    expect(found?.id).toBe('fresh');
    controller.dispose();
  });

  test('findLatestSessionIn returns nothing without a complete directory-targeted match', async () => {
    const backend = new FakeBackend();
    backend.listSessionsHook = async () => ({
      sessions: [{ ...fakeSession('elsewhere'), directory: '/x' }],
    });
    const controller = makeController(() => Promise.resolve([]), backend);
    expect(await controller.findLatestSessionIn('/work/kohjoh')).toBeUndefined();
    controller.dispose();
  });

  test('ensureSession stores a fetched summary before attach/prompt', async () => {
    const backend = new FakeBackend();
    const session = {
      ...fakeSession('ses_x'),
      directory: '/project-b',
      model: { providerID: 'p', modelID: 'm' },
    };
    backend.sessions = [session];
    const controller = makeController(() => Promise.resolve([]), backend);
    // Not loaded initially: state knows nothing about it.
    expect(controller.state.sessions['ses_x']).toBeUndefined();
    const ensured = await controller.ensureSession('ses_x');
    expect(ensured?.directory).toBe('/project-b');
    expect(controller.state.sessions['ses_x']?.model?.modelID).toBe('m');
    controller.dispose();
  });

  test('ensureSession distinguishes a missing session from an unloaded one', async () => {
    const backend = new FakeBackend();
    backend.getSession = async () => {
      throw new BackendError('not-found', 'getSession', 'nope');
    };
    const controller = makeController(() => Promise.resolve([]), backend);
    expect(await controller.ensureSession('ses_nope')).toBeUndefined();
    controller.dispose();
  });

  test('sendToSession uses the fetched session directory for file mentions', async () => {
    const backend = new FakeBackend();
    const session = { ...fakeSession('ses_y'), directory: '/project-b' };
    backend.sessions = [session];
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    // Drop the in-memory copy so the fetch path is exercised.
    controller.openOverview();
    await controller.sendToSession('ses_y', 'inspect @src/a.ts');
    controller.dispose();
  });
});

/** Controller wired to several independent fake hosts, with per-host platform styles. */
function routingController(
  backends: Record<string, FakeBackend>,
  activeServerID: string,
  platforms: Record<string, NodeJS.Platform> = {},
) {
  return new AppController({
    backend: backends[activeServerID] ?? new FakeBackend(),
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    requestExit: () => {},
    serverID: activeServerID,
    serverIDs: () => Object.keys(backends),
    backendFor: (id) => backends[id],
    platformFor: (id) => platforms[id] ?? 'linux',
  });
}

const sharedOn = (serverID: string, directory = '/work/kohjoh') => ({
  ...fakeSession('ses_shared'),
  serverID,
  directory,
});

describe('server-qualified CLI session routing (#149)', () => {
  test('unscoped resume of a colliding ID is ambiguous, not silently resolved', async () => {
    const a = new FakeBackend();
    a.serverID = 'srv_a';
    const b = new FakeBackend();
    b.serverID = 'srv_b';
    a.sessions = [sharedOn('srv_a')];
    b.sessions = [sharedOn('srv_b')];
    const controller = routingController({ srv_a: a, srv_b: b }, 'srv_a');
    await controller.bootstrap();

    const result = await controller.resolveCliSession('ses_shared');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ambiguous');
      expect(result.message).toContain('srv_a');
      expect(result.message).toContain('srv_b');
      expect(result.message).toContain('--remote');
    }
    controller.dispose();
  });

  test('an explicit host resolves only that host, even when the launch host has the ID', async () => {
    const a = new FakeBackend();
    a.serverID = 'srv_a';
    const b = new FakeBackend();
    b.serverID = 'srv_b';
    a.sessions = [sharedOn('srv_a', '/project-a')];
    b.sessions = [sharedOn('srv_b', '/project-b')];
    let bRead = false;
    b.getSession = async (id) => {
      bRead = true;
      return b.sessions.find((s) => s.id === id)!;
    };
    const controller = routingController({ srv_a: a, srv_b: b }, 'srv_a');
    await controller.bootstrap();

    const result = await controller.resolveCliSession('ses_shared', { serverID: 'srv_b' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ref).toEqual({ serverID: 'srv_b', sessionID: 'ses_shared' });
      expect(result.directory).toBe('/project-b');
    }
    expect(bRead).toBe(true);
    controller.dispose();
  });

  test('applyCliOverrides with a qualified ref mutates only the owning host', async () => {
    const a = new FakeBackend();
    a.serverID = 'srv_a';
    const b = new FakeBackend();
    b.serverID = 'srv_b';
    a.sessions = [{ ...sharedOn('srv_a', '/project-a'), agent: 'stale' }];
    b.sessions = [sharedOn('srv_b', '/project-b')];
    b.agents = [agentFor('agent-b')];
    b.models = modelFor('model-b');
    const controller = routingController({ srv_a: a, srv_b: b }, 'srv_a');
    await controller.bootstrap();

    const result = await controller.applyCliOverrides(
      { serverID: 'srv_b', sessionID: 'ses_shared' },
      { agent: 'agent-b', model: 'model-b' },
    );
    expect(result).toEqual({ ok: true });
    expect(b.calls.some((call) => call.name === 'switchAgent')).toBe(true);
    expect(b.calls.some((call) => call.name === 'switchModel')).toBe(true);
    expect(a.calls.some((call) => call.name === 'switchAgent' || call.name === 'switchModel')).toBe(
      false,
    );
    controller.dispose();
  });

  test('sendToSession with a qualified ref admits the prompt only on the owning host', async () => {
    const a = new FakeBackend();
    a.serverID = 'srv_a';
    const b = new FakeBackend();
    b.serverID = 'srv_b';
    a.sessions = [sharedOn('srv_a', '/project-a')];
    b.sessions = [sharedOn('srv_b', '/project-b')];
    const controller = routingController({ srv_a: a, srv_b: b }, 'srv_a');
    await controller.bootstrap();

    await controller.sendToSession({ serverID: 'srv_b', sessionID: 'ses_shared' }, 'check');
    expect(b.calls.some((call) => call.name === 'prompt')).toBe(true);
    expect(a.calls.some((call) => call.name === 'prompt')).toBe(false);
    controller.dispose();
  });
});

describe('server-scoped continue fallback (#152)', () => {
  test("a query failure on A never selects B's newer session from cache", async () => {
    const a = new FakeBackend();
    a.serverID = 'srv_a';
    const b = new FakeBackend();
    b.serverID = 'srv_b';
    a.sessions = [{ ...fakeSession('ses_a'), serverID: 'srv_a', updatedAt: 10 }];
    b.sessions = [{ ...fakeSession('ses_b'), serverID: 'srv_b', updatedAt: 99 }];
    // Directory-targeted filtering is unsupported on A; bootstrap's unscoped list still works.
    a.listSessionsHook = async (query) => {
      if (query.directory !== undefined)
        throw new BackendError('invalid', 'session.list', 'unsupported directory filter');
      return { sessions: a.sessions };
    };
    const controller = routingController({ srv_a: a, srv_b: b }, 'srv_a');
    await controller.bootstrap();

    const found = await controller.findLatestSessionIn('/work/kohjoh', 'srv_a');
    expect(found?.id).toBe('ses_a');
    controller.dispose();
  });

  test('a transport failure is surfaced instead of guessing a session from cache', async () => {
    const a = new FakeBackend();
    a.serverID = 'srv_a';
    a.sessions = [{ ...fakeSession('ses_a'), serverID: 'srv_a' }];
    a.listSessionsHook = async (query) => {
      if (query.directory !== undefined)
        throw new BackendError('transport', 'session.list', 'offline');
      return { sessions: a.sessions };
    };
    const controller = routingController({ srv_a: a }, 'srv_a');
    await controller.bootstrap();

    let threw = false;
    try {
      await controller.findLatestSessionIn('/work/kohjoh', 'srv_a');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    controller.dispose();
  });

  test('rows owned by another host in the target page are ignored', async () => {
    const a = new FakeBackend();
    a.serverID = 'srv_a';
    a.listSessionsHook = async () => ({
      sessions: [
        { ...fakeSession('ses_b'), serverID: 'srv_b', updatedAt: 99 },
        { ...fakeSession('ses_a'), serverID: 'srv_a', updatedAt: 10 },
      ],
    });
    const controller = routingController({ srv_a: a }, 'srv_a');
    await controller.bootstrap();

    const found = await controller.findLatestSessionIn('/work/kohjoh', 'srv_a');
    expect(found?.id).toBe('ses_a');
    controller.dispose();
  });

  test('candidate paths are normalized with the owning host platform', async () => {
    const a = new FakeBackend();
    a.serverID = 'srv_a';
    const win = new FakeBackend();
    win.serverID = 'srv_win';
    a.listSessionsHook = async () => ({ sessions: [] });
    win.listSessionsHook = async () => ({
      sessions: [
        {
          ...fakeSession('ses_win'),
          serverID: 'srv_win',
          directory: 'C:\\Work\\Project',
          updatedAt: 99,
        },
      ],
    });
    // Cases and separators are folded with the owning host's platform (Windows here), and a
    // POSIX-looking path is a different project on that host.
    const controller = routingController({ srv_a: a, srv_win: win }, 'srv_a', {
      srv_win: 'win32',
    });
    await controller.bootstrap();

    expect((await controller.findLatestSessionIn('c:/work/project', 'srv_win'))?.id).toBe(
      'ses_win',
    );
    expect(await controller.findLatestSessionIn('/work/project', 'srv_win')).toBeUndefined();
    controller.dispose();
  });
});

const agentFor = (id: string) => ({ id, name: id, mode: 'primary' as const, hidden: false });
const modelFor = (id: string) => [
  { providerID: 'p', modelID: id, name: id, enabled: true, variants: [] },
];

const catalogs: Record<
  string,
  {
    agents: ReturnType<typeof agentFor>[];
    models: ReturnType<typeof modelFor>;
    commands: { name: string; description?: string }[];
  }
> = {
  '/project-a': {
    agents: [agentFor('agent-a')],
    models: modelFor('model-a'),
    commands: [{ name: 'cmd-a' }],
  },
  '/project-b': {
    agents: [agentFor('agent-b')],
    models: modelFor('model-b'),
    commands: [{ name: 'cmd-b' }],
  },
};

function scopedBackend(hooks?: { holdB?: Promise<void> }) {
  const backend = new FakeBackend();
  backend.listAgents = async (directory?: string) => {
    if (directory === '/project-b' && hooks?.holdB !== undefined) await hooks.holdB;
    return catalogs[directory ?? '/project-a']?.agents ?? [];
  };
  backend.listModels = async (directory?: string) =>
    catalogs[directory ?? '/project-a']?.models ?? [];
  backend.defaultModel = async () => undefined;
  backend.listCommands = async (directory?: string) =>
    catalogs[directory ?? '/project-a']?.commands ?? [];
  return backend;
}

function scopedController(backend: FakeBackend, cwd: string) {
  return new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd,
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    requestExit: () => {},
  });
}

describe('project-scoped catalogs (issue #2)', () => {
  test('catalog follows the project directory across A → B → A', async () => {
    const controller = scopedController(scopedBackend(), '/project-a');
    await controller.bootstrap();
    expect(controller.state.agents.map((agent) => agent.id)).toEqual(['agent-a']);
    expect(controller.catalogFresh('/project-a')).toBe(true);

    controller.startNewSession('/project-b');
    await flush();
    expect(controller.state.agents.map((agent) => agent.id)).toEqual(['agent-b']);
    expect(controller.state.models.map((model) => model.modelID)).toEqual(['model-b']);
    expect(controller.state.serverCommands.map((command) => command.name)).toEqual(['cmd-b']);
    expect(controller.catalogFresh('/project-b')).toBe(true);

    controller.startNewSession('/project-a');
    await flush();
    expect(controller.state.agents.map((agent) => agent.id)).toEqual(['agent-a']);
    controller.dispose();
  });

  test('a stale response never replaces the newer project catalog', async () => {
    const holdB = deferred<void>();
    const controller = scopedController(scopedBackend({ holdB: holdB.promise }), '/project-a');
    await controller.bootstrap();

    controller.startNewSession('/project-b'); // kicks off a slow load for B
    await flush(); // let the B fetch start
    controller.startNewSession('/project-a'); // newer route wins
    await flush();
    expect(controller.state.agents.map((agent) => agent.id)).toEqual(['agent-a']);

    holdB.resolve(); // B's response arrives late and must be discarded
    await flush();
    expect(controller.state.agents.map((agent) => agent.id)).toEqual(['agent-a']);
    expect(controller.catalogFresh('/project-a')).toBe(true);
    controller.dispose();
  });

  test("command completion never suggests another project's commands", async () => {
    const controller = scopedController(scopedBackend(), '/project-a');
    await controller.bootstrap();
    controller.startNewSession('/project-b');
    await flush();
    controller.setComposer(composerFrom('/cmd-a'));
    expect(controller.state.completion).toBeUndefined();
    controller.setComposer(composerFrom('/cmd'));
    expect(controller.state.completion?.kind).toBe('command');
    expect(controller.state.completion?.items.map((item) => item.label)).toEqual(['/cmd-b']);
    controller.dispose();
  });

  test('a failed catalog reload clears the catalog instead of serving the previous project', async () => {
    const backend = scopedBackend();
    backend.listAgents = async (directory?: string) => {
      if (directory === '/project-c') throw new Error('project-scoped config is broken');
      return catalogs[directory ?? '/project-a']?.agents ?? [];
    };
    const controller = scopedController(backend, '/project-a');
    await controller.bootstrap();
    controller.startNewSession('/project-c');
    await flush();
    expect(controller.state.catalogError).toBeDefined();
    expect(controller.state.agents).toEqual([]);
    expect(controller.state.serverCommands).toEqual([]);
    controller.setComposer(composerFrom('/cmd-a'));
    expect(controller.state.completion).toBeUndefined();
    controller.dispose();
  });
});

function revertBackend() {
  const backend = new FakeBackend();
  backend.sessions = [
    {
      ...fakeSession('ses_a'),
      revert: {
        messageID: 'm_user',
        files: [
          {
            file: 'src/a.ts',
            patch: '',
            additions: 3,
            deletions: 1,
            status: 'modified',
            truncated: false,
          },
        ],
      },
    },
  ];
  backend.messages = { ses_a: [] };
  return backend;
}

function resumeFixture() {
  const backend = scopedBackend();
  backend.sessions = [{ ...fakeSession('ses_b'), directory: '/project-b' }];
  const controller = scopedController(backend, '/project-a');
  const switches = () =>
    backend.calls.filter((call) => call.name === 'switchAgent' || call.name === 'switchModel');
  return { backend, controller, switches };
}

describe('explicit flags on resumed sessions (issue #37)', () => {
  test('flags are validated against the session project and applied', async () => {
    const { backend, controller } = resumeFixture();
    await controller.bootstrap();
    const result = await controller.applyCliOverrides('ses_b', {
      agent: 'agent-b',
      model: 'model-b',
    });
    expect(result).toEqual({ ok: true });
    expect(backend.calls.find((call) => call.name === 'switchAgent')?.args).toEqual([
      'ses_b',
      'agent-b',
    ]);
    expect(backend.calls.find((call) => call.name === 'switchModel')?.args[0]).toBe('ses_b');
    controller.dispose();
  });

  test('omitted flags change nothing', async () => {
    const { controller, switches } = resumeFixture();
    await controller.bootstrap();
    expect(await controller.applyCliOverrides('ses_b', {})).toEqual({ ok: true });
    expect(switches()).toEqual([]);
    controller.dispose();
  });

  test('an agent from another project is rejected and nothing is switched', async () => {
    const { controller, switches } = resumeFixture();
    await controller.bootstrap();
    const result = await controller.applyCliOverrides('ses_b', { agent: 'agent-a' });
    expect(result.ok).toBe(false);
    expect(switches()).toEqual([]);
    controller.dispose();
  });

  test('an unknown model is rejected before the agent is switched', async () => {
    const { controller, switches } = resumeFixture();
    await controller.bootstrap();
    const result = await controller.applyCliOverrides('ses_b', {
      agent: 'agent-b',
      model: 'nope',
    });
    expect(result.ok).toBe(false);
    expect(switches()).toEqual([]);
    controller.dispose();
  });

  test('a failing switch is reported', async () => {
    const { backend, controller } = resumeFixture();
    backend.switchAgent = async () => {
      throw new Error('boom');
    };
    await controller.bootstrap();
    const result = await controller.applyCliOverrides('ses_b', { agent: 'agent-b' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('boom');
    controller.dispose();
  });
});

describe('staged revert recovery (issue #8)', () => {
  test('attaching reveals a server-staged revert as a recovery dialog', async () => {
    const backend = revertBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    expect(controller.state.overlay).toMatchObject({
      kind: 'revert',
      sessionID: 'ses_a',
      messageID: 'm_user',
    });
    controller.dispose();
  });

  test('Esc on the recovery dialog clears the server stage', async () => {
    const backend = revertBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    controller.revertKey({ name: 'escape' });
    await flush();
    expect(backend.calls.some((call) => call.name === 'clearRevert')).toBe(true);
    expect(backend.calls.some((call) => call.name === 'commitRevert')).toBe(false);
    expect(controller.state.overlay.kind).toBe('none');
    controller.dispose();
  });

  test('an action is refused when the stage vanished under the dialog', async () => {
    const backend = revertBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    // Another client resolves the stage before the user answers.
    const index = backend.sessions.findIndex((entry) => entry.id === 'ses_a');
    const session = backend.sessions[index];
    if (session !== undefined) {
      const { revert: _revert, ...rest } = session;
      backend.sessions.splice(index, 1, rest);
    }
    controller.revertKey({ name: 'return' });
    await flush();
    expect(backend.calls.some((call) => call.name === 'commitRevert')).toBe(false);
    expect(controller.state.overlay.kind).toBe('none');
    controller.dispose();
  });

  test('a commit is refused when the stage cannot be verified', async () => {
    const backend = revertBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    backend.getSession = async () => {
      throw new Error('network down');
    };
    controller.revertKey({ name: 'return' });
    await flush();
    expect(backend.calls.some((call) => call.name === 'commitRevert')).toBe(false);
    // The dialog stays open so the user can retry or cancel once the server is reachable.
    expect(controller.state.overlay).toMatchObject({ kind: 'revert', busy: false });
    controller.dispose();
  });

  test('exiting with a pending revert clears it; nothing pending, nothing to do', async () => {
    const backend = revertBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    expect(await controller.flushRevertOnExit()).toBeUndefined();
    expect(backend.calls.some((call) => call.name === 'clearRevert')).toBe(true);
    expect(controller.state.overlay.kind).toBe('none');
    // Second call is a no-op.
    expect(await controller.flushRevertOnExit()).toBeUndefined();
    expect(backend.calls.filter((call) => call.name === 'clearRevert')).toHaveLength(1);
    controller.dispose();
  });

  test('a staged revert that resolves elsewhere dismisses the dialog', async () => {
    const backend = revertBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    expect(controller.state.overlay.kind).toBe('revert');
    const index = backend.sessions.findIndex((entry) => entry.id === 'ses_a');
    const session = backend.sessions[index];
    if (session !== undefined) {
      const { revert: _revert, ...rest } = session;
      backend.sessions.splice(index, 1, rest);
    }
    controller.onEvents(
      'local',
      [{ kind: 'revert-changed', sessionID: 'ses_a', action: 'cleared' }],
      false,
    );
    await flush();
    expect(controller.state.overlay.kind).toBe('none');
    controller.dispose();
  });
});

/** Bootstrap lists everything; after `narrow()` the listing shows only the first row. */
function reconnectFixture() {
  const backend = new FakeBackend();
  backend.sessions = ['ses_a', 'ses_b', 'ses_c'].map(fakeSession);
  backend.messages = { ses_a: [], ses_b: [], ses_c: [] };
  let narrowed = false;
  backend.listSessionsHook = async () => ({
    sessions: narrowed ? backend.sessions.slice(0, 1) : backend.sessions,
  });
  return { backend, narrow: () => (narrowed = true) };
}

describe('reconnect reconciliation (issue #36)', () => {
  test('a session deleted while disconnected is pruned, an unloaded one is kept', async () => {
    const { backend, narrow } = reconnectFixture();
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    narrow();
    expect(Object.keys(controller.state.sessions).toSorted()).toEqual(['ses_a', 'ses_b', 'ses_c']);

    backend.sessions = backend.sessions.filter((session) => session.id !== 'ses_b');
    controller.onEvents('local', [], true);
    await flush();
    expect(Object.keys(controller.state.sessions).toSorted()).toEqual(['ses_a', 'ses_c']);
    controller.dispose();
  });

  test('a transient lookup failure does not delete the row', async () => {
    const { backend, narrow } = reconnectFixture();
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    narrow();
    backend.getSession = async () => {
      throw new BackendError('transport', 'session.get', 'down');
    };
    controller.onEvents('local', [], true);
    await flush();
    expect(controller.state.sessions['ses_b']).toBeDefined();
    controller.dispose();
  });

  test('a moved or archived session is refreshed and the deleted attached one leaves', async () => {
    const { backend, narrow } = reconnectFixture();
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    narrow();
    controller.openSession('ses_b');
    await flush();
    backend.sessions = backend.sessions
      .filter((session) => session.id !== 'ses_b')
      .map((session) =>
        session.id === 'ses_c' ? { ...session, archived: true, directory: '/moved' } : session,
      );
    controller.onEvents('local', [], true);
    await flush();
    expect(controller.state.sessions['ses_c']).toMatchObject({
      archived: true,
      directory: '/moved',
    });
    expect(controller.state.sessions['ses_b']).toBeUndefined();
    expect(controller.state.route.kind).toBe('overview');
    controller.dispose();
  });
});

describe('earlier-history retry state (#144)', () => {
  test('a failed lookahead keeps a retryable cursor and no false "earlier" claim', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.listMessages = async (_sessionID, _limit, cursor) => {
      if (cursor === undefined) {
        // exact-full page with a token, but the lookahead probe is unavailable
        return { messages: [], olderCursor: 'more', hasEarlier: false, retryable: true };
      }
      return { messages: [], hasEarlier: true };
    };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    await flush();
    const transcript = controller.state.transcripts['ses_a'];
    expect(transcript?.olderCursor).toBe('more');
    expect(transcript?.olderCheckFailed).toBe(true);
    controller.dispose();
  });

  test('confirmed exhaustion clears the cursor and retry state', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.listMessages = async () => ({ messages: [], hasEarlier: false });
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    await flush();
    const transcript = controller.state.transcripts['ses_a'];
    expect(transcript?.olderCursor).toBeUndefined();
    expect(transcript?.olderCheckFailed).toBeUndefined();
    controller.dispose();
  });
});

describe('session pagination', () => {
  test('bootstrap caps the first load; Load more pages in older sessions keyboard-only', async () => {
    const backend = new FakeBackend();
    backend.listSessionsHook = onePerPageHook(pagedSessions(7));
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();

    expect(Object.keys(controller.state.sessions)).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(controller.state.sessionsComplete).toBe(false);

    controller.openOverview();
    expect(controller.state.overview.focus).toBe('list');
    const rows = controller.overviewRows();
    expect(rows[rows.length - 1]?.kind).toBe('loadmore');

    const services = { openEditor: () => {}, redraw: () => {}, scroll: () => {} };
    const { keymap } = buildKeymap({});
    const down = { name: 'down', ctrl: false, alt: false, shift: false };
    for (let step = 1; step < rows.length; step += 1) routeKey(controller, keymap, down, services);
    expect(controller.state.overview.selectedRow).toBe('loadmore');

    // Enter on the load-more row pages in the next page.
    routeKey(
      controller,
      keymap,
      { name: 'return', ctrl: false, alt: false, shift: false },
      services,
    );
    await flush();
    expect(Object.keys(controller.state.sessions)).toContain('s5');
    expect(controller.state.sessionsComplete).toBe(false);
    expect(controller.state.overview.selectedRow).toBe('loadmore'); // still selectable

    routeKey(
      controller,
      keymap,
      { name: 'return', ctrl: false, alt: false, shift: false },
      services,
    );
    await flush();
    expect(Object.keys(controller.state.sessions)).toContain('s6');
    expect(controller.state.sessionsComplete).toBe(true);
    expect(controller.overviewRows().some((row) => row.kind === 'loadmore')).toBe(false);
    // The disappearing load-more row must not strand the selection.
    expect(controller.state.overview.selectedRow).not.toBe('loadmore');
    controller.dispose();
  });

  test('a failed page load keeps prior pages and retries without duplicates', async () => {
    const backend = new FakeBackend();
    const pages = pagedSessions(7);
    const real = onePerPageHook(pages);
    let failNext = true;
    backend.listSessionsHook = async (query) => {
      // Bootstrap stops after five pages; the sixth request carries cursor '5'.
      if (query.cursor === '5' && failNext) {
        failNext = false;
        throw new Error('boom');
      }
      return real(query);
    };
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    expect(Object.keys(controller.state.sessions)).toHaveLength(5);

    await controller.loadMoreSessions();
    expect(controller.state.sessionsError).toContain('boom');
    expect(controller.state.sessionsLoading).toBe(false);
    expect(Object.keys(controller.state.sessions)).toHaveLength(5); // pages 1-5 intact

    await controller.loadMoreSessions(); // retry
    expect(controller.state.sessionsError).toBeUndefined();
    expect(Object.keys(controller.state.sessions)).toHaveLength(6);

    await controller.loadMoreSessions();
    await controller.loadMoreSessions(); // completes; further calls are no-ops
    expect(controller.state.sessionsComplete).toBe(true);
    const ids = Object.keys(controller.state.sessions);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toHaveLength(7);
    controller.dispose();
  });

  test('overview projections survive selection moves and invalidate on session data (#288)', async () => {
    const backend = new FakeBackend();
    backend.sessions = ['ses_a', 'ses_b', 'ses_c'].map((id, index) => ({
      ...fakeSession(id),
      updatedAt: index + 1,
    }));
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    controller.openOverview();

    const groups = controller.groups();
    const tabs = controller.tabCounts();
    const rows = controller.overviewRows();
    controller.moveOverviewSelection(1);
    controller.moveOverviewSelection(1);
    expect(controller.groups()).toBe(groups);
    expect(controller.tabCounts()).toBe(tabs);
    expect(controller.overviewRows()).toBe(rows);

    // Connectivity is external evidence, not a store revision: it must still invalidate.
    controller.onStreamStatus('local', 'reconnecting');
    expect(controller.groups()).not.toBe(groups);
    controller.onStreamStatus('local', 'live');
    const reconnected = controller.groups();
    const reconnectedTabs = controller.tabCounts();
    const reconnectedRows = controller.overviewRows();
    expect(controller.groups()).toBe(reconnected);
    expect(controller.tabCounts()).toBe(reconnectedTabs);
    expect(controller.overviewRows()).toBe(reconnectedRows);

    controller.onEvents(
      'local',
      [
        {
          kind: 'usage',
          sessionID: 'ses_a',
          cost: 1.5,
          tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      false,
    );
    expect(controller.groups()).not.toBe(groups);
    expect(controller.tabCounts()).not.toBe(tabs);
    expect(controller.overviewRows()).not.toBe(rows);
    controller.dispose();
  });

  test('overview inputs and bulk teardown invalidate the projections (#316)', async () => {
    const backend = new FakeBackend();
    backend.sessions = ['ses_a', 'ses_b'].map((id, index) => ({
      ...fakeSession(id),
      updatedAt: index + 1,
    }));
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    controller.openOverview();

    const snapshot = () => ({
      groups: controller.groups(),
      tabs: controller.tabCounts(),
      rows: controller.overviewRows(),
    });
    const expectInvalidated = (before: ReturnType<typeof snapshot>) => {
      expect(controller.groups()).not.toBe(before.groups);
      expect(controller.tabCounts()).not.toBe(before.tabs);
      expect(controller.overviewRows()).not.toBe(before.rows);
    };

    let before = snapshot();
    controller.setOverviewTab('active');
    expectInvalidated(before);

    before = snapshot();
    const group = controller.groups()[0];
    if (group !== undefined) {
      controller.toggleOverviewGroup(group.key);
      expectInvalidated(before);
    }

    // A running execution writes `running`, then the deletion performs a bulk produce that
    // tears down many overview inputs at once.
    before = snapshot();
    controller.onEvents(
      'local',
      [{ kind: 'execution', sessionID: 'ses_a', state: 'started' }],
      false,
    );
    expectInvalidated(before);

    before = snapshot();
    controller.onEvents('local', [{ kind: 'session-deleted', sessionID: 'ses_b' }], false);
    expectInvalidated(before);

    before = snapshot();
    controller.openSession('ses_a');
    expectInvalidated(before);

    controller.dispose();
  });

  test('a remote status change invalidates counts even without a store write (#293)', async () => {
    const local = new FakeBackend();
    local.sessions = [fakeSession('ses_a')];
    const remote = new FakeBackend();
    remote.serverID = 'srv_r';
    remote.sessions = [{ ...fakeSession('ses_r'), serverID: 'srv_r' }];
    let online = true;
    const controller = makeController(
      async () => [],
      local,
      () => 10_000,
      {
        serverIDs: () => ['local', 'srv_r'],
        backendFor: (serverID) => (serverID === 'srv_r' ? remote : local),
        serverInfo: (serverID) => (serverID === 'srv_r' ? { label: 'bravo', online } : undefined),
      },
    );
    await controller.bootstrap();
    controller.onEvents(
      'srv_r',
      [{ kind: 'execution', sessionID: 'ses_r', state: 'started' }],
      false,
    );
    expect(controller.tabCounts().active).toBe(1);
    const groups = controller.groups();
    const rows = controller.overviewRows();

    online = false;
    controller.onStreamStatus('srv_r', 'reconnecting');
    expect(controller.groups()).not.toBe(groups);
    expect(controller.overviewRows()).not.toBe(rows);
    // The remote transition changes only external health, not a store field: the reactive
    // clock still has to invalidate the cached classification.
    expect(controller.tabCounts().active).toBe(0);

    online = true;
    controller.onStreamStatus('srv_r', 'live');
    expect(controller.tabCounts().active).toBe(1);
    controller.dispose();
  });

  test('loading more pages preserves the draft and expanded project groups', async () => {
    const backend = new FakeBackend();
    backend.listSessionsHook = onePerPageHook(pagedSessions(6));
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    controller.openOverview();
    controller.setComposer(composerFrom('keep this draft'));

    // Expand the only project group so its hidden sessions render as rows.
    const group = controller.groups()[0];
    expect(group).toBeDefined();
    if (group === undefined) return;
    controller.toggleOverviewGroup(group.key);
    expect(controller.state.overview.expanded[group.key]).toBe(true);

    await controller.loadMoreSessions();

    expect(controller.state.composer.text).toBe('keep this draft');
    expect(controller.state.overview.expanded[group.key]).toBe(true);
    expect(Object.keys(controller.state.sessions)).toHaveLength(6);
    controller.dispose();
  });
});

function userMessage(id: string, text: string): TranscriptMessage {
  return { kind: 'user', id, createdAt: Number(id.slice(1)) || 1, text, attachments: [] };
}

function fakeSession(id: string): SessionSummary {
  return {
    id,
    serverID: 'local',
    projectID: 'p',
    directory: '/work/kohjoh',
    title: `Session ${id}`,
    agent: 'build',
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  };
}

/** v2 may omit `agent` until a switch or the first prompt (#225). */
function agentlessSession(id: string): SessionSummary {
  return {
    id,
    serverID: 'local',
    projectID: 'p',
    directory: '/work/kohjoh',
    title: `Session ${id}`,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  };
}

describe('verified existing-session model switches (#116)', () => {
  const original = { providerID: 'p', modelID: 'original' };
  const first = { providerID: 'p', modelID: 'first' };
  const latest = { providerID: 'p', modelID: 'latest', variant: 'high' };

  test('blocks prompt and compact dispatch while switches serialize', async () => {
    const backend = new FakeBackend();
    backend.sessions = [{ ...fakeSession('ses_a'), model: original }];
    const controller = makeController(async () => [], backend);
    const pause = deferred<void>();
    const apply = backend.switchModel.bind(backend);
    backend.switchModel = async (id, model) => {
      if (model === first) await pause.promise;
      await apply(id, model);
    };
    try {
      await controller.bootstrap();
      controller.openSession('ses_a');
      const switching = controller.setModel(first);
      const switchingAgain = controller.setModel(latest);
      expect(controller.currentSession()?.model).toEqual(original);
      controller.setComposer(composerFrom('/compact'));
      await controller.submit();
      expect(controller.state.composer.text).toBe('/compact');
      controller.setComposer(composerFrom('billable prompt'));
      await controller.submit();
      expect(controller.state.composer.text).toBe('billable prompt');
      expect(
        backend.calls.some(({ name }) =>
          ['switchModel', 'prompt', 'compactSession'].includes(name),
        ),
      ).toBe(false);
      pause.resolve();
      await Promise.all([switching, switchingAgain]);
      expect(
        backend.calls.filter(({ name }) => name === 'switchModel').map(({ args }) => args[1]),
      ).toEqual([first, latest]);
      expect(controller.currentSession()?.model).toEqual(latest);
      await controller.submit();
      expect(backend.calls.filter(({ name }) => name === 'prompt')).toHaveLength(1);
    } finally {
      pause.resolve();
      controller.dispose();
    }
  });

  test.each(['rejected', 'wrong variant'])(
    'keeps the draft and blocks dispatch after a %s switch',
    async (failure) => {
      const backend = new FakeBackend();
      backend.sessions = [{ ...fakeSession('ses_a'), model: original }];
      const controller = makeController(async () => [], backend);
      const apply = backend.switchModel.bind(backend);
      backend.switchModel = async () => {
        if (failure === 'rejected') throw new Error('rejected');
      };
      try {
        await controller.bootstrap();
        controller.openSession('ses_a');
        await controller.setModel(latest);
        expect(controller.currentSession()?.model).toEqual(original);
        expect(await controller.sendToSession('ses_a', 'keep this')).toBe(false);
        expect(controller.state.composer.text).toBe('keep this');
        expect(controller.state.notice?.text).toContain('Select a model again');
        expect(backend.calls.some(({ name }) => name === 'prompt')).toBe(false);
        backend.switchModel = apply;
        await controller.setModel(latest);
        await controller.submit();
        expect(backend.calls.some(({ name }) => name === 'prompt')).toBe(true);
      } finally {
        controller.dispose();
      }
    },
  );
});

function fakeTool(id: string, name: string): ToolCall {
  return { id, name, status: 'completed', input: {}, startedAt: 1, completedAt: 2 };
}

function assistantWithTools(id: string, tools: readonly ToolCall[]): TranscriptMessage {
  return {
    kind: 'assistant',
    id,
    createdAt: 2,
    completedAt: 3,
    agent: 'build',
    model: { providerID: 'opencode', modelID: 'longcat' },
    parts: tools.map((tool) => ({ kind: 'tool' as const, tool })),
  };
}

function groupedTranscript(tools: readonly ToolCall[]): TranscriptMessage {
  return assistantWithTools('m2', tools);
}

const groupFixture = [
  fakeTool('t1', 'read'),
  fakeTool('t2', 'read'),
  fakeTool('t3', 'edit'),
  fakeTool('t4', 'glob'),
  fakeTool('t5', 'glob'),
];

function conversationFixture() {
  const backend = new FakeBackend();
  backend.sessions = [fakeSession('ses_a'), fakeSession('ses_b')];
  backend.messages = {
    ses_a: [groupedTranscript(groupFixture)],
    ses_b: [assistantWithTools('m9', [fakeTool('u1', 'read')])],
  };
  const controller = makeController(() => Promise.resolve([]), backend);
  return { backend, controller };
}

async function attach(controller: AppController, sessionID: string): Promise<void> {
  await controller.bootstrap();
  controller.openSession(sessionID);
  await flush();
}

function fakeEditTool(id: string): ToolCall {
  const lines = ['--- a/f.ts', '+++ b/f.ts', '@@ -1,1 +1,100 @@'];
  lines.push(...Array.from({ length: 100 }, (_, index) => `+row${index}`));
  return {
    id,
    name: 'edit',
    status: 'completed',
    input: { filePath: 'f.ts' },
    startedAt: 1,
    completedAt: 2,
    diff: lines.join('\n'),
  };
}

function conversationWithEdit() {
  const backend = new FakeBackend();
  backend.sessions = [fakeSession('ses_a')];
  backend.messages = {
    ses_a: [
      assistantWithTools('m2', [
        fakeTool('t1', 'read'),
        fakeEditTool('d1'),
        fakeTool('t4', 'glob'),
        fakeTool('t5', 'glob'),
      ]),
    ],
  };
  const controller = makeController(() => Promise.resolve([]), backend);
  return { backend, controller };
}

describe('oversized inline diff focus', () => {
  test('selection walks groups and diff rows in render order; Enter toggles only the diff', async () => {
    const { controller } = conversationWithEdit();
    await attach(controller, 'ses_a');

    expect(controller.collapsibleItems()).toEqual([
      { key: 'group:t1', kind: 'group' },
      { key: 'diff:d1', kind: 'diff' },
      { key: 'group:t4', kind: 'group' },
    ]);

    controller.moveGroupFocus(1);
    expect(controller.state.focusedGroup).toBe('group:t1');
    controller.moveGroupFocus(1);
    expect(controller.state.focusedGroup).toBe('diff:d1');
    controller.moveGroupFocus(1);
    expect(controller.state.focusedGroup).toBe('group:t4');
    controller.moveGroupFocus(-1);
    expect(controller.state.focusedGroup).toBe('diff:d1');

    expect(controller.toggleFocusedGroup()).toBe(true);
    expect(controller.state.expandedDiffs['ses_a d1']).toBe(true);
    expect(controller.state.expandedGroups['ses_a group:t1']).toBeUndefined();
    expect(controller.state.expandedGroups['ses_a group:t4']).toBeUndefined();

    expect(controller.toggleFocusedGroup()).toBe(true);
    expect(controller.state.expandedDiffs['ses_a d1']).toBeUndefined();
    controller.dispose();
  });

  test('Enter routes to the diff toggle when a diff row is selected (composer stays empty)', async () => {
    const { controller } = conversationWithEdit();
    await attach(controller, 'ses_a');

    const services = { openEditor: () => {}, redraw: () => {}, scroll: () => {} };
    const { keymap } = buildKeymap({});
    const ctrlDown = { name: 'down', ctrl: true, alt: false, shift: false };
    routeKey(controller, keymap, ctrlDown, services);
    routeKey(controller, keymap, ctrlDown, services);
    expect(controller.state.focusedGroup).toBe('diff:d1');

    routeKey(
      controller,
      keymap,
      { name: 'return', ctrl: false, alt: false, shift: false },
      services,
    );
    await flush();
    expect(controller.state.expandedDiffs['ses_a d1']).toBe(true);
    expect(controller.state.composer.text).toBe('');

    routeKey(
      controller,
      keymap,
      { name: 'return', ctrl: false, alt: false, shift: false },
      services,
    );
    await flush();
    expect(controller.state.expandedDiffs['ses_a d1']).toBeUndefined();
    controller.dispose();
  });

  test('detailed mode focuses individual tools instead of groups', async () => {
    const { controller } = conversationWithEdit();
    await attach(controller, 'ses_a');
    controller.toggleDetails();
    expect(controller.state.detailed).toBe(true);
    expect(controller.collapsibleItems()).toEqual([
      { key: 'tool:t1', kind: 'tool' },
      { key: 'tool:d1', kind: 'tool' },
      { key: 'tool:t4', kind: 'tool' },
      { key: 'tool:t5', kind: 'tool' },
    ]);
    controller.dispose();
  });
});

function inspectorFixture(overrides: Partial<ControllerDeps> = {}) {
  const backend = new FakeBackend();
  backend.sessions = [fakeSession('ses_a')];
  const preview = Array.from({ length: 600 }, (_, index) => `row${index}`).join('\n');
  const full = `${preview}\nrow600\nrow601`;
  backend.messages = {
    ses_a: [
      assistantWithTools('m1', [
        {
          id: 'b1',
          name: 'bash',
          status: 'completed',
          input: { command: 'make test' },
          output: preview,
          outputTruncated: 'frontend',
          startedAt: 1,
          completedAt: 2,
        },
      ]),
    ],
  };
  backend.toolResults['ses_a:b1'] = { text: full, files: [], completeness: 'complete' };
  const controller = makeController(
    () => Promise.resolve([]),
    backend,
    () => 10_000,
    overrides,
  );
  return { backend, controller, preview, full };
}

describe('output inspector (#221, #222)', () => {
  test('opens the focused tool with cached content, then the complete server result', async () => {
    const { controller, preview, full } = inspectorFixture();
    await attach(controller, 'ses_a');
    controller.moveGroupFocus(1);

    expect(controller.openInspector()).toBe(true);
    const overlay = () => {
      const value = controller.state.overlay;
      if (value.kind !== 'inspector') throw new Error('inspector not open');
      return value;
    };
    expect(overlay().payload?.completeness).toBe('frontend-elided');
    expect(overlay().payload?.text).toBe(preview);
    await flush();
    expect(overlay().loading).toBe(false);
    expect(overlay().payload?.completeness).toBe('complete');
    expect(overlay().payload?.text).toBe(full);
    expect(overlay().error).toBeUndefined();
    controller.dispose();
  });

  test('retrieval failure keeps the preview visible and explains why', async () => {
    const { backend, controller } = inspectorFixture();
    await attach(controller, 'ses_a');
    backend.toolResultError = new BackendError('not-found', 'message.get', 'expired');
    controller.moveGroupFocus(1);
    controller.openInspector();
    await flush();
    const overlay = controller.state.overlay;
    if (overlay.kind !== 'inspector') throw new Error('inspector not open');
    expect(overlay.payload?.completeness).toBe('frontend-elided');
    expect(overlay.error).toContain('expired');
    expect(overlay.error).toContain('retained preview');
    controller.dispose();
  });

  test('search jumps to matches; copy and save report real completeness', async () => {
    const copied: string[] = [];
    const saved: { path: string; text: string }[] = [];
    const { controller, full } = inspectorFixture({
      copyText: async (text) => {
        copied.push(text);
        return { method: 'clipboard' };
      },
      writeFile: async (path, text) => {
        saved.push({ path, text });
      },
    });
    await attach(controller, 'ses_a');
    controller.moveGroupFocus(1);
    controller.openInspector();
    await flush();

    controller.inspectorKey({ name: 'r', ctrl: false, alt: false, shift: false, text: 'row600' });
    const overlay = controller.state.overlay;
    if (overlay.kind !== 'inspector') throw new Error('inspector not open');
    expect(overlay.offset).toBe(600);
    expect(controller.inspectorMatches()).toEqual([600]);
    // Repeated renders reuse the same match array and O(1) membership set (#234).
    expect(controller.inspectorMatches()).toBe(controller.inspectorMatches());
    expect(controller.inspectorMatch(600)).toBe(true);
    expect(controller.inspectorMatch(599)).toBe(false);

    await controller.inspectCopy();
    expect(copied).toEqual([full]);
    expect(controller.state.notice?.text).toContain('complete');

    await controller.inspectSave();
    expect(saved[0]?.text).toBe(full);
    expect(controller.state.notice?.text).toContain('Saved');
    controller.dispose();
  });

  test('windowed view exposes only the requested rows and preserves the offset', async () => {
    const { controller } = inspectorFixture();
    await attach(controller, 'ses_a');
    controller.moveGroupFocus(1);
    controller.openInspector();
    await flush();
    controller.inspectorKey({ name: 'end', ctrl: false, alt: false, shift: false });
    controller.inspectorKey({ name: 'home', ctrl: false, alt: false, shift: false });
    const view = controller.inspectorView(20);
    expect(view.lines).toHaveLength(20);
    expect(view.offset).toBe(0);
    expect(view.total).toBe(602);
    expect(view.lines[0]).toBe('row0');
    controller.dispose();
  });

  test('search keeps literal slashes and edits whole graphemes (#236)', async () => {
    const { controller } = inspectorFixture();
    await attach(controller, 'ses_a');
    controller.moveGroupFocus(1);
    controller.openInspector();
    await flush();
    const overlay = () => {
      const value = controller.state.overlay;
      if (value.kind !== 'inspector') throw new Error('inspector not open');
      return value;
    };
    const key = inspectorKeyEvent;

    // `/` opens the field without inserting or clearing; later slashes are literal.
    controller.inspectorKey(key('slash', '/'));
    expect(overlay().searching).toBe(true);
    expect(overlay().query).toBe('');
    for (const character of 'src/foo/bar')
      controller.inspectorKey(key(character === '/' ? 'slash' : 'letter', character));
    expect(overlay().query).toBe('src/foo/bar');
    expect(overlay().queryCursor).toBe('src/foo/bar'.length);
    expect(overlay().searching).toBe(true);

    // Cursor movement and insertion stay on grapheme boundaries.
    controller.inspectorKey(key('left'));
    controller.inspectorKey(key('left'));
    controller.inspectorKey(key('left'));
    controller.inspectorKey(key('letter', 'X'));
    expect(overlay().query).toBe('src/foo/Xbar');
    expect(overlay().queryCursor).toBe(9);

    // One Backspace removes a joined emoji cluster, leaving no lone surrogate.
    controller.inspectorKey(key('letter', '👩‍💻'));
    expect(overlay().query).toContain('👩‍💻');
    controller.inspectorKey(key('backspace'));
    expect(overlay().query).not.toContain('👩‍💻');
    expect(overlay().query).toBe('src/foo/Xbar');

    // Escape clears the non-empty query; a second Escape closes the inspector.
    controller.inspectorKey(key('escape'));
    expect(overlay().query).toBe('');
    expect(overlay().queryCursor).toBe(0);
    expect(controller.state.overlay.kind).toBe('inspector');
    controller.inspectorKey(key('escape'));
    expect(controller.state.overlay.kind).toBe('none');
    controller.dispose();
  });

  test('Enter and Shift+Enter advance exactly one match (#254)', async () => {
    const { controller } = inspectorFixture();
    await attach(controller, 'ses_a');
    controller.moveGroupFocus(1);
    controller.openInspector();
    await flush();
    const offset = () => {
      const value = controller.state.overlay;
      if (value.kind !== 'inspector') throw new Error('inspector not open');
      return value.offset;
    };
    controller.inspectorKey(inspectorKeyEvent('r', 'row'));
    expect(offset()).toBe(0);
    controller.inspectorKey(inspectorKeyEvent('return'));
    expect(offset()).toBe(1);
    controller.inspectorKey(inspectorKeyEvent('return'));
    expect(offset()).toBe(2);
    controller.inspectorKey({ name: 'return', ctrl: false, alt: false, shift: true });
    expect(offset()).toBe(1);
    controller.dispose();
  });

  test('horizontal scrolling never changes the logical window (#228)', async () => {
    const { controller } = inspectorFixture();
    await attach(controller, 'ses_a');
    controller.moveGroupFocus(1);
    controller.openInspector();
    await flush();
    const overlay = () => {
      const value = controller.state.overlay;
      if (value.kind !== 'inspector') throw new Error('inspector not open');
      return value;
    };
    expect(overlay().column).toBe(0);
    controller.inspectorKey({ name: 'right', ctrl: false, alt: false, shift: false });
    expect(overlay().column).toBe(8);
    controller.inspectorKey({ name: 'right', ctrl: false, alt: false, shift: false });
    expect(overlay().column).toBe(16);
    controller.inspectorKey({ name: 'left', ctrl: false, alt: false, shift: false });
    expect(overlay().column).toBe(8);
    controller.inspectorKey({ name: 'left', ctrl: false, alt: false, shift: false });
    controller.inspectorKey({ name: 'left', ctrl: false, alt: false, shift: false });
    expect(overlay().column).toBe(0);
    expect(controller.inspectorView(20).offset).toBe(0);
    controller.inspectorKey({ name: 'r', ctrl: false, alt: false, shift: false, text: 'row600' });
    expect(controller.inspectorMatches()).toEqual([600]);
    controller.dispose();
  });
});

describe('tool-group focus', () => {
  test('expands only the selected group; other groups stay folded', async () => {
    const { controller } = conversationFixture();
    await attach(controller, 'ses_a');

    controller.moveGroupFocus(1); // first group
    expect(controller.state.focusedGroup).toBe('group:t1');
    expect(controller.toggleFocusedGroup()).toBe(true);

    const groups = controller.toolGroups();
    expect(groups.map((group) => [group.key, group.expanded])).toEqual([
      ['group:t1', true],
      ['group:t4', false],
    ]);

    // An expanded group exposes its tool rows; walk past them to the next group.
    for (let step = 0; step < 8; step += 1) {
      if (controller.state.focusedGroup === 'group:t4') break;
      controller.moveGroupFocus(1);
    }
    expect(controller.state.focusedGroup).toBe('group:t4');
    controller.toggleFocusedGroup();
    for (let step = 0; step < 8; step += 1) {
      if (controller.state.focusedGroup === 'group:t1') break;
      controller.moveGroupFocus(-1);
    }
    expect(controller.state.focusedGroup).toBe('group:t1');
    controller.toggleFocusedGroup();

    const after = controller.toolGroups();
    expect(after.map((group) => [group.key, group.expanded])).toEqual([
      ['group:t1', false],
      ['group:t4', true],
    ]);
    controller.dispose();
  });

  test('individual tool disclosures are qualified by owner and survive group collapse (#281)', async () => {
    const { backend, controller } = conversationFixture();
    backend.messages['ses_b'] = [
      groupedTranscript([fakeTool('t1', 'read'), fakeTool('t2', 'read')]),
    ];
    await attach(controller, 'ses_a');
    controller.moveGroupFocus(1);
    controller.toggleFocusedGroup();
    controller.moveGroupFocus(1);
    expect(controller.state.focusedGroup).toBe('tool:t1');
    controller.toggleFocusedGroup();
    expect(controller.state.expandedTools['ses_a t1']).toBe(true);
    expect(controller.isToolExpanded('t1')).toBe(true);
    expect(controller.isToolExpanded('t2')).toBe(false);

    // Collapsing the group preserves the individual choice for reopening.
    controller.toggleGroup('group:t1');
    expect(controller.toolGroups()[0]?.expanded).toBe(false);
    expect(controller.isToolExpanded('t1')).toBe(true);

    // The same tool ID on another session has no inherited disclosure.
    controller.openSession('ses_b');
    await flush();
    expect(controller.isToolExpanded('t1')).toBe(false);
    controller.openSession('ses_a');
    await flush();
    expect(controller.isToolExpanded('t1')).toBe(true);

    controller.onEvents('local', [{ kind: 'session-deleted', sessionID: 'ses_a' }], false);
    await flush();
    expect(controller.state.expandedTools['ses_a t1']).toBeUndefined();
    controller.dispose();
  });

  test('identical tool IDs on two hosts keep separate disclosures (#281)', async () => {
    const local = new FakeBackend();
    local.sessions = [fakeSession('ses_same')];
    local.messages = {
      ses_same: [groupedTranscript([fakeTool('t1', 'read'), fakeTool('t2', 'read')])],
    };
    const remote = new FakeBackend();
    remote.serverID = 'srv_b';
    remote.sessions = [{ ...fakeSession('ses_same'), serverID: 'srv_b' }];
    remote.messages = {
      ses_same: [groupedTranscript([fakeTool('t1', 'read'), fakeTool('t2', 'read')])],
    };
    const controller = makeController(
      () => Promise.resolve([]),
      local,
      () => 10_000,
      {
        serverIDs: () => ['local', 'srv_b'],
        backendFor: (serverID) => (serverID === 'srv_b' ? remote : local),
      },
    );
    await attach(controller, 'ses_same');
    controller.moveGroupFocus(1);
    controller.toggleFocusedGroup();
    controller.moveGroupFocus(1);
    controller.toggleFocusedGroup();
    expect(controller.isToolExpanded('t1')).toBe(true);

    controller.openSession('ses_same', 'srv_b');
    await flush();
    expect(controller.isToolExpanded('t1')).toBe(false);
    controller.moveGroupFocus(1);
    controller.toggleFocusedGroup();
    controller.moveGroupFocus(1);
    controller.toggleFocusedGroup();
    expect(controller.isToolExpanded('t1')).toBe(true);

    controller.openSession('ses_same', 'local');
    await flush();
    expect(controller.isToolExpanded('t1')).toBe(true);
    const remoteKey = sessionKey({ serverID: 'srv_b', sessionID: 'ses_same' });
    expect(controller.state.expandedTools[`${remoteKey} t1`]).toBe(true);
    expect(controller.state.expandedTools['ses_same t1']).toBe(true);
    controller.dispose();
  });

  test('expansion persists per session while transcripts stay cached', async () => {
    const { controller } = conversationFixture();
    await attach(controller, 'ses_a');
    controller.moveGroupFocus(1);
    controller.toggleFocusedGroup();
    expect(controller.state.expandedGroups['ses_a group:t1']).toBe(true);

    controller.openSession('ses_b');
    await flush();
    expect(controller.state.route).toEqual({
      kind: 'conversation',
      serverID: 'local',
      sessionID: 'ses_b',
    });

    controller.openSession('ses_a');
    await flush();
    const group = controller.toolGroups().find((entry) => entry.key === 'group:t1');
    expect(group?.expanded).toBe(true);
    controller.dispose();
  });

  test('a retained byte budget evicts inactive transcripts, never the active one (#289)', async () => {
    const backend = new FakeBackend();
    backend.sessions = ['ses_a', 'ses_b', 'ses_c'].map(fakeSession);
    const largeOutput = 'x'.repeat(20_000);
    const transcript = (id: string): TranscriptMessage[] => [
      {
        kind: 'user',
        id: `${id}-u1`,
        createdAt: 1,
        text: `request ${id}`,
        attachments: [],
      },
      {
        kind: 'assistant',
        id: `${id}-a1`,
        createdAt: 2,
        completedAt: 3,
        agent: 'build',
        model: { providerID: 'opencode', modelID: 'longcat' },
        parts: [
          {
            kind: 'tool',
            tool: {
              id: `${id}-t1`,
              name: 'read',
              status: 'completed',
              input: { filePath: 'src/a.ts' },
              output: largeOutput,
              startedAt: 2,
              completedAt: 3,
            },
          },
        ],
      },
    ];
    backend.messages = {
      ses_a: transcript('a'),
      ses_b: transcript('b'),
      ses_c: transcript('c'),
    };
    const controller = makeController(
      async () => [],
      backend,
      () => 10_000,
      {
        transcriptCacheBytes: 1_000,
      },
    );
    await controller.bootstrap();

    controller.openSession('ses_a');
    await flush();
    controller.openSession('ses_b');
    await flush();
    expect(controller.state.transcripts['ses_b']).toBeDefined();
    expect(controller.state.transcripts['ses_a']).toBeUndefined();

    // The active transcript is over budget all by itself and must stay resident.
    controller.openSession('ses_a');
    await flush();
    expect(controller.state.transcripts['ses_a']?.messages).toHaveLength(2);
    expect(controller.state.transcripts['ses_b']).toBeUndefined();
    expect(controller.state.sessions['ses_b']).toBeDefined();

    // Deletion drops the retained cache completely; the summary is gone too.
    backend.sessions = backend.sessions.filter((session) => session.id !== 'ses_a');
    controller.onEvents('local', [{ kind: 'session-deleted', sessionID: 'ses_a' }], false);
    expect(controller.state.transcripts['ses_a']).toBeUndefined();
    expect(controller.state.sessions['ses_a']).toBeUndefined();
    controller.dispose();
  });

  test('streamed tools keep the focused group identity; typing clears it', async () => {
    const { backend, controller } = conversationFixture();
    await attach(controller, 'ses_a');
    controller.moveGroupFocus(1);
    expect(controller.state.focusedGroup).toBe('group:t1');

    // The stream folds another tool into the same group: first-tool key stays stable.
    backend.messages['ses_a'] = [groupedTranscript([...groupFixture, fakeTool('t6', 'read')])];
    controller.onEvents('local', [], true); // same resync path events take in production
    await flush();
    expect(controller.state.focusedGroup).toBe('group:t1');

    controller.toggleFocusedGroup();
    const group = controller.toolGroups().find((entry) => entry.key === 'group:t1');
    expect(group?.expanded).toBe(true);
    expect(group?.tools.map((tool) => tool.id)).toEqual(['t1', 't2']);
    const streamed = controller.toolGroups().find((entry) => entry.key === 'group:t4');
    expect(streamed?.tools.map((tool) => tool.id)).toEqual(['t4', 't5', 't6']);

    // Typing hands focus back to the composer.
    controller.setComposer(composerFrom('h'));
    expect(controller.state.focusedGroup).toBeUndefined();
    controller.dispose();
  });

  test('Enter on an empty prompt toggles the focused group instead of submitting', async () => {
    const { controller } = conversationFixture();
    await attach(controller, 'ses_a');
    controller.moveGroupFocus(1);

    const { keymap } = buildKeymap({});
    const services = { openEditor: () => {}, redraw: () => {}, scroll: () => {} };
    const enter = { name: 'return', ctrl: false, alt: false, shift: false };
    const consumed = routeKey(controller, keymap, enter, services);

    expect(consumed).toBe(true);
    expect(controller.state.expandedGroups['ses_a group:t1']).toBe(true);
    expect(controller.state.composer.text).toBe(''); // not submitted / not stashed

    // Escape clears the selection again.
    routeKey(
      controller,
      keymap,
      { name: 'escape', ctrl: false, alt: false, shift: false },
      services,
    );
    expect(controller.state.focusedGroup).toBeUndefined();
    controller.dispose();
  });

  test('Ctrl+Up/Down select groups without touching the composer', async () => {
    const { controller } = conversationFixture();
    await attach(controller, 'ses_a');
    controller.setComposer(composerFrom('draft stays'));

    const { keymap } = buildKeymap({});
    const services = { openEditor: () => {}, redraw: () => {}, scroll: () => {} };
    routeKey(controller, keymap, { name: 'down', ctrl: true, alt: false, shift: false }, services);
    expect(controller.state.focusedGroup).toBe('group:t1');
    expect(controller.state.composer.text).toBe('draft stays');

    routeKey(controller, keymap, { name: 'down', ctrl: true, alt: false, shift: false }, services);
    expect(controller.state.focusedGroup).toBe('group:t4');
    controller.dispose();
  });
});

describe('prompt history across project switches (issue #4)', () => {
  test('A -> B -> A keeps prompts recorded earlier in the same process', async () => {
    const backend = new FakeBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();

    const id = await controller.createSessionWithPrompt(
      { serverID: 'local', directory: '/work/kohjoh' },
      'prompt recorded in A',
    );
    expect(id).toBeDefined();
    expect(controller.historyUp()).toBe(true);
    expect(controller.state.composer.text).toBe('prompt recorded in A');
    controller.setComposer(composerFrom(''));

    controller.startNewSession('/elsewhere');
    expect(controller.historyUp()).toBe(false);

    controller.startNewSession('/work/kohjoh');
    controller.historyUp();
    expect(controller.state.composer.text).toBe('prompt recorded in A');
    controller.dispose();
  });

  test('a fresh controller restores the saved snapshot after a recorded prompt', async () => {
    const saved: { value?: LocalState } = {};
    const make = (localState: LocalState) =>
      new AppController({
        backend: new FakeBackend(),
        config: defaultConfig,
        localState,
        platform: 'linux',
        cwd: '/work/kohjoh',
        version: '0.0.1',
        now: () => 10_000,
        saveLocalState: async (state) => {
          saved.value = state;
        },
        listFiles: () => Promise.resolve([]),
        requestExit: () => {},
      });

    const first = make(emptyState);
    await first.createSessionWithPrompt(
      { serverID: 'local', directory: '/work/kohjoh' },
      'persisted prompt',
    );
    expect(saved.value?.history['/work/kohjoh']).toEqual(['persisted prompt']);
    first.dispose();

    const second = make(saved.value ?? emptyState);
    second.historyUp();
    expect(second.state.composer.text).toBe('persisted prompt');
    second.dispose();
  });
});

describe('createSession does not steal focus or mutate another draft (issue #113)', () => {
  test('a delayed createSession leaves the navigated-to route foreground and unchanged', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    const created = deferred<SessionSummary>();
    backend.createSessionHook = () => created.promise;
    const controller = makeController(() => Promise.resolve([]), backend);
    try {
      await controller.bootstrap();
      controller.openOverview();
      controller.attachImage(pngBytes, 'image/png', 'shot.png');

      const promise = controller.createSessionWithPrompt(
        { serverID: 'local', directory: '/work/kohjoh' },
        'B prompt',
      );

      controller.openSession('ses_a');
      await flush();
      controller.setComposer(composerFrom('B prompt'));
      controller.attachImage(pngBytes, 'image/png', 'a.png');
      await flush();

      created.resolve({ ...fakeSession('ses_b'), directory: '/work/kohjoh' });
      await promise;

      expect(controller.state.route).toEqual({
        kind: 'conversation',
        serverID: 'local',
        sessionID: 'ses_a',
      });
      expect(controller.state.composer.text).toBe('B prompt');
      expect(controller.state.attachments.map((attachment) => attachment.name)).toEqual(['a.png']);

      const prompts = backend.calls.filter((call) => call.name === 'prompt');
      expect(prompts).toHaveLength(1);
      const [prompt] = prompts;
      expect(prompt).toBeDefined();
      expect(prompt!.args[0]).toBe('ses_b');
      const draft = prompt!.args[1];
      if (!isPromptDraft(draft)) throw new Error('prompt missing');
      expect(draft.text).toBe('B prompt');
      expect(draft.files.map((file) => file.name)).toEqual(['shot.png']);
    } finally {
      controller.dispose();
    }
  });

  test('prompt rejection parks the prompt in the new session draft and leaves the current route alone', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.promptError = new Error('server unreachable');
    const created = deferred<SessionSummary>();
    backend.createSessionHook = () => created.promise;
    const controller = makeController(() => Promise.resolve([]), backend);
    try {
      await controller.bootstrap();
      controller.openOverview();
      controller.attachImage(pngBytes, 'image/png', 'shot.png');

      const promise = controller.createSessionWithPrompt(
        { serverID: 'local', directory: '/work/kohjoh' },
        'B prompt',
      );

      controller.openSession('ses_a');
      await flush();
      controller.setComposer(composerFrom('A draft'));
      await flush();

      created.resolve({ ...fakeSession('ses_b'), directory: '/work/kohjoh' });
      await promise;

      expect(controller.state.route).toEqual({
        kind: 'conversation',
        serverID: 'local',
        sessionID: 'ses_a',
      });
      expect(controller.state.composer.text).toBe('A draft');
      expect(controller.state.attachments).toEqual([]);
      expect((controller.state.drafts['ses_b'] ?? {}).text).toBe('B prompt');
      expect(
        (controller.state.draftAttachments['ses_b'] ?? []).map((attachment) => attachment.name),
      ).toEqual(['shot.png']);
      expect(controller.state.notice?.text).toContain('was created but the prompt was not sent');
      expect(controller.state.notice?.tone).toBe('error');
    } finally {
      controller.dispose();
    }
  });
});

describe('openOverview preserves the originating project (issue #106)', () => {
  test('keeps the originating project when the active tab excludes its sessions', async () => {
    const { controller } = multiServerController();
    try {
      await controller.bootstrap();

      // Viewing a remote idle session.
      controller.openSession('ses_remote', 'srv_1');
      await flush();
      expect(controller.state.route.kind).toBe('conversation');

      // Open the overview: the originating (remote) project becomes the composer target.
      controller.openOverview();
      expect(controller.state.overview.project).toEqual({
        serverID: 'srv_1',
        directory: '/remote/proj',
      });
      expect(controller.state.overview.selectedRow).toBeDefined();

      // Switch to the "active" tab: the remote idle session falls out of the list,
      // leaving only the local active session.
      controller.setOverviewTab('active');
      const rows = controller.overviewRows();
      expect(rows.some((row) => row.kind === 'session')).toBe(true);
      expect(rows.every((row) => row.kind !== 'session' || row.session.serverID !== 'srv_1')).toBe(
        true,
      );

      // Return to overview: the remote project must remain the composer target and
      // nothing unrelated may be selected.
      controller.openOverview();
      expect(controller.state.overview.project).toEqual({
        serverID: 'srv_1',
        directory: '/remote/proj',
      });
      expect(controller.state.overview.focus).toBe('composer');
      expect(controller.state.overview.selectedRow).toBeUndefined();
    } finally {
      controller.dispose();
    }
  });

  test('submitting a prompt creates the session on the original host/directory, not rows[0]', async () => {
    const { controller, local, remote } = multiServerController();
    try {
      await controller.bootstrap();
      controller.openSession('ses_remote', 'srv_1');
      await flush();
      controller.openOverview();
      controller.setOverviewTab('active');
      controller.openOverview();

      // The composer is focused on the preserved originating project.
      expect(controller.state.overview.project).toEqual({
        serverID: 'srv_1',
        directory: '/remote/proj',
      });

      controller.setComposer(composerFrom('build the thing'));
      await controller.submit();

      const creations = remote.calls.filter((call) => call.name === 'createSession');
      expect(creations).toHaveLength(1);
      expect(creations[0]!.args[0]).toEqual({ directory: '/remote/proj' });
      // No session was created on the local host (the rows[0] fallback target).
      expect(local.calls.filter((call) => call.name === 'createSession')).toHaveLength(0);
    } finally {
      controller.dispose();
    }
  });
});

describe('overview selection reloads project-scoped history (issue #107)', () => {
  test("switching the overview selection reloads the selected project's history", async () => {
    const backend = new FakeBackend();
    backend.sessions = [
      { ...fakeSession('ses_a'), directory: '/proj-a' },
      { ...fakeSession('ses_b'), directory: '/proj-b' },
    ];
    const { controller } = historyController(
      { ...emptyState, history: { '/proj-a': ['A prompt'], '/proj-b': ['B prompt'] } },
      backend,
    );
    try {
      await controller.bootstrap();
      controller.openOverview();

      selectRowForDirectory(controller, '/proj-a');
      expect(controller.state.history.entries).toEqual(['A prompt']);
      expect(controller.state.history.index).toBeUndefined();

      selectRowForDirectory(controller, '/proj-b');
      expect(controller.state.history.entries).toEqual(['B prompt']);
      expect(controller.state.history.index).toBeUndefined();
      expect(controller.historyUp()).toBe(true);
      expect(controller.state.composer.text).toBe('B prompt');

      // Returning to A still recalls A; neither switch clobbers the other project's entries.
      selectRowForDirectory(controller, '/proj-a');
      expect(controller.state.history.entries).toEqual(['A prompt']);
      expect(controller.historyUp()).toBe(true);
      expect(controller.state.composer.text).toBe('A prompt');
    } finally {
      controller.dispose();
    }
  });

  test("sending a prompt persists only to the target project's bucket, not another project's", async () => {
    const backend = new FakeBackend();
    backend.sessions = [
      { ...fakeSession('ses_a'), directory: '/proj-a' },
      { ...fakeSession('ses_b'), directory: '/proj-b' },
    ];
    const { controller, saved } = historyController(
      { ...emptyState, history: { '/proj-a': ['A prompt'], '/proj-b': ['B prompt'] } },
      backend,
    );
    try {
      await controller.bootstrap();
      controller.openOverview();

      // Select B so its history is in memory, then send a prompt from B.
      selectRowForDirectory(controller, '/proj-b');
      expect(controller.state.history.entries).toEqual(['B prompt']);

      await controller.createSessionWithPrompt(
        { serverID: 'local', directory: '/proj-b' },
        'new B',
      );
      await flush();

      expect(saved.value?.history['/proj-b']).toEqual(['B prompt', 'new B']);
      expect(saved.value?.history['/proj-a']).toEqual(['A prompt']);
    } finally {
      controller.dispose();
    }
  });
});

describe('late prompt admission cannot retarget visible history (#160)', () => {
  test('a held send from A never repaints B, but still persists to A', async () => {
    const backend = new FakeBackend();
    backend.sessions = [
      { ...fakeSession('ses_a'), directory: '/proj-a' },
      { ...fakeSession('ses_b'), directory: '/proj-b' },
    ];
    const { controller, saved } = historyController(
      { ...emptyState, history: { '/proj-a': ['A prompt'], '/proj-b': ['B prompt'] } },
      backend,
    );
    const held = deferred<void>();
    const prompt = backend.prompt.bind(backend);
    backend.prompt = async (...args: Parameters<typeof backend.prompt>) => {
      await held.promise;
      return prompt(...args);
    };
    try {
      await controller.bootstrap();
      controller.openSession('ses_a');
      expect(controller.state.history.entries).toEqual(['A prompt']);
      controller.setComposer(composerFrom('late A'));
      const sending = controller.submit();
      await flush();

      // Navigate to B while A's server response is still in flight.
      controller.openOverview();
      selectRowForDirectory(controller, '/proj-b');
      expect(controller.state.history.entries).toEqual(['B prompt']);

      held.resolve();
      await sending;
      await flush();

      expect(controller.state.history.entries).toEqual(['B prompt']);
      expect(saved.value?.history['/proj-a']).toEqual(['A prompt', 'late A']);
      expect(saved.value?.history['/proj-b']).toEqual(['B prompt']);

      // Returning to A exposes its new entry; browsing B still agrees with its own bucket.
      selectRowForDirectory(controller, '/proj-a');
      expect(controller.state.history.entries).toEqual(['A prompt', 'late A']);
      expect(controller.historyUp()).toBe(true);
      expect(controller.state.composer.text).toBe('late A');
    } finally {
      controller.dispose();
    }
  });
});

describe('post-acknowledgment local failures (#334)', () => {
  test('a failing diagnostic sink never resends or reports the accepted prompt as failed', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    const controller = makeController(
      async () => [],
      backend,
      () => 10_000,
      {
        debugLog: {
          enabled: true,
          write(kind) {
            if (kind === 'action') throw new Error('logger is down');
          },
          close() {},
        },
      },
    );
    await attach(controller, 'ses_a');
    controller.setComposer(composerFrom('a prompt never sent twice'));

    await controller.submit();
    await flush();

    expect(backend.calls.filter((call) => call.name === 'prompt')).toHaveLength(1);
    expect(controller.state.composer.text).toBe('');
    expect(controller.state.notice?.text).toContain('prompt was sent');
    expect(controller.state.notice?.text).not.toContain('a prompt never sent twice');
    controller.dispose();
  });
});

describe('createSession scopes agent/model to the target project (issue #108)', () => {
  test("switching hosts resets defaults and never carries another host's agent/model into createSession", async () => {
    const { controller, backendA, backendB, agentA, modelA, modelB } = catalogController();
    try {
      await controller.bootstrap();
      controller.openOverview();

      // Choose host A's agent/model while viewing its project, then switch to host B.
      selectRowForDirectory(controller, '/proj-a');
      await controller.loadCatalog('/proj-a', 'local');
      controller.setNewSessionDefaults(agentA.id, modelA);
      expect(controller.state.overview.agent).toBe('agent-a');
      expect(controller.state.overview.model).toEqual(modelA);

      selectRowForDirectory(controller, '/proj-b');
      // Switching hosts resets new-session defaults to the server default.
      expect(controller.state.overview.agent).toBeUndefined();
      expect(controller.state.overview.model).toBeUndefined();

      await controller.createSessionWithPrompt(
        { serverID: 'srv_1', directory: '/proj-b' },
        'prompt',
      );
      await flush();

      const bCreate = backendB.calls.filter((call) => call.name === 'createSession');
      expect(bCreate).toHaveLength(1);
      // B-specific request: B's directory and default model, never A's agent-a/model-a.
      expect(bCreate[0]!.args[0]).toEqual({ directory: '/proj-b', model: modelB });
      expect(backendA.calls.filter((call) => call.name === 'createSession')).toHaveLength(0);
    } finally {
      controller.dispose();
    }
  });

  test('same-host different-directory projects keep agent/model separate', async () => {
    const { controller, backendA, agentA, modelA, modelC } = catalogController();
    try {
      await controller.bootstrap();
      controller.openOverview();

      selectRowForDirectory(controller, '/proj-a');
      await controller.loadCatalog('/proj-a', 'local');
      controller.setNewSessionDefaults(agentA.id, modelA);
      expect(controller.state.overview.agent).toBe('agent-a');

      selectRowForDirectory(controller, '/proj-c');
      // Another directory on the same host also resets the defaults.
      expect(controller.state.overview.agent).toBeUndefined();
      expect(controller.state.overview.model).toBeUndefined();

      await controller.createSessionWithPrompt(
        { serverID: 'local', directory: '/proj-c' },
        'prompt',
      );
      await flush();

      const cCreate = backendA.calls.filter((call) => call.name === 'createSession');
      expect(cCreate).toHaveLength(1);
      expect(cCreate[0]!.args[0]).toEqual({ directory: '/proj-c', model: modelC });
      // Host A's agent-a never leaks into /proj-c's create request.
      expect(cCreate[0]!.args[0]).not.toHaveProperty('agent', agentA.id);
    } finally {
      controller.dispose();
    }
  });

  test('a selected model from another host fails closed instead of charging the default', async () => {
    const { controller, backendA, modelB } = catalogController();
    try {
      await controller.bootstrap();
      controller.openOverview();

      selectRowForDirectory(controller, '/proj-a');
      await controller.loadCatalog('/proj-a', 'local');
      controller.setNewSessionDefaults(undefined, modelB);
      expect(controller.state.overview.model).toEqual(modelB);

      expect(
        await controller.createSessionWithPrompt(
          { serverID: 'local', directory: '/proj-a' },
          'prompt',
        ),
      ).toBeUndefined();

      expect(backendA.calls.some((call) => call.name === 'createSession')).toBe(false);
      expect(backendA.calls.some((call) => call.name === 'prompt')).toBe(false);
      expect(controller.state.notice?.text).toContain('No prompt sent');
    } finally {
      controller.dispose();
    }
  });

  test('Alt+P then Alt+E pins a local model variant instead of silently using GPT Terra', async () => {
    const backend = new FakeBackend();
    backend.models = [
      {
        providerID: 'p',
        modelID: 'model-a',
        name: 'model-a',
        enabled: true,
        variants: ['high', 'low'],
      },
    ];
    backend.defaultModel = async () => ({ providerID: 'p', modelID: 'gpt-terra' });
    const controller = makeController(() => Promise.resolve([]), backend);
    try {
      await controller.bootstrap();
      controller.openOverview();
      // The model picker has one row per model; effort is selected separately (#165).
      expect(controller.modelChoices('model-a')).toHaveLength(1);
      await controller.openModelPicker();
      controller.setModelPickerQuery('model-a');
      await controller.acceptModelPicker();
      expect(controller.state.overview.model).toEqual({ providerID: 'p', modelID: 'model-a' });
      await controller.openEffortPicker();
      expect(controller.effortChoices('').map((choice) => choice.variant)).toEqual([
        undefined,
        'high',
        'low',
      ]);
      controller.setEffortPickerQuery('high');
      await controller.acceptEffortPicker();
      const chosen = { providerID: 'p', modelID: 'model-a', variant: 'high' };
      expect(controller.state.overview.model).toEqual(chosen);

      const id = await controller.createSessionWithPrompt(
        { serverID: 'local', directory: '/work/kohjoh' },
        'prompt',
      );
      expect(id).toBeDefined();
      expect(backend.calls.filter((call) => call.name === 'createSession')[0]?.args[0]).toEqual({
        directory: '/work/kohjoh',
        model: chosen,
      });
      expect(backend.sessions.find((session) => session.id === id)?.model).toEqual(chosen);
      expect(backend.calls.filter((call) => call.name === 'prompt')).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  test('model picker lists one sorted, provider-grouped row per model (#165, #166)', async () => {
    const backend = new FakeBackend();
    backend.models = [
      {
        providerID: 'opencode',
        modelID: 'gpt-6.1-terra',
        name: 'GPT Terra',
        enabled: true,
        variants: ['high', 'low'],
      },
      {
        providerID: 'openai',
        modelID: 'gpt-6.9-sol',
        name: 'Sol',
        enabled: true,
        variants: ['high'],
      },
      {
        providerID: 'openai',
        modelID: 'gpt-6.10-sol',
        name: 'Sol',
        enabled: true,
        variants: ['high'],
      },
      {
        providerID: 'openai',
        modelID: 'gpt-6.2-astra',
        name: 'Astra',
        enabled: true,
        variants: [],
      },
    ];
    const controller = makeController(() => Promise.resolve([]), backend);
    try {
      await controller.bootstrap();
      controller.openOverview();
      expect(controller.modelChoices('')).toEqual([
        { providerID: 'openai', modelID: 'gpt-6.10-sol' },
        { providerID: 'openai', modelID: 'gpt-6.9-sol' },
        { providerID: 'openai', modelID: 'gpt-6.2-astra' },
        { providerID: 'opencode', modelID: 'gpt-6.1-terra' },
      ]);
      // Filtering still finds models across groups and never drops a valid row.
      expect(controller.modelChoices('gpt-6.9')).toEqual([
        { providerID: 'openai', modelID: 'gpt-6.9-sol' },
      ]);
    } finally {
      controller.dispose();
    }
  });

  test('effort picker is scoped to the effective model and handles zero variants (#165)', async () => {
    const backend = new FakeBackend();
    backend.models = [
      { providerID: 'p', modelID: 'with', name: 'with', enabled: true, variants: ['low', 'high'] },
      { providerID: 'p', modelID: 'without', name: 'without', enabled: true, variants: [] },
    ];
    backend.defaultModel = async () => ({ providerID: 'p', modelID: 'with' });
    const controller = makeController(() => Promise.resolve([]), backend);
    try {
      await controller.bootstrap();
      controller.openOverview();
      controller.setComposer(composerFrom('/effort'));
      await controller.submit();
      expect(controller.state.overlay.kind).toBe('effort-picker');
      expect(controller.effortChoices('').map((choice) => choice.variant)).toEqual([
        undefined,
        'low',
        'high',
      ]);
      controller.closeOverlay();

      await controller.setModel({ providerID: 'p', modelID: 'without' });
      expect(controller.effortChoices('')).toEqual([
        { label: 'default (no override)', variant: undefined },
      ]);
    } finally {
      controller.dispose();
    }
  });

  test('changing model drops a variant unsupported by the new model (#165)', async () => {
    const backend = new FakeBackend();
    backend.models = [
      { providerID: 'p', modelID: 'a', name: 'a', enabled: true, variants: ['high'] },
      { providerID: 'p', modelID: 'b', name: 'b', enabled: true, variants: ['low'] },
    ];
    const controller = makeController(() => Promise.resolve([]), backend);
    try {
      await controller.bootstrap();
      controller.openOverview();
      await controller.setModel({ providerID: 'p', modelID: 'a', variant: 'high' });
      await controller.setModel({ providerID: 'p', modelID: 'b', variant: 'high' });
      expect(controller.state.overview.model).toEqual({ providerID: 'p', modelID: 'b' });
      expect(controller.state.notice?.text).toContain('server default');
    } finally {
      controller.dispose();
    }
  });

  test('/model pins a remote model variant on the owning server, not its default', async () => {
    const { controller, backendA, backendB, modelB } = catalogController();
    backendB.listModels = async (directory?: string) =>
      directory === '/proj-b' ? [{ ...modelB, variants: ['high'] }] : [];
    try {
      await controller.bootstrap();
      controller.openOverview();
      selectRowForDirectory(controller, '/proj-b');
      await controller.loadCatalog('/proj-b', 'srv_1');

      controller.setComposer(composerFrom('/model p/model-b#high'));
      await controller.submit();
      const chosen = { providerID: 'p', modelID: 'model-b', variant: 'high' };
      expect(controller.state.overview.model).toEqual(chosen);

      const id = await controller.createSessionWithPrompt(
        { serverID: 'srv_1', directory: '/proj-b' },
        'prompt',
      );
      expect(id).toBeDefined();
      expect(backendB.calls.filter((call) => call.name === 'createSession')[0]?.args[0]).toEqual({
        directory: '/proj-b',
        model: chosen,
      });
      expect(backendB.sessions.find((session) => session.id === id)?.model).toEqual(chosen);
      expect(backendB.calls.filter((call) => call.name === 'prompt')).toHaveLength(1);
      expect(backendA.calls.some((call) => call.name === 'createSession')).toBe(false);
    } finally {
      controller.dispose();
    }
  });

  test('invalid variant is rejected without creating a billable session', async () => {
    const { controller, backendA } = catalogController();
    try {
      await controller.bootstrap();
      controller.openOverview();
      selectRowForDirectory(controller, '/proj-a');
      await controller.loadCatalog('/proj-a', 'local');
      controller.setNewSessionDefaults(undefined, {
        providerID: 'p',
        modelID: 'model-a',
        variant: 'nonexistent',
      });

      expect(
        await controller.createSessionWithPrompt(
          { serverID: 'local', directory: '/proj-a' },
          'prompt',
        ),
      ).toBeUndefined();
      expect(backendA.calls.some((call) => call.name === 'createSession')).toBe(false);
      expect(backendA.calls.some((call) => call.name === 'prompt')).toBe(false);
    } finally {
      controller.dispose();
    }
  });

  test('server ignoring an explicit model switch never receives a first prompt', async () => {
    const backend = new FakeBackend();
    backend.models = [
      {
        providerID: 'p',
        modelID: 'model-a',
        name: 'model-a',
        enabled: true,
        variants: [],
      },
    ];
    backend.defaultModel = async () => ({ providerID: 'p', modelID: 'gpt-terra' });
    const wrongModel = { providerID: 'p', modelID: 'gpt-terra' };
    backend.createSessionHook = async (args) => {
      const session = { ...fakeSession('ses_wrong'), directory: args.directory, model: wrongModel };
      backend.sessions.push(session);
      return session;
    };
    backend.switchModel = async () => {}; // Server acknowledges but ignores the switch.
    const controller = makeController(() => Promise.resolve([]), backend);
    try {
      await controller.bootstrap();
      controller.openOverview();
      controller.setNewSessionDefaults(undefined, { providerID: 'p', modelID: 'model-a' });

      const id = await controller.createSessionWithPrompt(
        { serverID: 'local', directory: '/work/kohjoh' },
        'unsent prompt',
      );
      expect(id).toBe('ses_wrong');
      expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
      expect(controller.state.notice?.text).toContain('Prompt not sent');
    } finally {
      controller.dispose();
    }
  });
});

describe('conversation footer derives stream/stale status from the viewed host (issue #109)', () => {
  test('execution and stale status reflect the viewed host, not the launch server', async () => {
    const { controller } = twoHostController();
    try {
      await controller.bootstrap();
      controller.onStreamStatus('local', 'live');
      controller.onStreamStatus('srv_1', 'reconnecting');

      // Remote conversation on B reads stale/reconnecting even though launch is live.
      controller.openSession('ses_b', 'srv_1');
      const bView = controller.currentView();
      expect(bView).toBeDefined();
      if (bView === undefined) return;
      expect(bView.serverID).toBe('srv_1');
      expect(bView.stream).toBe('reconnecting');
      expect(bView.execution).toEqual({ state: 'unknown', reason: 'disconnected' });

      // Launch host conversation stays fresh.
      controller.openSession('ses_a', 'local');
      const aView = controller.currentView();
      expect(aView).toBeDefined();
      if (aView === undefined) return;
      expect(aView.serverID).toBe('local');
      expect(aView.stream).toBe('live');
      expect(aView.execution).toEqual({ state: 'idle' });

      // When B reconnects, its footer becomes live without A's stream changing.
      controller.onStreamStatus('srv_1', 'live');
      controller.openSession('ses_b', 'srv_1');
      expect(controller.currentView()?.stream).toBe('live');
      expect(controller.currentView()?.execution).toEqual({ state: 'idle' });
    } finally {
      controller.dispose();
    }
  });

  test('identical session IDs on different hosts keep separate footer health', async () => {
    const { controller } = twoHostController();
    try {
      await controller.bootstrap();
      controller.onStreamStatus('local', 'live');
      controller.onStreamStatus('srv_1', 'reconnecting');

      // Both hosts own a session literally named 'ses_same'.
      controller.openSession('ses_same', 'srv_1');
      expect(controller.currentView()?.stream).toBe('reconnecting');
      expect(controller.currentView()?.execution).toEqual({
        state: 'unknown',
        reason: 'disconnected',
      });

      controller.openSession('ses_same', 'local');
      expect(controller.currentView()?.stream).toBe('live');
      expect(controller.currentView()?.execution).toEqual({ state: 'idle' });
    } finally {
      controller.dispose();
    }
  });
});

async function submitCommand(controller: AppController, text: string): Promise<void> {
  controller.setComposer(composerFrom(text));
  await controller.submit();
}

function activeGoal(id: string): NativeGoal {
  return { id, objective: id, status: 'active', rounds: 1, maxRounds: 5 };
}

async function goalFixture(objective = 'Ship the native goal') {
  const backend = new FakeBackend();
  backend.sessions = [fakeSession('ses_a')];
  backend.messages = { ses_a: [] };
  backend.goals = {
    ses_a: {
      id: 'goal_1',
      objective,
      status: 'active',
      rounds: 3,
      maxRounds: 50,
    },
  };
  // The plugin registers the goal command in the server catalog once enabled.
  backend.serverCommands = [{ name: 'goal', description: 'Set the session goal' }];
  const controller = makeController(() => Promise.resolve([]), backend);
  await attach(controller, 'ses_a');
  return { backend, controller };
}

describe('native opencode goal (issue #21)', () => {
  test('/goal sets a native goal through the server command, not a local one', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [] };
    // The plugin registers the goal command in the server catalog.
    backend.serverCommands = [{ name: 'goal', description: 'Set the session goal' }];
    const controller = makeController(() => Promise.resolve([]), backend);
    await attach(controller, 'ses_a');

    await submitCommand(controller, '/goal Hit 30 FPS');
    const commands = backend.calls.filter((call) => call.name === 'runCommand');
    expect(commands).toContainEqual({ name: 'runCommand', args: ['ses_a', 'goal', 'Hit 30 FPS'] });
    expect(backend.goals['ses_a']?.objective).toBe('Hit 30 FPS');
    expect(controller.nativeGoalOf('ses_a')?.objective).toBe('Hit 30 FPS');
    expect(controller.state.goals['ses_a']).toBeUndefined();
    controller.dispose();
  });

  test('hydrates the native goal on attach and tracks it in state', async () => {
    const { controller } = await goalFixture();
    expect(controller.nativeGoalOf('ses_a')).toMatchObject({
      objective: 'Ship the native goal',
      status: 'active',
      rounds: 3,
    });
    controller.dispose();
  });

  test('a goal.changed event replaces the tracked native goal', async () => {
    const { controller } = await goalFixture();
    controller.onEvents(
      'local',
      [
        {
          kind: 'goal-changed',
          sessionID: 'ses_a',
          goal: {
            id: 'goal_1',
            objective: 'Ship the native goal',
            status: 'complete',
            rounds: 7,
            maxRounds: 50,
          },
        },
      ],
      false,
    );
    expect(controller.nativeGoalOf('ses_a')).toMatchObject({ status: 'complete', rounds: 7 });
    controller.dispose();
  });

  test('goal reads carry the session directory and interleave per session (issue #35)', async () => {
    const pending = new Map<string, (goal: NativeGoal | null) => void>();
    class HeldGoals extends FakeBackend {
      override getGoal(sessionID: string, directory?: string): Promise<NativeGoal | null> {
        this.calls.push({ name: 'getGoal', args: [sessionID, directory] });
        return new Promise((resolve) => pending.set(sessionID, resolve));
      }
    }
    const backend = new HeldGoals();
    backend.sessions = [
      { ...fakeSession('ses_a'), directory: '/work/a' },
      { ...fakeSession('ses_b'), directory: '/work/b' },
    ];
    backend.messages = { ses_a: [], ses_b: [] };
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    controller.openSession('ses_b');
    await flush();
    const reads = backend.calls.filter((call) => call.name === 'getGoal');
    expect(reads.map((call) => call.args)).toEqual([
      ['ses_a', '/work/a'],
      ['ses_b', '/work/b'],
    ]);
    // Out of order: B answers first, then A; both land.
    pending.get('ses_b')?.(activeGoal('goal_b'));
    pending.get('ses_a')?.(activeGoal('goal_a'));
    await flush();
    expect(controller.nativeGoalOf('ses_a')?.id).toBe('goal_a');
    expect(controller.nativeGoalOf('ses_b')?.id).toBe('goal_b');
    controller.dispose();
  });

  test('a goal-changed push supersedes an older in-flight read of the same session', async () => {
    const held: { release?: (goal: NativeGoal | null) => void } = {};
    class SlowGoal extends FakeBackend {
      override getGoal(): Promise<NativeGoal | null> {
        return new Promise((resolve) => {
          held.release = resolve;
        });
      }
    }
    const backend = new SlowGoal();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [] };
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    controller.onEvents(
      'local',
      [
        {
          kind: 'goal-changed',
          sessionID: 'ses_a',
          goal: { id: 'new', objective: 'new', status: 'active', rounds: 2, maxRounds: 5 },
        },
      ],
      false,
    );
    held.release?.(activeGoal('old'));
    await flush();
    expect(controller.nativeGoalOf('ses_a')?.id).toBe('new');
    controller.dispose();
  });

  test('an interrupted goal stays attached and a follow-up resumes it', async () => {
    const { backend, controller } = await goalFixture();
    await controller.interrupt();
    // The plugin pauses an active goal with reason 'Stopped by the user'.
    expect(controller.nativeGoalOf('ses_a')).toMatchObject({
      status: 'paused',
      reason: 'Stopped by the user',
    });
    expect(controller.state.awaitingSteer['ses_a']).toBe('goal_1');

    await submitCommand(controller, 'Also inspect the Windows path issue');
    const resume = backend.calls.findLast(
      (call) => call.name === 'runCommand' && call.args[1] === 'goal',
    );
    expect(resume).toEqual({ name: 'runCommand', args: ['ses_a', 'goal', 'resume'] });
    expect(controller.state.awaitingSteer['ses_a']).toBeUndefined();
    expect(controller.nativeGoalOf('ses_a')).toMatchObject({ status: 'active', rounds: 1 });
    controller.dispose();
  });

  test('a prompt submitted while idle resumes an interrupted goal; other pauses do not', async () => {
    const { backend, controller } = await goalFixture();
    backend.goals['ses_a'] = { ...backend.goals['ses_a']!, status: 'paused', reason: 'Stalled' };
    await controller.interrupt();
    // Not a user-stop pause: no follow-up intent is recorded.
    expect(controller.state.awaitingSteer['ses_a']).toBeUndefined();
    await submitCommand(controller, 'plain follow-up');
    const resumes = backend.calls.filter(
      (call) => call.name === 'runCommand' && call.args[2] === 'resume',
    );
    expect(resumes).toHaveLength(0);
    controller.dispose();
  });

  test('explicit /goal pause stays paused across a follow-up until resumed', async () => {
    const { backend, controller } = await goalFixture();
    await submitCommand(controller, '/goal pause');
    expect(controller.nativeGoalOf('ses_a')).toMatchObject({ status: 'paused' });

    await submitCommand(controller, 'a follow-up after explicit pause');
    const resumes = backend.calls.filter(
      (call) => call.name === 'runCommand' && call.args[2] === 'resume',
    );
    expect(resumes).toHaveLength(0);
    expect(controller.nativeGoalOf('ses_a')).toMatchObject({ status: 'paused' });

    await submitCommand(controller, '/goal resume');
    expect(controller.nativeGoalOf('ses_a')).toMatchObject({ status: 'active' });
    controller.dispose();
  });

  test('a delayed pause event still resumes the same goal on the follow-up', async () => {
    const { backend, controller } = await goalFixture();
    backend.interrupt = async () => true; // the plugin's pause has not landed yet
    await controller.interrupt();
    expect(controller.state.awaitingSteer['ses_a']).toBe('goal_1');
    backend.goals['ses_a'] = {
      ...backend.goals['ses_a']!,
      status: 'paused',
      reason: 'Stopped by the user',
    };
    await submitCommand(controller, 'follow-up');
    expect(backend.calls.filter((call) => call.args[2] === 'resume')).toHaveLength(1);
    expect(controller.nativeGoalOf('ses_a')).toMatchObject({ status: 'active' });
    controller.dispose();
  });

  test("another client's pause, replacement or clear wins over the interrupt intent", async () => {
    const changes: Record<string, (backend: FakeBackend) => void> = {
      pause: (backend) => {
        backend.goals['ses_a'] = {
          ...backend.goals['ses_a']!,
          status: 'paused',
          reason: 'Paused by the user',
        };
      },
      replace: (backend) => {
        backend.goals['ses_a'] = {
          ...backend.goals['ses_a']!,
          id: 'goal_2',
          status: 'paused',
          reason: 'Stopped by the user',
        };
      },
      clear: (backend) => {
        delete backend.goals['ses_a'];
      },
    };
    for (const change of Object.values(changes)) {
      const { backend, controller } = await goalFixture();
      await controller.interrupt();
      expect(controller.state.awaitingSteer['ses_a']).toBe('goal_1');
      change(backend);
      await submitCommand(controller, 'follow-up');
      expect(backend.calls.filter((call) => call.args[2] === 'resume')).toHaveLength(0);
      expect(controller.state.awaitingSteer['ses_a']).toBeUndefined();
      controller.dispose();
    }
  });

  test('a failed resume is reported instead of swallowed', async () => {
    const { backend, controller } = await goalFixture();
    await controller.interrupt();
    const run = backend.runCommand.bind(backend);
    backend.runCommand = async (sessionID, name, text) => {
      if (text === 'resume') throw new Error('plugin offline');
      await run(sessionID, name, text);
    };
    await submitCommand(controller, 'follow-up');
    expect(controller.state.notice?.text).toContain('plugin offline');
    controller.dispose();
  });

  test('the interruption intent is cleared by /goal clear and completion stops resuming', async () => {
    const { backend, controller } = await goalFixture();
    backend.serverCommands = [{ name: 'goal', description: 'goal control' }];
    await controller.interrupt();
    expect(controller.state.awaitingSteer['ses_a']).toBe('goal_1');

    await submitCommand(controller, '/goal clear');
    expect(controller.state.awaitingSteer['ses_a']).toBeUndefined();
    expect(controller.nativeGoalOf('ses_a')).toBeNull();

    await submitCommand(controller, 'anything else');
    const resumes = backend.calls.filter(
      (call) => call.name === 'runCommand' && call.args[2] === 'resume',
    );
    expect(resumes).toHaveLength(0);
    controller.dispose();
  });

  test('a confirmed null is "no goal", never confused with a failed read (issue #43)', async () => {
    const { backend, controller } = await goalFixture();
    delete backend.goals['ses_a'];
    expect(await controller.refreshNativeGoal('ses_a')).toBeNull();
    expect(controller.nativeGoalStateOf('ses_a')).toEqual({ status: 'none' });
    expect(controller.nativeGoalOf('ses_a')).toBeNull();
    controller.dispose();
  });

  test('a failed read keeps the last verified goal as stale and blocks goal actions', async () => {
    const { backend, controller } = await goalFixture();
    const verified = controller.nativeGoalStateOf('ses_a');
    expect(verified?.status).toBe('verified');
    backend.getGoal = async () => {
      throw new BackendError('transport', 'opencode.goal.get', 'offline');
    };
    await controller.refreshNativeGoal('ses_a');
    expect(controller.nativeGoalStateOf('ses_a')).toMatchObject({
      status: 'unavailable',
      reason: 'transport',
      message: 'opencode.goal.get: offline',
      sessionID: 'ses_a',
      directory: '/work/kohjoh',
      last: { id: 'goal_1', status: 'active' },
    });
    // The stale goal is displayable but never treated as the current one.
    expect(controller.nativeGoalOf('ses_a')).toBeNull();
    controller.dispose();
  });

  test('a disabled plugin and an unauthorized read are distinct and never "no goal"', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [] };
    const controller = makeController(() => Promise.resolve([]), backend);
    await attach(controller, 'ses_a');

    const failures: Record<string, BackendErrorKind> = {
      unsupported: 'not-found',
      invalid: 'invalid',
      unauthorized: 'unauthorized',
      transport: 'transport',
      unknown: 'unknown',
    };
    const expected: Record<BackendErrorKind, GoalQueryFailure> = {
      'not-found': 'unsupported',
      invalid: 'unsupported',
      unauthorized: 'unauthorized',
      transport: 'transport',
      unknown: 'unknown',
      conflict: 'unknown',
    };
    for (const [name, kind] of Object.entries(failures)) {
      backend.getGoal = async () => {
        throw new BackendError(kind, 'opencode.goal.get', name);
      };
      await controller.refreshNativeGoal('ses_a');
      const state = controller.nativeGoalStateOf('ses_a');
      expect(state?.status).toBe('unavailable');
      expect(state?.status === 'unavailable' ? state.reason : 'missing').toBe(expected[kind]);
      expect(state?.status === 'unavailable' ? state.last : 'missing').toBeUndefined();
    }
    controller.dispose();
  });

  test('reconnect retries an unavailable goal read without overwriting a fresher push', async () => {
    const { backend, controller } = await goalFixture();
    let mode: 'fail' | 'hold' | 'ok' = 'fail';
    let release: ((goal: NativeGoal | null) => void) | undefined;
    const real = backend.getGoal.bind(backend);
    backend.getGoal = async (sessionID, directory) => {
      if (mode === 'fail') throw new BackendError('transport', 'opencode.goal.get', 'offline');
      if (mode === 'hold') {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return real(sessionID, directory);
    };
    await controller.refreshNativeGoal('ses_a');
    expect(controller.nativeGoalStateOf('ses_a')?.status).toBe('unavailable');

    mode = 'ok';
    controller.onEvents('local', [], true);
    await flush();
    await flush();
    expect(controller.nativeGoalStateOf('ses_a')?.status).toBe('verified');

    // A read in flight during reconnect answers after a newer push: the push wins.
    mode = 'hold';
    controller.onEvents('local', [], true);
    await flush();
    controller.onEvents(
      'local',
      [
        {
          kind: 'goal-changed',
          sessionID: 'ses_a',
          goal: { id: 'goal_2', objective: 'newer', status: 'active', rounds: 1, maxRounds: 5 },
        },
      ],
      false,
    );
    release?.(activeGoal('goal_1'));
    await flush();
    await flush();
    expect(controller.nativeGoalStateOf('ses_a')).toMatchObject({
      status: 'verified',
      goal: { id: 'goal_2' },
    });
    controller.dispose();
  });
});

function pressKey(
  controller: AppController,
  key: { name: string; ctrl?: boolean; alt?: boolean; shift?: boolean },
): boolean {
  const services = { openEditor: () => {}, redraw: () => {}, scroll: () => {} };
  const { keymap } = buildKeymap({});
  return routeKey(
    controller,
    keymap,
    {
      name: key.name,
      ctrl: key.ctrl ?? false,
      alt: key.alt ?? false,
      shift: key.shift ?? false,
    },
    services,
  );
}

function queuedBackend() {
  const backend = new FakeBackend();
  backend.sessions = [fakeSession('ses_a'), fakeSession('ses_b')];
  backend.messages = { ses_a: [], ses_b: [] };
  backend.active = new Set(['ses_a']);
  backend.inbox = [
    { id: 'in_1', kind: 'user', delivery: 'queue', text: 'first follow-up', createdAt: 1 },
    { id: 'in_2', kind: 'user', delivery: 'queue', text: 'second follow-up', createdAt: 2 },
  ];
  return backend;
}

const cancelFor = (backend: FakeBackend, inboxID: string) =>
  backend.calls.filter((call) => call.name === 'cancelQueued' && call.args[1] === inboxID);
const promoteFor = (backend: FakeBackend, inboxID: string) =>
  backend.calls.filter((call) => call.name === 'promoteQueued' && call.args[1] === inboxID);

function queueController(inbox: FakeBackend['inbox']) {
  const backend = new FakeBackend();
  backend.sessions = [fakeSession('ses_a')];
  backend.messages = { ses_a: [] };
  backend.active = new Set(['ses_a']);
  backend.inboxSession = Object.fromEntries(inbox.map((item) => [item.id, 'ses_a']));
  backend.inbox = inbox;
  const controller = makeController(() => Promise.resolve([]), backend);
  return { backend, controller };
}

describe('send-now targets the hinted queued item (issue #40)', () => {
  test('a pending steer item ahead of a queued one is skipped', async () => {
    const backend = queuedBackend();
    backend.inbox = [
      { id: 'in_steer', kind: 'user', delivery: 'steer', text: 'steering', createdAt: 1 },
      { id: 'in_q', kind: 'user', delivery: 'queue', text: 'queued', createdAt: 2 },
    ];
    const controller = makeController(() => Promise.resolve([]), backend);
    await attach(controller, 'ses_a');
    await controller.promoteNextQueued();
    const change = backend.calls.find((call) => call.name === 'changeDelivery');
    expect(change?.args[1]).toBe('in_q');
    controller.dispose();
  });

  test('a failed promotion does not resume a paused goal', async () => {
    const { backend, controller } = await goalFixture();
    backend.active = new Set(['ses_a']);
    backend.inbox = [{ id: 'in_q', kind: 'user', delivery: 'queue', text: 'queued', createdAt: 1 }];
    await controller.interrupt();
    expect(controller.state.awaitingSteer['ses_a']).toBe('goal_1');
    backend.changeDelivery = async () => {
      throw new Error('conflict');
    };
    await controller.promoteQueued('in_q');
    expect(backend.calls.filter((call) => call.args[2] === 'resume')).toHaveLength(0);
    expect(controller.state.awaitingSteer['ses_a']).toBe('goal_1');
    controller.dispose();
  });
});

describe(`Up recalls the newest queued follow-up (issue #30)`, () => {
  test('Up on an empty composer recalls the newest entry; the older stays queued', async () => {
    const backend = queuedBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await attach(controller, 'ses_a');

    pressKey(controller, { name: 'up' });
    await flush();

    expect(controller.state.composer.text).toBe('second follow-up');
    expect(controller.state.composer.cursor).toBe('second follow-up'.length);
    expect(backend.inbox.map((item) => item.id)).toEqual(['in_1']);
    controller.dispose();
  });

  test('a recalled multiline message with an @mention round-trips unclipped', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [] };
    backend.active = new Set(['ses_a']);
    backend.inbox = [
      {
        id: 'in_9',
        kind: 'user',
        delivery: 'queue',
        text: 'look at @src/app/controller.ts\nand then run the tests\n\nthanks',
        createdAt: 1,
      },
    ];
    const controller = makeController(() => Promise.resolve([]), backend);
    await attach(controller, 'ses_a');

    pressKey(controller, { name: 'up' });
    await flush();

    expect(controller.state.composer.text).toBe(
      'look at @src/app/controller.ts\nand then run the tests\n\nthanks',
    );
    expect(controller.state.composer.cursor).toBe(controller.state.composer.text.length);
    expect(backend.inbox).toEqual([]);
    controller.dispose();
  });

  test('editing the recalled message and pressing Enter creates no duplicate; the replacement is queued', async () => {
    const backend = queuedBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await attach(controller, 'ses_a');

    pressKey(controller, { name: 'up' });
    await flush();
    controller.setComposer(composerFrom('edited follow-up'));
    await controller.submit();

    const prompts = backend.calls.filter((call) => call.name === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.args[1]).toMatchObject({ text: 'edited follow-up', delivery: 'queue' });
    expect(backend.inbox.filter((item) => item.kind === 'user').map((item) => item.text)).toEqual([
      'first follow-up',
      'edited follow-up',
    ]);
    controller.dispose();
  });

  test('with a non-empty composer Up does not touch the queue', async () => {
    const backend = queuedBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await attach(controller, 'ses_a');
    controller.setComposer(composerFrom('draft in progress'));

    pressKey(controller, { name: 'up' });

    expect(backend.calls.filter((call) => call.name === 'cancelQueued')).toHaveLength(0);
    expect(controller.state.inbox['ses_a']?.map((item) => item.id)).toEqual(['in_1', 'in_2']);
    controller.dispose();
  });

  test('a cancel conflict reports an already-delivered item and leaves the queue alone', async () => {
    const backend = queuedBackend();
    backend.cancelQueued = async () => {
      throw new BackendError('not-found', 'session.inbox.cancel', 'delivered');
    };
    const controller = makeController(() => Promise.resolve([]), backend);
    await attach(controller, 'ses_a');

    await controller.recallQueuedUp();

    expect(controller.state.notice?.text).toContain('Already delivered');
    expect(controller.state.composer.text).toBe('');
    expect(Object.values(controller.state.stashes).filter(Boolean)).toHaveLength(0);
    controller.dispose();
  });

  test('switching sessions during the cancel does not deposit text in the new session', async () => {
    const backend = queuedBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await attach(controller, 'ses_a');

    const hold = deferred<void>();
    const realCancel = backend.cancelQueued.bind(backend);
    backend.cancelQueued = async (sessionID: string, inboxID: string) => {
      await hold.promise;
      return realCancel(sessionID, inboxID);
    };

    const recall = controller.recallQueuedUp();
    controller.openSession('ses_b');
    hold.resolve();
    await recall;
    await flush();

    expect(controller.state.composer.text).toBe('');
    expect(Object.values(controller.state.stashes).find(Boolean)?.composer.text).toBe(
      'second follow-up',
    );
    controller.dispose();
  });

  test('a busy composer and occupied stash still keep the cancelled text recoverable', async () => {
    const backend = queuedBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await attach(controller, 'ses_a');
    controller.setComposer(composerFrom('typing now'));
    controller.toggleStash(); // occupy the stash
    controller.setComposer(composerFrom('another draft'));
    await controller.recallQueuedUp();
    await flush();

    expect(controller.state.composer.text).toBe('another draft');
    expect(Object.values(controller.state.stashes).find(Boolean)?.composer.text).toBe('typing now');
    expect(controller.state.recovered).toHaveLength(1);
    const recovered = controller.state.recovered[0]?.text ?? '';
    expect(recovered).not.toBe('');

    controller.setComposer(composerFrom(''));
    controller.toggleStash(); // stash first
    controller.setComposer(composerFrom(''));
    controller.toggleStash(); // then the recovery entry
    expect(controller.state.composer.text).toBe(recovered);
    expect(controller.state.recovered).toHaveLength(0);
    controller.dispose();
  });

  test('Ctrl+S restores a parked message only on its source session', async () => {
    const backend = queuedBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await attach(controller, 'ses_a');

    const hold = deferred<void>();
    const realCancel = backend.cancelQueued.bind(backend);
    backend.cancelQueued = async (sessionID: string, inboxID: string) => {
      await hold.promise;
      return realCancel(sessionID, inboxID);
    };

    const recall = controller.recallQueuedUp();
    controller.openSession('ses_b');
    hold.resolve();
    await recall;

    controller.toggleStash();
    expect(controller.state.composer.text).toBe('');

    controller.openSession('ses_a');
    controller.toggleStash();
    expect(controller.state.composer.text).toBe('second follow-up');
    controller.dispose();
  });
});

describe('queue overlay keyboard selection matches visible user items (issue #88)', () => {
  test('a compaction entry is not cancelable; user rows map one-to-one to Up/Down then x', async () => {
    const { backend, controller } = queueController([
      { id: 'in_c', kind: 'compaction', delivery: 'queue', text: 'compacting...', createdAt: 1 },
      { id: 'in_a', kind: 'user', delivery: 'queue', text: 'userA', createdAt: 2 },
      { id: 'in_b', kind: 'user', delivery: 'queue', text: 'userB', createdAt: 3 },
    ]);
    try {
      await attach(controller, 'ses_a');
      // currentView().queued filters compactions out: [userA, userB]
      controller.setOverlay({ kind: 'queue', index: 0 });
      pressKey(controller, { name: 'x' });
      expect(cancelFor(backend, 'in_a')).toHaveLength(1);
      expect(cancelFor(backend, 'in_b')).toHaveLength(0);
      expect(promoteFor(backend, 'in_c')).toHaveLength(0);

      // Second visible row operates on userB, never on the compaction.
      pressKey(controller, { name: 'down' });
      pressKey(controller, { name: 'x' });
      expect(cancelFor(backend, 'in_b')).toHaveLength(1);
      expect(cancelFor(backend, 'in_a')).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  test('removing an item during selection cannot cancel or promote the wrong ID (#88)', async () => {
    const { backend, controller } = queueController([
      { id: 'in_a', kind: 'user', delivery: 'queue', text: 'userA', createdAt: 1 },
      { id: 'in_b', kind: 'user', delivery: 'queue', text: 'userB', createdAt: 2 },
      { id: 'in_c', kind: 'user', delivery: 'queue', text: 'userC', createdAt: 3 },
    ]);
    try {
      await attach(controller, 'ses_a');
      controller.setOverlay({ kind: 'queue', index: 2 }); // userC highlighted

      // userB (the middle row) is delivered while the dialog is open: refresh the inbox
      // from the backend, then the stale index clamps onto userC which is still visible.
      backend.inbox = [backend.inbox[0]!, backend.inbox[2]!];
      backend.inboxSession = { in_a: 'ses_a', in_c: 'ses_a' };
      controller.openSession('ses_a');
      await flush();
      controller.setOverlay({ kind: 'queue', index: 2 }); // stale index for the new list
      pressKey(controller, { name: 'x' });
      expect(cancelFor(backend, 'in_c')).toHaveLength(1);
      expect(cancelFor(backend, 'in_b')).toHaveLength(0);
      expect(promoteFor(backend, 'in_b')).toHaveLength(0);
    } finally {
      controller.dispose();
    }
  });

  test('an out-of-range stale index clamps to the last visible item (#88)', async () => {
    const { backend, controller } = queueController([
      { id: 'in_a', kind: 'user', delivery: 'queue', text: 'userA', createdAt: 1 },
      { id: 'in_b', kind: 'user', delivery: 'queue', text: 'userB', createdAt: 2 },
    ]);
    try {
      await attach(controller, 'ses_a');
      controller.setOverlay({ kind: 'queue', index: 5 }); // far beyond the two rows
      pressKey(controller, { name: 'x' });
      // index clamps onto the last visible row (userB) instead of acting on nothing.
      expect(cancelFor(backend, 'in_b')).toHaveLength(1);
      expect(cancelFor(backend, 'in_a')).toHaveLength(0);
    } finally {
      controller.dispose();
    }
  });

  test('an empty queue selects nothing and cancels/promotes nothing (#88)', async () => {
    const { backend, controller } = queueController([]);
    try {
      await attach(controller, 'ses_a');
      controller.setOverlay({ kind: 'queue', index: 0 });
      pressKey(controller, { name: 'up' });
      pressKey(controller, { name: 'down' });
      pressKey(controller, { name: 'x' });
      pressKey(controller, { name: 's' });
      expect(cancelFor(backend, 'anything')).toHaveLength(0);
      expect(promoteFor(backend, 'anything')).toHaveLength(0);
    } finally {
      controller.dispose();
    }
  });

  test('remote queue acts only on the displayed host when session IDs collide (#88)', async () => {
    const backendA = new FakeBackend();
    backendA.serverID = 'local';
    backendA.sessions = [{ ...fakeSession('ses_same'), directory: '/shared' }];
    backendA.inboxSession = { in_a: 'ses_same' };
    backendA.inbox = [{ id: 'in_a', kind: 'user', delivery: 'queue', text: 'userA', createdAt: 1 }];

    const backendB = new FakeBackend();
    backendB.serverID = 'srv_1';
    backendB.sessions = [{ ...fakeSession('ses_same'), directory: '/shared' }];
    backendB.inboxSession = { in_b: 'ses_same' };
    backendB.inbox = [{ id: 'in_b', kind: 'user', delivery: 'queue', text: 'userB', createdAt: 2 }];

    const controller = new AppController({
      backend: backendA,
      config: defaultConfig,
      localState: emptyState,
      platform: 'linux',
      cwd: '/work/kohjoh',
      version: '0.0.1',
      now: () => 10_000,
      saveLocalState: async () => {},
      listFiles: () => Promise.resolve([]),
      requestExit: () => {},
      serverIDs: () => ['srv_1'],
      backendFor: (serverID: string) => (serverID === 'srv_1' ? backendB : backendA),
      serverInfo: () => ({ online: true }),
    });
    try {
      await controller.bootstrap();
      controller.openSession('ses_same'); // local host
      await flush();
      controller.setOverlay({ kind: 'queue', index: 0 });

      pressKey(controller, { name: 'x' });
      expect(cancelFor(backendA, 'in_a')).toHaveLength(1);
      expect(cancelFor(backendB, 'in_b')).toHaveLength(0);
    } finally {
      controller.dispose();
    }
  });
});

describe('export writes to a deliberate local destination (#89)', () => {
  test('default export writes to the local cwd, never the session directory', async () => {
    const writes: { path: string; text: string }[] = [];
    const backend = sessionWithMessages('/some/project', [
      { kind: 'user', id: 'm1', createdAt: 1, text: 'hello', attachments: [] },
    ]);
    const { controller } = exportHarness(backend, {
      cwd: '/work/kohjoh',
      writeFile: async (path, text) => {
        writes.push({ path, text });
      },
    });
    try {
      await openAndExport(controller, 'ses_a');
      expect(writes).toHaveLength(1);
      // Resolved against the local cwd, not the session's /some/project directory.
      expect(writes[0]!.path).toBe('/work/kohjoh/marg-ses_a.json');
      expect(writes[0]!.text).toContain('hello');
      expect(controller.state.notice?.tone).toBe('dim');
    } finally {
      controller.dispose();
    }
  });

  test('a remote session still exports to the local machine', async () => {
    const writes: { path: string; text: string }[] = [];
    const backend = sessionWithMessages('/srv/app', [
      { kind: 'user', id: 'm1', createdAt: 1, text: 'remote hello', attachments: [] },
    ]);
    const { controller } = exportHarness(backend, {
      serverID: 'srv_1',
      platform: 'linux',
      cwd: '/work/kohjoh',
      writeFile: async (path, text) => {
        writes.push({ path, text });
      },
    });
    try {
      await openAndExport(controller, 'ses_a', 'srv_1');
      expect(writes).toHaveLength(1);
      // The remote /srv/app directory is never used as the local output base.
      expect(writes[0]!.path).toBe('/work/kohjoh/marg-ses_a.json');
      expect(writes[0]!.text).toContain('remote hello');
    } finally {
      controller.dispose();
    }
  });

  test('a relative target resolves against the local cwd', async () => {
    const writes: { path: string; text: string }[] = [];
    const backend = sessionWithMessages('/srv/app', [
      { kind: 'user', id: 'm1', createdAt: 1, text: 'relative', attachments: [] },
    ]);
    const { controller } = exportHarness(backend, {
      serverID: 'srv_1',
      platform: 'linux',
      cwd: '/work/kohjoh',
      writeFile: async (path, text) => {
        writes.push({ path, text });
      },
    });
    try {
      await openAndExport(controller, 'ses_a', 'srv_1', 'out.json');
      expect(writes[0]!.path).toBe('/work/kohjoh/out.json');
    } finally {
      controller.dispose();
    }
  });

  test('an absolute local target is used as-is', async () => {
    const writes: { path: string; text: string }[] = [];
    const backend = sessionWithMessages('/srv/app', [
      { kind: 'user', id: 'm1', createdAt: 1, text: 'absolute', attachments: [] },
    ]);
    const { controller } = exportHarness(backend, {
      serverID: 'srv_1',
      platform: 'linux',
      cwd: '/work/kohjoh',
      writeFile: async (path, text) => {
        writes.push({ path, text });
      },
    });
    try {
      await openAndExport(controller, 'ses_a', 'srv_1', '/tmp/out.json');
      expect(writes[0]!.path).toBe('/tmp/out.json');
    } finally {
      controller.dispose();
    }
  });

  test('a cross-platform absolute remote target is refused instead of written locally', async () => {
    const writes: { path: string; text: string }[] = [];
    const backend = sessionWithMessages('/srv/app', [
      { kind: 'user', id: 'm1', createdAt: 1, text: 'refused', attachments: [] },
    ]);
    // Windows client, Linux remote session: a POSIX absolute target looks remote.
    const { controller } = exportHarness(backend, {
      serverID: 'srv_1',
      platform: 'win32',
      cwd: 'C:\\work',
      writeFile: async (path, text) => {
        writes.push({ path, text });
      },
    });
    try {
      await openAndExport(controller, 'ses_a', 'srv_1', '/srv/app');
      expect(writes).toHaveLength(0);
      expect(controller.state.notice?.tone).toBe('warn');
      expect(controller.state.notice?.text).toContain('Refusing to export');
      expect(controller.state.notice?.text).toContain('C:\\work');
    } finally {
      controller.dispose();
    }
  });

  test('the exported file contains the complete paginated transcript', async () => {
    const writes: { path: string; text: string }[] = [];
    const messages: TranscriptMessage[] = [
      { kind: 'user', id: 'm1', createdAt: 1, text: 'first', attachments: [] },
      { kind: 'user', id: 'm2', createdAt: 2, text: 'second', attachments: [] },
      { kind: 'user', id: 'm3', createdAt: 3, text: 'third', attachments: [] },
    ];
    const backend = sessionWithMessages('/some/project', messages);
    const { controller } = exportHarness(backend, {
      cwd: '/work/kohjoh',
      writeFile: async (path, text) => {
        writes.push({ path, text });
      },
    });
    try {
      await openAndExport(controller, 'ses_a');
      const log = JSON.parse(writes[0]!.text);
      expect(log.format).toBe('margarita.chatlog.v1');
      expect(log.messages.map((message: { text: string }) => message.text)).toEqual([
        'first',
        'second',
        'third',
      ]);
    } finally {
      controller.dispose();
    }
  });
});

function exportHarness(
  backend: FakeBackend,
  options: {
    platform?: NodeJS.Platform;
    cwd?: string;
    serverID?: string;
    writeFile: (path: string, text: string) => Promise<void>;
  },
) {
  const controller = new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: options.platform ?? 'linux',
    cwd: options.cwd ?? '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    requestExit: () => {},
    serverInfo: () => ({ online: true }),
    writeFile: options.writeFile,
    // `serverID` is omitted (not set to undefined) when absent, due to
    // exactOptionalPropertyTypes.
    ...(options.serverID !== undefined ? { serverID: options.serverID } : {}),
  });
  return { backend, controller };
}

const sessionWithMessages = (directory: string, messages: TranscriptMessage[]) => {
  const backend = new FakeBackend();
  backend.sessions = [{ ...fakeSession('ses_a'), directory }];
  backend.messages = { ses_a: messages };
  return backend;
};

async function openAndExport(
  controller: AppController,
  sessionID: string,
  serverID: string = 'local',
  target: string = '',
): Promise<void> {
  await controller.bootstrap();
  controller.openSession(sessionID, serverID);
  await flush();
  await controller.exportChat(target);
}

function configFor(delivery: 'queue' | 'steer') {
  return delivery === 'queue'
    ? defaultConfig
    : { ...defaultConfig, input: { enterWhileRunning: 'steer' as const } };
}

function runningSessionBackend() {
  const backend = new FakeBackend();
  backend.sessions = [fakeSession('ses_a')];
  backend.messages = { ses_a: [] };
  backend.active = new Set(['ses_a']);
  backend.agents = [{ id: 'build', name: 'build', mode: 'primary', hidden: false }];
  return backend;
}

function makePromptController(config: AppConfig, backend: FakeBackend) {
  return new AppController({
    backend,
    config,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    requestExit: () => {},
  });
}

describe('slash commands are control actions, never queued prompts (issue #31)', () => {
  const configs = [
    { name: 'queue', delivery: 'queue' as const },
    { name: 'steer', delivery: 'steer' as const },
  ];

  for (const { delivery } of configs) {
    test(`local controls never become a ${delivery} inbox message while the agent works`, async () => {
      const config = configFor(delivery);
      const backend = runningSessionBackend();
      const controller = makePromptController(config, backend);
      await attach(controller, 'ses_a');

      for (const command of [
        '/sessions',
        '/queue',
        '/interrupt',
        '/goal pause',
        '/model',
        '/goal clear',
      ]) {
        backend.calls.length = 0;
        controller.setComposer(composerFrom(command));
        await controller.submit();
        expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
        expect((controller.state.inbox['ses_a'] ?? []).some((item) => item.kind === 'user')).toBe(
          false,
        );
      }
      controller.dispose();
    });

    test(`an ordinary prompt while the agent works admits with delivery ${delivery}`, async () => {
      const config = configFor(delivery);
      const backend = runningSessionBackend();
      const controller = makePromptController(config, backend);
      await attach(controller, 'ses_a');

      controller.setComposer(composerFrom('plain follow-up'));
      await controller.submit();

      const prompts = backend.calls.filter((call) => call.name === 'prompt');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.args[1]).toMatchObject({ text: 'plain follow-up', delivery });
      controller.dispose();
    });
  }

  test('an unknown slash command is rejected; the composer is preserved', async () => {
    const backend = runningSessionBackend();
    const controller = makePromptController(defaultConfig, backend);
    await attach(controller, 'ses_a');

    controller.setComposer(composerFrom('/not-a-real-command'));
    await controller.submit();

    expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
    expect(controller.state.composer.text).toBe('/not-a-real-command');
    expect(controller.state.notice?.text).toContain('Unknown command');
    controller.dispose();
  });

  test('a server-side command executes through session.command, not session.prompt', async () => {
    const backend = runningSessionBackend();
    backend.serverCommands = [{ name: 'deploy', description: 'Deploy the application' }];
    const controller = makePromptController(defaultConfig, backend);
    await attach(controller, 'ses_a');

    controller.setComposer(composerFrom('/deploy some extra args'));
    await controller.submit();

    expect(backend.calls).toEqual(
      expect.arrayContaining([
        { name: 'runCommand', args: ['ses_a', 'deploy', 'some extra args'] },
      ]),
    );
    expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
    controller.dispose();
  });

  test('a failing server command reports an explicit error and preserves the draft', async () => {
    const backend = runningSessionBackend();
    backend.serverCommands = [{ name: 'deploy', description: 'Deploy the application' }];
    backend.runCommand = async () => {
      throw new BackendError('unknown', 'session.command', 'busy right now');
    };
    const controller = makePromptController(defaultConfig, backend);
    await attach(controller, 'ses_a');

    controller.setComposer(composerFrom('/deploy'));
    await controller.submit();

    expect(controller.state.notice?.text).toContain('busy right now');
    expect(controller.state.composer.text).toBe('/deploy');
    expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
    controller.dispose();
  });

  test('a transport failure of a server command reports an explicit connection notice', async () => {
    const backend = runningSessionBackend();
    backend.serverCommands = [{ name: 'deploy', description: 'Deploy the application' }];
    backend.runCommand = async () => {
      throw new BackendError('transport', 'session.command', 'connection refused');
    };
    const controller = makePromptController(defaultConfig, backend);
    await attach(controller, 'ses_a');

    controller.setComposer(composerFrom('/deploy'));
    await controller.submit();

    expect(controller.state.notice?.text).toContain('connection problem');
    expect(controller.state.composer.text).toBe('/deploy');
    expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
    controller.dispose();
  });

  test('the local /revert control works even when the server catalog fetch fails', async () => {
    const backend = runningSessionBackend();
    backend.listCommands = async () => {
      throw new Error('catalog broken');
    };
    const controller = makePromptController(defaultConfig, backend);
    await attach(controller, 'ses_a');

    controller.setComposer(composerFrom('/interrupt'));
    await controller.submit();

    expect(backend.calls.some((call) => call.name === 'interrupt')).toBe(true);
    expect(controller.state.composer.text).toBe('');
    controller.dispose();
  });

  test('a recalled queued message edited to start with / is routed as a command on resubmission', async () => {
    const backend = runningSessionBackend();
    backend.serverCommands = [{ name: 'deploy', description: 'Deploy the application' }];
    backend.inbox = [
      { id: 'in_1', kind: 'user', delivery: 'queue', text: 'please review', createdAt: 1 },
    ];
    const controller = makePromptController(defaultConfig, backend);
    await attach(controller, 'ses_a');

    await controller.recallQueuedUp();
    expect(controller.state.composer.text).toBe('please review');

    controller.setComposer(composerFrom('/deploy'));
    await controller.submit();

    expect(backend.calls).toEqual(
      expect.arrayContaining([{ name: 'runCommand', args: ['ses_a', 'deploy', ''] }]),
    );
    expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
    // The inbox only holds non-queued (none) user items afterwards.
    expect(controller.state.inbox['ses_a'] ?? []).toEqual([]);
    controller.dispose();
  });
});

describe('/compact routes to native session compaction (issue #32)', () => {
  test('idle /compact requests one native compaction and never a prompt or server command', async () => {
    const backend = runningSessionBackend();
    const controller = makePromptController(defaultConfig, backend);
    await attach(controller, 'ses_a');

    await submitCommand(controller, '/compact');

    const compacts = backend.calls.filter((call) => call.name === 'compactSession');
    expect(compacts).toEqual([{ name: 'compactSession', args: ['ses_a'] }]);
    expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
    expect(backend.calls.some((call) => call.name === 'runCommand')).toBe(false);
    // Accepted is not completed: the notice never claims the conversation was compacted.
    expect(controller.state.notice?.text).toBe('Compaction requested');
    expect(controller.state.notice?.text).not.toContain('compacted');
    controller.dispose();
  });

  test('/compact works during a running turn without touching a queued follow-up', async () => {
    const backend = runningSessionBackend();
    backend.inbox = [
      { id: 'in_1', kind: 'user', delivery: 'queue', text: 'keep this queued', createdAt: 1 },
    ];
    const controller = makePromptController(defaultConfig, backend);
    await attach(controller, 'ses_a');

    await submitCommand(controller, '/compact');

    const compacts = backend.calls.filter((call) => call.name === 'compactSession');
    expect(compacts).toHaveLength(1);
    expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
    // The queued user follow-up is untouched and still user-queued.
    const userItems = controller.state.inbox['ses_a']?.filter((item) => item.kind === 'user');
    expect(userItems?.map((item) => item.text)).toEqual(['keep this queued']);
    controller.dispose();
  });

  test('a second /compact while one is pending does not double-request', async () => {
    const backend = runningSessionBackend();
    const controller = makePromptController(defaultConfig, backend);
    await attach(controller, 'ses_a');

    await submitCommand(controller, '/compact');
    await submitCommand(controller, '/compact');

    expect(backend.calls.filter((call) => call.name === 'compactSession')).toHaveLength(1);
    expect(controller.state.notice?.text).toBe('Compaction already pending');
    controller.dispose();
  });

  test('a transport failure of /compact asks nothing of the server and says so', async () => {
    const backend = runningSessionBackend();
    backend.compactError = new BackendError('transport', 'session.compact', 'connection refused');
    const controller = makePromptController(defaultConfig, backend);
    await attach(controller, 'ses_a');

    await submitCommand(controller, '/compact');

    expect(controller.state.notice?.text).toContain('connection problem');
    expect(controller.state.notice?.text).not.toContain('compacted');
    // No pending item was fabricated and the inbox is clean.
    expect(controller.state.inbox['ses_a'] ?? []).toEqual([]);
    controller.dispose();
  });

  test('/compact with arguments is rejected as a usage error', async () => {
    const backend = runningSessionBackend();
    const controller = makePromptController(defaultConfig, backend);
    await attach(controller, 'ses_a');

    await submitCommand(controller, '/compact please summarize everything');

    expect(backend.calls.filter((call) => call.name === 'compactSession')).toHaveLength(0);
    expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
    expect(controller.state.notice?.text).toBe('Usage: /compact');
    controller.dispose();
  });

  test('/compact with no session open warns instead of calling the backend', async () => {
    const backend = new FakeBackend();
    const controller = makePromptController(defaultConfig, backend);
    await controller.bootstrap();

    await submitCommand(controller, '/compact');

    expect(backend.calls.filter((call) => call.name === 'compactSession')).toHaveLength(0);
    expect(controller.state.notice?.text).toBe('Open a session first.');
    controller.dispose();
  });
});

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const pngData = Buffer.from(pngBytes).toString('base64');
const asBytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function attachedBackend(): FakeBackend {
  const backend = new FakeBackend();
  backend.sessions = [fakeSession('ses_a')];
  backend.messages = { ses_a: [] };
  return backend;
}

describe('image paste and attachments (issue #42)', () => {
  test('plain and multiline text still paste as text', async () => {
    const controller = makeController(() => Promise.resolve([]), attachedBackend());
    await attach(controller, 'ses_a');

    await controller.pasteBytes(asBytes('line one\nline two'));

    expect(controller.state.composer.text).toBe('line one\nline two');
    expect(controller.state.attachments).toEqual([]);
  });

  test('binary image data becomes a chip; arbitrary binary is rejected', async () => {
    const controller = makeController(() => Promise.resolve([]), attachedBackend());
    await attach(controller, 'ses_a');

    await controller.pasteBytes(pngBytes);
    expect(controller.state.attachments).toHaveLength(1);
    expect(controller.state.attachments[0]).toMatchObject({
      name: 'clipboard.png',
      mime: 'image/png',
    });
    expect(controller.state.composer.text).toBe('');

    await controller.pasteBytes(new Uint8Array([0, 1, 2, 250]));
    expect(controller.state.attachments).toHaveLength(1);
    expect(controller.state.composer.text).toBe('');
    expect(controller.state.notice?.text).toContain('not text or a supported image');
    controller.dispose();
  });

  test('pasting a local image path attaches the file instead of its text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marg-attach-'));
    const controller = makeController(() => Promise.resolve([]), attachedBackend());
    try {
      const path = join(directory, 'shot.png');
      await writeFile(path, pngBytes);
      await attach(controller, 'ses_a');

      // The controller test platform is posix; Windows temp paths work with forward slashes.
      await controller.pasteBytes(asBytes(path.replaceAll('\\', '/')));

      expect(controller.state.composer.text).toBe('');
      expect(controller.state.attachments).toHaveLength(1);
      expect(controller.state.attachments[0]).toMatchObject({
        name: 'shot.png',
        mime: 'image/png',
      });
      expect(controller.state.notice?.text).toContain('shot.png attached');
    } finally {
      controller.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('an attachment alone can be submitted; it travels inline and clears on success', async () => {
    const backend = attachedBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await attach(controller, 'ses_a');

    controller.attachImage(pngBytes, 'image/png', 'shot.png');
    await controller.submit();

    const draft = promptDraft(backend);
    expect(draft.text).toBe('');
    expect(draft.files).toEqual([{ uri: `data:image/png;base64,${pngData}`, name: 'shot.png' }]);
    expect(controller.state.attachments).toEqual([]);
    controller.dispose();
  });

  test('Backspace on an empty composer removes the newest attachment', async () => {
    const controller = makeController(() => Promise.resolve([]), attachedBackend());
    await attach(controller, 'ses_a');
    controller.attachImage(pngBytes, 'image/png', 'one.png');
    controller.attachImage(pngBytes, 'image/png', 'two.png');

    expect(pressKey(controller, { name: 'backspace' })).toBe(true);
    expect(controller.state.attachments.map((attachment) => attachment.name)).toEqual(['one.png']);
    expect(pressKey(controller, { name: 'backspace' })).toBe(true);
    expect(controller.state.attachments).toEqual([]);
    controller.dispose();
  });

  test('recalling a queued message restores its attachments', async () => {
    const backend = attachedBackend();
    const attachment = {
      id: 'a1',
      name: 'shot.png',
      mime: 'image/png',
      data: pngData,
      size: pngBytes.byteLength,
    };
    backend.inbox = [
      {
        id: 'in_1',
        kind: 'user',
        delivery: 'queue',
        text: 'look at this',
        createdAt: 1,
        attachments: [attachment],
      },
    ];
    const controller = makeController(() => Promise.resolve([]), backend);
    await attach(controller, 'ses_a');

    await controller.recallQueuedUp();

    expect(controller.state.composer.text).toBe('look at this');
    expect(controller.state.attachments.map((entry) => entry.name)).toEqual(['shot.png']);
    controller.dispose();
  });

  test('drafts and the stash keep attachments with their text', async () => {
    const controller = makeController(() => Promise.resolve([]), attachedBackend());
    await attach(controller, 'ses_a');
    controller.setComposer(composerFrom('fix this'));
    controller.attachImage(pngBytes, 'image/png', 'shot.png');

    controller.openOverview();
    expect(controller.state.attachments).toEqual([]);
    controller.openSession('ses_a');
    expect(controller.state.composer.text).toBe('fix this');
    expect(controller.state.attachments.map((attachment) => attachment.name)).toEqual(['shot.png']);

    controller.toggleStash();
    expect(controller.state.attachments).toEqual([]);
    expect(controller.state.composer.text).toBe('');
    controller.toggleStash();
    expect(controller.state.composer.text).toBe('fix this');
    expect(controller.state.attachments.map((attachment) => attachment.name)).toEqual(['shot.png']);
    controller.dispose();
  });

  test('stashes preserve cursor and attachments independently across routes', async () => {
    const controller = makeController(() => Promise.resolve([]), attachedBackend());
    await attach(controller, 'ses_a');
    const text = 'first\ne\u0301 tail';
    const cursor = 'first\ne\u0301'.length;
    controller.setComposer({ text, cursor });
    controller.attachImage(pngBytes, 'image/png', 'shot.png');
    controller.toggleStash();

    controller.openOverview();
    controller.attachImage(pngBytes, 'image/png', 'other.png');
    controller.toggleStash();
    controller.openSession('ses_a');
    controller.toggleStash();
    expect(controller.state.composer).toEqual({ text, cursor });
    expect(controller.state.attachments.map((item) => item.name)).toEqual(['shot.png']);

    controller.openOverview();
    controller.toggleStash();
    expect(controller.state.composer.text).toBe('');
    expect(controller.state.attachments.map((item) => item.name)).toEqual(['other.png']);
    controller.dispose();
  });

  test('the first prompt of a new session keeps its attachments (issue #77)', async () => {
    const backend = new FakeBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    // The overview composer is the new-session composer.
    controller.attachImage(pngBytes, 'image/png', 'shot.png');
    controller.setComposer(composerFrom('look at this'));

    await controller.submit();

    expect(backend.calls.filter((call) => call.name === 'createSession')).toHaveLength(1);
    expect(backend.calls.filter((call) => call.name === 'prompt')).toHaveLength(1);
    const draft = promptDraft(backend);
    expect(draft.text).toBe('look at this');
    expect(draft.files).toEqual([{ uri: `data:image/png;base64,${pngData}`, name: 'shot.png' }]);
    // The chip clears only after the server acknowledged the prompt.
    expect(controller.state.attachments).toEqual([]);
    controller.dispose();
  });

  test('the /new route keeps every attachment in its first prompt', async () => {
    const backend = new FakeBackend();
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    controller.startNewSession('/work/kohjoh');
    controller.attachImage(pngBytes, 'image/png', 'one.png');
    controller.attachImage(pngBytes, 'application/pdf', 'two.pdf');
    controller.setComposer(composerFrom('summarize'));

    await controller.submit();

    const draft = promptDraft(backend);
    expect(draft.text).toBe('summarize');
    expect(draft.files).toEqual([
      { uri: `data:image/png;base64,${pngData}`, name: 'one.png' },
      { uri: `data:application/pdf;base64,${pngData}`, name: 'two.pdf' },
    ]);
    expect(controller.state.attachments).toEqual([]);
    controller.dispose();
  });

  test('a route change while the session is being created cannot swap in other attachments', async () => {
    const backend = attachedBackend();
    const created = deferred<SessionSummary>();
    backend.createSessionHook = () => created.promise;
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();

    controller.attachImage(pngBytes, 'image/png', 'original.png');
    controller.setComposer(composerFrom('look at this'));
    const submitting = controller.submit();
    await flush();

    // The user wanders off to another session, attaching a different file there.
    controller.openSession('ses_a');
    controller.attachImage(pngBytes, 'image/png', 'elsewhere.png');
    created.resolve({
      ...fakeSession('ses_new'),
      directory: '/work/kohjoh',
    });
    await submitting;

    const prompt = backend.calls.find((call) => call.name === 'prompt');
    if (prompt === undefined || !isPromptDraft(prompt.args[1])) throw new Error('prompt missing');
    expect(prompt.args[1].files).toEqual([
      { uri: `data:image/png;base64,${pngData}`, name: 'original.png' },
    ]);
    // The other route's unsent draft is untouched by the send.
    controller.openSession('ses_a');
    expect(controller.state.attachments.map((attachment) => attachment.name)).toEqual([
      'elsewhere.png',
    ]);
    controller.dispose();
  });

  test('a rejected first prompt leaves its attachment retrievable, never silently dropped', async () => {
    const backend = new FakeBackend();
    backend.promptError = new Error('server unreachable');
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    controller.attachImage(pngBytes, 'image/png', 'shot.png');
    controller.setComposer(composerFrom('look at this'));

    await controller.submit();

    expect(backend.calls.filter((call) => call.name === 'prompt')).toHaveLength(1);
    expect(controller.state.attachments.map((attachment) => attachment.name)).toEqual(['shot.png']);
    expect(controller.state.composer.text).toBe('look at this');
    expect(controller.state.notice?.tone).toBe('error');
    controller.dispose();
  });

  test('a rejected session creation keeps the draft and its attachments', async () => {
    const backend = new FakeBackend();
    backend.createSessionError = new BackendError('transport', 'session.create', 'unreachable');
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    controller.attachImage(pngBytes, 'image/png', 'shot.png');
    controller.setComposer(composerFrom('look at this'));

    await controller.submit();

    expect(backend.calls.filter((call) => call.name === 'prompt')).toHaveLength(0);
    expect(controller.state.attachments.map((attachment) => attachment.name)).toEqual(['shot.png']);
    expect(controller.state.composer.text).toBe('look at this');
    expect(controller.state.notice?.tone).toBe('error');
    controller.dispose();
  });
});

describe('paste stays on its originating route (issue #87)', () => {
  test('a path paste delayed mid-read lands only in the originating session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marg-paste-'));
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a'), fakeSession('ses_b')];
    const controller = makeController(() => Promise.resolve([]), backend);
    try {
      const path = join(directory, 'shot.png').replaceAll('\\', '/');
      await writeFile(path, pngBytes);
      await attach(controller, 'ses_a');

      // Fire the paste without awaiting: it suspends on the first file read.
      const pastePromise = controller.pasteBytes(asBytes(path));

      // Switch to another session while the read is in flight.
      controller.openSession('ses_b');
      await flush();
      await pastePromise;

      // Only the originating draft received the attachment.
      expect(controller.state.composer.text).toBe('');
      expect(controller.state.attachments).toEqual([]);
      expect((controller.state.draftAttachments['ses_a'] ?? []).map((entry) => entry.name)).toEqual(
        ['shot.png'],
      );
      controller.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('multiline text switched mid-paste lands only in the originating draft', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a'), fakeSession('ses_b')];
    const controller = makeController(() => Promise.resolve([]), backend);
    await attach(controller, 'ses_a');

    const pastePromise = controller.pasteBytes(asBytes('line one\nline two'));

    controller.openSession('ses_b');
    await flush();
    await pastePromise;

    expect(controller.state.composer.text).toBe('');
    expect(controller.state.attachments).toEqual([]);
    expect(controller.state.drafts['ses_a']?.text).toBe('line one\nline two');
    controller.dispose();
  });

  test('a paste started in the overview survives a move to a new session', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    const controller = makeController(() => Promise.resolve([]), backend);
    await controller.bootstrap();
    controller.openOverview();
    await flush();

    const pastePromise = controller.pasteBytes(asBytes('overview text'));

    controller.startNewSession('/work/elsewhere');
    await flush();
    await pastePromise;

    expect(controller.state.composer.text).toBe('');
    expect(controller.state.attachments).toEqual([]);
    expect(controller.state.drafts['overview']?.text).toBe('overview text');
    controller.dispose();
  });

  test('multiple pasted files are stashed together as one group in the origin draft', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marg-paste-multi-'));
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a'), fakeSession('ses_b')];
    const controller = makeController(() => Promise.resolve([]), backend);
    try {
      const one = join(directory, 'one.png').replaceAll('\\', '/');
      const two = join(directory, 'two.png').replaceAll('\\', '/');
      await writeFile(one, pngBytes);
      await writeFile(two, pngBytes);
      await attach(controller, 'ses_a');

      const pastePromise = controller.pasteBytes(asBytes(`${one} ${two}`));

      controller.openSession('ses_b');
      await flush();
      await pastePromise;

      expect(controller.state.attachments).toEqual([]);
      expect((controller.state.draftAttachments['ses_a'] ?? []).map((entry) => entry.name)).toEqual(
        ['one.png', 'two.png'],
      );
      controller.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('a read failure reports an error, attaches nothing, and leaves other routes alone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marg-paste-big-'));
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a'), fakeSession('ses_b')];
    const controller = makeController(() => Promise.resolve([]), backend);
    try {
      const tooBig = join(directory, 'huge.png').replaceAll('\\', '/');
      await writeFile(tooBig, new Uint8Array(20 * 1024 * 1024 + 1));
      await attach(controller, 'ses_a');

      const pastePromise = controller.pasteBytes(asBytes(tooBig));

      controller.openSession('ses_b');
      await flush();
      await pastePromise;

      expect(controller.state.attachments).toEqual([]);
      expect((controller.state.draftAttachments['ses_a'] ?? []).length).toBe(0);
      expect(controller.state.notice?.text).toContain('larger than 20 MB');
      expect(controller.state.notice?.tone).toBe('warn');
      controller.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('a paste that resolves while an overlay is open does not change another route', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a'), fakeSession('ses_b')];
    const controller = makeController(() => Promise.resolve([]), backend);
    await attach(controller, 'ses_a');

    controller.setOverlay({ kind: 'help' });
    const pastePromise = controller.pasteBytes(asBytes('help text'));

    controller.openSession('ses_b');
    await flush();
    await pastePromise;

    expect(controller.state.composer.text).toBe('');
    expect(controller.state.attachments).toEqual([]);
    expect(controller.state.drafts['ses_a']?.text).toBe('help text');
    controller.dispose();
  });
});

/** Minimal ASCII-only PDF: valid header and trailer, entirely UTF-8 decodable. */
const asciiPdfBytes = () =>
  asBytes(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
  );

const sharedOnHost = (serverID: string) => ({
  ...fakeSession('ses_shared'),
  serverID,
  directory: '/work/kohjoh',
});

describe('binary paste ownership and classification (#154, #155)', () => {
  test('a queued raw binary paste stays on the originating host, not the destination', async () => {
    const a = new FakeBackend();
    a.serverID = 'srv_a';
    const b = new FakeBackend();
    b.serverID = 'srv_b';
    a.sessions = [sharedOnHost('srv_a')];
    b.sessions = [sharedOnHost('srv_b')];
    const controller = routingController({ srv_a: a, srv_b: b }, 'srv_a');
    await controller.bootstrap();
    controller.openSession('ses_shared', 'srv_a');
    await flush();

    const origin = sessionKey({ serverID: 'srv_a', sessionID: 'ses_shared' });
    const destination = sessionKey({ serverID: 'srv_b', sessionID: 'ses_shared' });
    expect(destination).not.toBe(origin);

    const paste = controller.pasteBytes(pngBytes);
    controller.openSession('ses_shared', 'srv_b');
    await flush();
    await paste;

    expect(controller.state.attachments).toEqual([]);
    expect(controller.state.draftAttachments[destination]).toBeUndefined();
    expect(controller.state.draftAttachments[origin]?.map((entry) => entry.name)).toEqual([
      'clipboard.png',
    ]);

    controller.openSession('ses_shared', 'srv_a');
    await flush();
    expect(controller.state.attachments.map((entry) => entry.name)).toEqual(['clipboard.png']);
    controller.dispose();
  });

  test('a UTF-8 decodable PDF becomes an attachment, not inserted source text', async () => {
    const controller = makeController(() => Promise.resolve([]), attachedBackend());
    await attach(controller, 'ses_a');

    await controller.pasteBytes(asciiPdfBytes());

    expect(controller.state.composer.text).toBe('');
    expect(controller.state.attachments.map((entry) => entry.name)).toEqual(['clipboard.pdf']);
    expect(controller.state.attachments.map((entry) => entry.mime)).toEqual(['application/pdf']);
    controller.dispose();
  });

  test('text beginning with %PDF- stays text unless it is really a PDF', async () => {
    const controller = makeController(() => Promise.resolve([]), attachedBackend());
    await attach(controller, 'ses_a');

    const text = '%PDF-1.4 is just a header written in a sentence.';
    await controller.pasteBytes(asBytes(text));

    expect(controller.state.composer.text).toBe(text);
    expect(controller.state.attachments).toEqual([]);
    controller.dispose();
  });

  test('clipboard metadata decides text vs binary for signature-looking bytes', async () => {
    const controller = makeController(() => Promise.resolve([]), attachedBackend());
    await attach(controller, 'ses_a');

    await controller.pasteBytes(asciiPdfBytes(), { kind: 'text', mimeType: 'text/plain' });
    expect(controller.state.composer.text).toContain('%PDF-1.4');
    expect(controller.state.attachments).toEqual([]);

    await controller.pasteBytes(pngBytes, { kind: 'binary', mimeType: 'image/png' });
    expect(controller.state.attachments.map((entry) => entry.mime)).toEqual(['image/png']);
    controller.dispose();
  });

  test('binary image signatures other than PNG still become chips', async () => {
    const controller = makeController(() => Promise.resolve([]), attachedBackend());
    await attach(controller, 'ses_a');

    await controller.pasteBytes(asBytes('GIF89a'));

    expect(controller.state.composer.text).toBe('');
    expect(controller.state.attachments.map((entry) => entry.mime)).toEqual(['image/gif']);
    controller.dispose();
  });

  test('unsupported binary declared by the clipboard never creates a chip or erases text', async () => {
    const controller = makeController(() => Promise.resolve([]), attachedBackend());
    await attach(controller, 'ses_a');
    controller.setComposer(composerFrom('keep me'));

    await controller.pasteBytes(new Uint8Array([0, 1, 2, 250]), { kind: 'binary' });

    expect(controller.state.attachments).toEqual([]);
    expect(controller.state.composer.text).toBe('keep me');
    expect(controller.state.notice?.text).toContain('not text or a supported image');
    controller.dispose();
  });
});

function adminHarness() {
  const calls: string[] = [];
  const listings = [
    {
      serverID: 'local',
      label: 'local',
      baseUrl: 'http://localhost:4096',
      state: 'online',
      active: true,
    },
    {
      serverID: 'srv_1',
      label: 'buildbox',
      baseUrl: 'https://build.example.com',
      state: 'online',
      active: false,
    },
  ];
  return {
    calls,
    listings,
    admin: {
      list: () => listings,
      rename: async (serverID: string, label: string) => {
        calls.push(`rename:${serverID}:${label}`);
        return listings;
      },
      unpair: async (serverID: string) => {
        calls.push(`unpair:${serverID}`);
      },
    },
  };
}

function controllerWith(admin: ReturnType<typeof adminHarness>['admin']) {
  return new AppController({
    backend: new FakeBackend(),
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    requestExit: () => {},
    serverAdmin: admin,
  });
}

describe('server management commands', () => {
  test('/servers opens the server list and rename keeps identity', async () => {
    const harness = adminHarness();
    const controller = controllerWith(harness.admin);
    controller.setComposer(composerFrom('/servers'));
    await controller.submit();
    expect(controller.state.overlay).toEqual({ kind: 'servers', index: 0 });

    controller.closeOverlay();
    controller.setComposer(composerFrom('/servers rename buildbox devbox'));
    await controller.submit();
    expect(harness.calls).toEqual(['rename:srv_1:devbox']);
    controller.dispose();
  });

  test('/unpair of another server removes only its cached state', async () => {
    const harness = adminHarness();
    const controller = controllerWith(harness.admin);
    const remoteSession = {
      ...fakeSession('ses_a'),
      serverID: 'srv_1',
    };
    const key = 'server:srv_1/session:ses_a';
    controller.state.sessions[key] = remoteSession;
    controller.state.running[key] = true;
    controller.state.serverPages['srv_1'] = { complete: true, loading: false };

    controller.setComposer(composerFrom('/unpair buildbox'));
    await controller.submit();
    expect(harness.calls).toEqual(['unpair:srv_1']);
    expect(controller.state.sessions[key]).toBeUndefined();
    expect(controller.state.running[key]).toBeUndefined();
    expect(controller.state.serverPages['srv_1']).toBeUndefined();
    controller.dispose();
  });

  test('/unpair of the active server refuses to unpair the launch server', async () => {
    const harness = adminHarness();
    const controller = controllerWith(harness.admin);
    controller.setComposer(composerFrom('/unpair local'));
    await controller.submit();
    expect(controller.state.overlay).toEqual({ kind: 'none' });
    expect(harness.calls).toEqual([]);
    expect(controller.state.notice?.text).toContain(
      'Cannot unpair the launch/server you are currently connected to',
    );
    controller.dispose();
  });

  test('the /servers command never goes to the agent inbox', async () => {
    const harness = adminHarness();
    const backend = new FakeBackend();
    const controller = new AppController({
      backend,
      config: defaultConfig,
      localState: emptyState,
      platform: 'linux',
      cwd: '/work/kohjoh',
      version: '0.0.1',
      now: () => 10_000,
      saveLocalState: async () => {},
      listFiles: () => Promise.resolve([]),
      requestExit: () => {},
      serverAdmin: harness.admin,
    });
    controller.setComposer(composerFrom('/servers'));
    await controller.submit();
    expect(backend.calls).toEqual([]);
    controller.dispose();
  });
});

function platformController({
  platform = 'win32',
  remoteFilesystem = false,
  platformFor,
}: {
  platform?: NodeJS.Platform;
  remoteFilesystem?: boolean;
  platformFor?: (serverID: string) => NodeJS.Platform | undefined;
} = {}) {
  return new AppController({
    backend: new FakeBackend(),
    config: defaultConfig,
    localState: emptyState,
    platform,
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    remoteFilesystem,
    requestExit: () => {},
    ...(platformFor === undefined ? {} : { platformFor }),
  });
}

describe('platform style is the owning server’s, not the frontend’s (issue #84)', () => {
  test('a local launch host uses the frontend OS', () => {
    const controller = platformController({ platform: 'win32', remoteFilesystem: false });
    expect(controller.platformFor('local')).toBe('win32');
    controller.dispose();
  });

  test('a remote launch host without a recorded platform degrades to POSIX, not the frontend OS', () => {
    const controller = platformController({ platform: 'win32', remoteFilesystem: true });
    expect(controller.platformFor('local')).toBe('linux');
    controller.dispose();
  });

  test('a remote launch host with a recorded win32 profile uses win32', () => {
    const controller = platformController({
      platform: 'linux',
      remoteFilesystem: true,
      platformFor: () => 'win32',
    });
    expect(controller.platformFor('local')).toBe('win32');
    controller.dispose();
  });

  test('a remote launch host with a recorded linux profile keeps /srv/App and /srv/app distinct', () => {
    const controller = platformController({
      platform: 'win32',
      remoteFilesystem: true,
      platformFor: () => 'linux',
    });
    expect(controller.platformFor('local')).toBe('linux');
    expect(directoryKey('/srv/App', controller.platformFor('local'))).not.toBe(
      directoryKey('/srv/app', controller.platformFor('local')),
    );
    controller.dispose();
  });

  test('a paired server keeps its advertised platform while the launch host keeps its own', () => {
    const controller = platformController({
      platform: 'win32',
      remoteFilesystem: false,
      platformFor: (serverID) => (serverID === 'srv_1' ? 'linux' : undefined),
    });
    expect(controller.platformFor('local')).toBe('win32');
    expect(controller.platformFor('srv_1')).toBe('linux');
    controller.dispose();
  });
});

describe('server routing', () => {
  test('session actions use the owning backend, never another server', async () => {
    const local = new FakeBackend();
    const remote = new FakeBackend();
    const controller = new AppController({
      backend: local,
      backendFor: (serverID: string) => (serverID === 'srv_1' ? remote : local),
      config: defaultConfig,
      localState: emptyState,
      platform: 'linux',
      cwd: '/work/kohjoh',
      version: '0.0.1',
      now: () => 10_000,
      saveLocalState: async () => {},
      listFiles: () => Promise.resolve([]),
      requestExit: () => {},
    });
    const key = 'server:srv_1/session:ses_a';
    controller.state.sessions[key] = { ...fakeSession('ses_a'), serverID: 'srv_1' };
    controller.openSession('ses_a', 'srv_1');
    controller.setComposer(composerFrom('hello'));
    await controller.submit();

    expect(remote.calls.some((call) => call.name === 'prompt')).toBe(true);
    expect(local.calls.some((call) => call.name === 'prompt')).toBe(false);
    expect(controller.state.route).toEqual({
      kind: 'conversation',
      serverID: 'srv_1',
      sessionID: 'ses_a',
    });
    controller.dispose();
  });
});

function escKey() {
  return { name: 'escape', ctrl: false, alt: false, shift: false };
}

describe('escape key handling (issue #90)', () => {
  const services = { openEditor: () => {}, redraw: () => {}, scroll: () => {} };

  test('Esc while running interrupts once and preserves an empty draft', async () => {
    const { backend, controller } = conversationFixture();
    await attach(controller, 'ses_a');
    controller.onEvents(
      'local',
      [{ kind: 'execution', sessionID: 'ses_a', state: 'started' }],
      false,
    );
    controller.setComposer(composerFrom(''));

    const { keymap } = buildKeymap({});
    expect(routeKey(controller, keymap, escKey(), services)).toBe(true);
    await flush();

    expect(backend.calls.filter((call) => call.name === 'interrupt')).toHaveLength(1);
    expect(controller.state.composer.text).toBe('');
    expect(controller.state.notice?.text).toContain('Interrupted');
    controller.dispose();
  });

  test('Esc while running interrupts once and preserves a nonempty draft', async () => {
    const { backend, controller } = conversationFixture();
    await attach(controller, 'ses_a');
    controller.onEvents(
      'local',
      [{ kind: 'execution', sessionID: 'ses_a', state: 'started' }],
      false,
    );
    controller.setComposer(composerFrom('my draft'));

    const { keymap } = buildKeymap({});
    routeKey(controller, keymap, escKey(), services);
    await flush();

    expect(backend.calls.filter((call) => call.name === 'interrupt')).toHaveLength(1);
    expect(controller.state.composer.text).toBe('my draft');
    controller.dispose();
  });

  test('Idle Esc does not interrupt and preserves the draft', async () => {
    const { backend, controller } = conversationFixture();
    await attach(controller, 'ses_a');
    controller.setComposer(composerFrom('my draft'));

    const { keymap } = buildKeymap({});
    routeKey(controller, keymap, escKey(), services);
    await flush();

    expect(backend.calls.filter((call) => call.name === 'interrupt')).toHaveLength(0);
    expect(controller.state.composer.text).toBe('my draft');
    controller.dispose();
  });

  test('Double-Esc on an idle nonempty draft clears it with safe restore', async () => {
    const { backend, controller } = conversationFixture();
    await attach(controller, 'ses_a');
    controller.setComposer(composerFrom('my draft'));

    const { keymap } = buildKeymap({});
    routeKey(controller, keymap, escKey(), services);
    routeKey(controller, keymap, escKey(), services);
    await flush();

    expect(controller.state.composer.text).toBe('');
    expect(Object.values(controller.state.stashes).find(Boolean)?.composer.text).toBe('my draft');
    expect(controller.state.notice?.text).toContain('stashed');
    expect(backend.calls.filter((call) => call.name === 'interrupt')).toHaveLength(0);
    controller.dispose();
  });

  test('Double-Esc on an idle empty composer enters rewind selection without mutating files', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = {
      ses_a: [
        {
          kind: 'user',
          id: 'u1',
          createdAt: 1,
          text: 'earlier prompt',
          attachments: [],
        },
      ],
    };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    controller.setComposer(composerFrom(''));

    const { keymap } = buildKeymap({});
    routeKey(controller, keymap, escKey(), services);
    routeKey(controller, keymap, escKey(), services);
    await flush();

    expect(controller.state.rewindPending).toBe(true);
    expect(controller.state.overlay.kind).toBe('rewind-picker');
    expect(controller.state.composer.text).toBe('');
    expect(backend.calls.filter((call) => call.name === 'interrupt')).toHaveLength(0);
    expect(backend.calls.some((call) => call.name === 'stageRevert')).toBe(false);
    controller.dispose();
  });

  test('A second Esc outside the double-tap window is a single tap, not rewind/clear', async () => {
    let now = 10_000;
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    const controller = makeController(
      () => Promise.resolve([]),
      backend,
      () => now,
    );
    await attach(controller, 'ses_a');
    controller.setComposer(composerFrom('my draft'));

    const { keymap } = buildKeymap({});
    routeKey(controller, keymap, escKey(), services);
    now = 10_500; // past the 400 ms double-tap window
    routeKey(controller, keymap, escKey(), services);
    await flush();

    expect(controller.state.rewindPending).toBe(false);
    expect(Object.values(controller.state.stashes).filter(Boolean)).toHaveLength(0);
    expect(controller.state.composer.text).toBe('my draft');
    expect(backend.calls.filter((call) => call.name === 'interrupt')).toHaveLength(0);
    controller.dispose();
  });

  test('Esc while an overlay is open closes the overlay and never interrupts', async () => {
    const { backend, controller } = conversationFixture();
    await attach(controller, 'ses_a');
    controller.onEvents(
      'local',
      [{ kind: 'execution', sessionID: 'ses_a', state: 'started' }],
      false,
    );
    controller.setOverlay({ kind: 'help' });

    const { keymap } = buildKeymap({});
    routeKey(controller, keymap, escKey(), services);
    await flush();

    expect(controller.state.overlay.kind).toBe('none');
    expect(backend.calls.filter((call) => call.name === 'interrupt')).toHaveLength(0);
    controller.dispose();
  });

  test('Esc while a permission card is pending rejects it and never interrupts', async () => {
    const { backend, controller } = conversationFixture();
    await attach(controller, 'ses_a');
    controller.onEvents(
      'local',
      [{ kind: 'execution', sessionID: 'ses_a', state: 'started' }],
      false,
    );
    backend.permissions = [
      { id: 'p1', sessionID: 'ses_a', action: 'run shell', resources: [], save: [] },
    ];
    controller.onEvents('local', [{ kind: 'input-requests-changed', sessionID: 'ses_a' }], false);
    await flush();
    expect(controller.pendingPermission()).toBeDefined();

    const { keymap } = buildKeymap({});
    routeKey(controller, keymap, escKey(), services);
    await flush();

    expect(backend.calls.filter((call) => call.name === 'interrupt')).toHaveLength(0);
    controller.dispose();
  });
});

describe('copy picker (#105)', () => {
  test('copies exact tool output bytes and reports the truncation boundary', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = {
      ses_a: [
        {
          kind: 'assistant',
          id: 'm1',
          createdAt: 1,
          agent: 'build',
          model: { providerID: 'p', modelID: 'm' },
          parts: [
            {
              kind: 'tool',
              tool: {
                id: 't1',
                name: 'shell',
                status: 'completed',
                input: {},
                startedAt: 0,
                output: 'line one\nline two',
                outputTruncated: 'frontend',
              },
            },
          ],
        },
      ],
    };
    const copied: string[] = [];
    const controller = new AppController({
      backend,
      config: defaultConfig,
      localState: emptyState,
      platform: 'linux',
      cwd: '/work/kohjoh',
      version: '0.0.1',
      now: () => 10_000,
      saveLocalState: async () => {},
      listFiles: () => Promise.resolve([]),
      requestExit: () => {},
      copyText: async (text) => {
        copied.push(text);
        return { method: 'clipboard' };
      },
    });
    await attach(controller, 'ses_a');
    controller.openCopyPicker();
    expect(controller.copyChoices('').map((item) => item.kind)).toEqual(['output']);
    await controller.acceptCopyPicker();
    expect(copied).toEqual(['line one\nline two']);
    expect(controller.state.notice?.text).toContain('UI cap');
    controller.dispose();
  });

  test('the file fallback uses a client-local directory, never the remote cwd (#153)', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = {
      ses_a: [
        {
          kind: 'assistant',
          id: 'm1',
          createdAt: 1,
          agent: 'build',
          model: { providerID: 'p', modelID: 'm' },
          parts: [
            {
              kind: 'tool',
              tool: {
                id: 't1',
                name: 'shell',
                status: 'completed',
                input: {},
                startedAt: 0,
                output: 'exact payload',
              },
            },
          ],
        },
      ],
    };
    const written: { path: string; text: string }[] = [];
    const controller = new AppController({
      backend,
      config: defaultConfig,
      localState: emptyState,
      platform: 'linux',
      cwd: '/srv/remote-project',
      version: '0.0.1',
      now: () => 10_000,
      saveLocalState: async () => {},
      listFiles: () => Promise.resolve([]),
      requestExit: () => {},
      copyFallbackDir: '/local/client-state',
      writeFile: async (path, text) => {
        written.push({ path, text });
      },
    });
    await attach(controller, 'ses_a');
    controller.openCopyPicker();
    await controller.acceptCopyPicker();
    expect(written).toHaveLength(1);
    // node:path.join uses the host separator, so assert on path-agnostic segments.
    expect(written[0]?.path).toContain('client-state');
    expect(written[0]?.path).toContain('marg-copy-');
    expect(written[0]?.path).not.toContain('remote-project');
    expect(written[0]?.text).toBe('exact payload');
    expect(controller.state.notice?.text).toContain('client-state');
    controller.dispose();
  });
});

function pickerBackend(): FakeBackend {
  const backend = new FakeBackend();
  backend.agents = [agentFor('zeta'), agentFor('build'), agentFor('review')];
  backend.sessions = [fakeSession('ses_a')];
  return backend;
}

describe('agent picker and deterministic cycle (#123)', () => {
  test('/agent opens the searchable picker; Enter selects via switchAgent', async () => {
    const backend = pickerBackend();
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    await submitCommand(controller, '/agent');
    expect(controller.state.overlay.kind).toBe('agent-picker');
    expect(controller.agentChoices('').map((agent) => agent.id)).toEqual([
      'build',
      'review',
      'zeta',
    ]);

    controller.setAgentPickerQuery('rev');
    expect(controller.agentChoices('rev').map((agent) => agent.id)).toEqual(['review']);
    await controller.acceptAgentPicker();
    expect(controller.state.overlay.kind).toBe('none');
    expect(backend.calls.find((call) => call.name === 'switchAgent')?.args).toEqual([
      'ses_a',
      'review',
    ]);
    controller.dispose();
  });

  test('the picker navigates in both directions without losing the draft', async () => {
    const backend = pickerBackend();
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    await controller.openAgentPicker();
    controller.setComposer(composerFrom('keep this draft'));
    const overlay = controller.state.overlay;
    if (overlay.kind !== 'agent-picker') throw new Error('agent picker did not open');
    controller.moveAgentPicker(-1);
    expect(controller.state.overlay).toMatchObject({ index: 2 });
    controller.moveAgentPicker(1);
    expect(controller.state.overlay).toMatchObject({ index: 0 });
    expect(controller.state.composer.text).toBe('keep this draft');
    controller.dispose();
  });

  test('pickers open on the current agent, model and effort instead of row zero (#246)', async () => {
    const backend = pickerBackend();
    backend.models = [
      { providerID: 'p', modelID: 'aaa', name: 'AAA', enabled: true, variants: [] },
      {
        providerID: 'p',
        modelID: 'bbb',
        name: 'BBB',
        enabled: true,
        variants: ['low', 'high'],
      },
    ];
    backend.sessions = [
      {
        ...fakeSession('ses_a'),
        agent: 'zeta',
        model: { providerID: 'p', modelID: 'bbb', variant: 'high' },
      },
    ];
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');

    // Sorted choices are build, review, zeta; the active zeta must not open on row zero.
    await controller.openAgentPicker();
    expect(controller.state.overlay).toMatchObject({ kind: 'agent-picker', index: 2 });
    controller.closeOverlay();

    await controller.openModelPicker();
    expect(controller.state.overlay).toMatchObject({ kind: 'model-picker', index: 1 });
    controller.closeOverlay();

    await controller.openEffortPicker();
    expect(controller.state.overlay).toMatchObject({ kind: 'effort-picker', index: 2 });
    controller.dispose();
  });

  test('Shift+Tab cycles the full deterministic set with shuffled backend results', async () => {
    const backend = pickerBackend();
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    await controller.cycleAgent(1);
    expect(backend.calls.find((call) => call.name === 'switchAgent')?.args[1]).toBe('review');
    controller.dispose();
  });

  test('a rejected switch restores the previously confirmed agent', async () => {
    const backend = pickerBackend();
    backend.switchAgent = async () => {
      throw new Error('denied');
    };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    const before = controller.currentSession()?.agent;
    await controller.openAgentPicker();
    controller.setAgentPickerQuery('rev');
    await controller.acceptAgentPicker();
    expect(controller.currentSession()?.agent).toBe(before);
    controller.dispose();
  });
});

describe('background worker lifecycle (#101)', () => {
  const jobs = [
    {
      id: 'job_a',
      childSessionID: 'child_a',
      agent: 'build',
      description: 'review patch',
      status: 'running' as const,
      startedAt: 1000,
    },
    {
      id: 'job_b',
      childSessionID: 'child_b',
      agent: 'plan',
      description: 'audit tests',
      status: 'error' as const,
      startedAt: 2000,
      completedAt: 4000,
    },
  ];

  test('two concurrent workers are projected with identity and status, and are focusable', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [] };
    backend.jobs = { ses_a: jobs };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');

    const rows = controller.workerNodes('ses_a', 'local');
    expect(rows.map((row) => row.worker.childSessionID)).toEqual(['child_a', 'child_b']);
    expect(rows.map((row) => row.worker.status)).toEqual(['running', 'error']);
    expect(controller.collapsibleItems()).toEqual([
      { key: 'worker:job_a', kind: 'worker' },
      { key: 'worker:job_b', kind: 'worker' },
    ]);
    controller.moveGroupFocus(1);
    expect(controller.state.focusedGroup).toBe('worker:job_a');
    controller.toggleFocusedGroup();
    expect(controller.workerNodes('ses_a', 'local')[0]?.expanded).toBe(true);
    controller.dispose();
  });

  test('a failed first refresh reports unavailable without inventing a ghost worker', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [] };
    backend.jobs = { ses_a: jobs };
    let attempts = 0;
    backend.listSubagentJobs = async () => {
      attempts += 1;
      throw new Error('unsupported RPC');
    };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');

    expect(attempts).toBeGreaterThan(0);
    expect(controller.workerNodes('ses_a', 'local')).toEqual([]);
    expect(controller.workerJobStatus('ses_a', 'local')?.state).toBe('unavailable');
    expect(controller.workerJobStatus('ses_a', 'local')?.detail).toContain('unsupported RPC');
    controller.dispose();
  });

  test('a failed refresh retains the last confirmed crew and a later empty list removes it (#230)', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [] };
    backend.jobs = { ses_a: jobs };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    expect(controller.workerNodes('ses_a', 'local')).toHaveLength(2);
    expect(controller.workerJobStatus('ses_a', 'local')?.state).toBe('confirmed');

    backend.listSubagentJobs = async () => {
      throw new Error('timed out after 10000ms');
    };
    controller.onEvents(
      'local',
      [{ kind: 'transcript-changed', sessionID: 'ses_a', jobs: true }],
      false,
    );
    await flush();
    expect(controller.workerNodes('ses_a', 'local')).toHaveLength(2);
    expect(controller.workerJobStatus('ses_a', 'local')?.state).toBe('stale');
    expect(controller.workerJobStatus('ses_a', 'local')?.detail).toContain('timed out');

    backend.listSubagentJobs = async () => [];
    controller.onEvents(
      'local',
      [{ kind: 'transcript-changed', sessionID: 'ses_a', jobs: true }],
      false,
    );
    // The previous transcript refresh is inside its coalescing delay; let the dirty rerun start.
    await Bun.sleep(120);
    await flush();
    expect(controller.workerNodes('ses_a', 'local')).toEqual([]);
    expect(controller.workerJobStatus('ses_a', 'local')?.state).toBe('confirmed');
    controller.dispose();
  });

  test('a failed shell refresh keeps a still-running timed-out shell stale (#230)', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [] };
    const shell = {
      id: 'shell_1',
      shellID: 'shell_a',
      sessionID: 'ses_a',
      status: 'running' as const,
      startedAt: 1000,
    };
    backend.shellJobs = { ses_a: [shell] };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    expect(controller.state.shellJobs['ses_a']).toHaveLength(1);
    expect(controller.shellJobStatus('ses_a', 'local')?.state).toBe('confirmed');

    backend.listShellJobs = async () => {
      throw new Error('connection reset');
    };
    controller.onEvents(
      'local',
      [{ kind: 'transcript-changed', sessionID: 'ses_a', jobs: true }],
      false,
    );
    await flush();
    expect(controller.state.shellJobs['ses_a']).toHaveLength(1);
    expect(controller.shellJobStatus('ses_a', 'local')?.state).toBe('stale');
    controller.dispose();
  });

  test('text-only transcript updates do not re-list jobs; job hints do (#284)', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [] };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    const calls = (name: string) => backend.calls.filter((call) => call.name === name).length;
    const workers = calls('listSubagentJobs');
    const shells = calls('listShellJobs');

    for (let index = 0; index < 5; index += 1) {
      controller.onEvents('local', [{ kind: 'transcript-changed', sessionID: 'ses_a' }], false);
    }
    await Bun.sleep(250);
    await flush();
    expect(calls('listSubagentJobs')).toBe(workers);
    expect(calls('listShellJobs')).toBe(shells);

    controller.onEvents(
      'local',
      [{ kind: 'transcript-changed', sessionID: 'ses_a', jobs: true }],
      false,
    );
    await Bun.sleep(150);
    await flush();
    expect(calls('listSubagentJobs')).toBeGreaterThan(workers);
    expect(calls('listShellJobs')).toBeGreaterThan(shells);
    controller.dispose();
  });

  test('a tool call probes jobs now and once after registration delay (#297)', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [] };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    const calls = (name: string) => backend.calls.filter((call) => call.name === name).length;
    const workers = calls('listSubagentJobs');

    controller.onEvents(
      'local',
      [{ kind: 'transcript-changed', sessionID: 'ses_a', jobProbe: true }],
      false,
    );
    await Bun.sleep(120);
    await flush();
    const afterImmediate = calls('listSubagentJobs');
    expect(afterImmediate).toBeGreaterThan(workers);

    // A tool's job can register after the call event; the deferred probe catches it.
    await Bun.sleep(300);
    await flush();
    expect(calls('listSubagentJobs')).toBeGreaterThan(afterImmediate);

    // Progress and text deltas never add another probe.
    const settled = calls('listSubagentJobs');
    for (let index = 0; index < 20; index += 1) {
      controller.onEvents('local', [{ kind: 'transcript-changed', sessionID: 'ses_a' }], false);
    }
    await Bun.sleep(250);
    await flush();
    expect(calls('listSubagentJobs')).toBe(settled);
    controller.dispose();
  });

  test('a deleted session drops a pending tool-start job probe (#297)', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [] };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    const calls = (name: string) => backend.calls.filter((call) => call.name === name).length;
    const workers = calls('listSubagentJobs');

    controller.onEvents(
      'local',
      [{ kind: 'transcript-changed', sessionID: 'ses_a', jobProbe: true }],
      false,
    );
    await Bun.sleep(120);
    await flush();
    const afterImmediate = calls('listSubagentJobs');
    expect(afterImmediate).toBeGreaterThan(workers);
    controller.onEvents('local', [{ kind: 'session-deleted', sessionID: 'ses_a' }], false);
    await Bun.sleep(400);
    await flush();
    expect(calls('listSubagentJobs')).toBe(afterImmediate);
    controller.dispose();
  });

  test('detach keeps last confirmed workers stale and resync reconciles from the server', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [] };
    backend.jobs = { ses_a: jobs };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    expect(controller.workerNodes('ses_a', 'local')).toHaveLength(2);

    controller.onStreamStatus('local', 'reconnecting');
    expect(controller.workerNodes('ses_a', 'local')).toHaveLength(2);
    expect(controller.workerJobStatus('ses_a', 'local')?.state).toBe('stale');

    // The server finished one worker while we were detached; only the finished one returns.
    backend.jobs = { ses_a: [{ ...jobs[0]!, status: 'completed' as const }] };
    controller.onStreamStatus('local', 'live');
    await flush();

    const rows = controller.workerNodes('ses_a', 'local');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.worker.status).toBe('completed');
    expect(controller.workerJobStatus('ses_a', 'local')?.state).toBe('confirmed');
    controller.dispose();
  });
});

describe('failed transcript refresh retains and drains queued work (#295)', () => {
  test('an update received during a failed read lands after bounded recovery', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [userMessage('m1', 'first')] };
    const controller = makeController(
      async () => [],
      backend,
      () => 10_000,
      {
        transcriptRetryBaseDelayMs: 10,
      },
    );
    await attach(controller, 'ses_a');

    const real = backend.listMessages.bind(backend);
    const gate = deferred<void>();
    let attempts = 0;
    backend.listMessages = async (sessionID, limit, cursor) => {
      attempts += 1;
      if (attempts === 1) {
        await gate.promise;
        throw new BackendError('transport', 'message.list', 'temporary disconnect');
      }
      return real(sessionID, limit, cursor);
    };

    controller.onEvents('local', [{ kind: 'transcript-changed', sessionID: 'ses_a' }], false);
    await flush();
    // The second update arrives while the first read is still in flight.
    backend.messages = { ses_a: [userMessage('m1', 'first'), userMessage('m2', 'second')] };
    controller.onEvents(
      'local',
      [{ kind: 'transcript-changed', sessionID: 'ses_a', jobs: true }],
      false,
    );
    gate.resolve();
    await Bun.sleep(150);
    await flush();

    expect(attempts).toBeGreaterThanOrEqual(2);
    const messages = controller.state.transcripts['ses_a']?.messages ?? [];
    expect(messages.some((message) => message.id === 'm2')).toBe(true);
    expect(controller.state.transcripts['ses_a']?.stale).toBe(false);
    // The job hint was not lost when the transcript read failed.
    expect(backend.calls.some((call) => call.name === 'listSubagentJobs')).toBe(true);
    controller.dispose();
  });

  test('a persistent outage retries a bounded number of times and keeps the last transcript', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [userMessage('m1', 'first')] };
    const controller = makeController(
      async () => [],
      backend,
      () => 10_000,
      {
        transcriptRetryBaseDelayMs: 5,
      },
    );
    await attach(controller, 'ses_a');

    let attempts = 0;
    backend.listMessages = async () => {
      attempts += 1;
      throw new BackendError('transport', 'message.list', 'host is down');
    };
    controller.onEvents('local', [{ kind: 'transcript-changed', sessionID: 'ses_a' }], false);
    await Bun.sleep(150);
    await flush();

    // One attempt plus the three bounded retries; no endless fast loop.
    expect(attempts).toBe(4);
    expect(controller.state.transcripts['ses_a']?.messages.map((message) => message.id)).toEqual([
      'm1',
    ]);
    expect(controller.state.transcripts['ses_a']?.stale).toBe(true);
    controller.dispose();
  });

  test('a permanent failure does not retry and does not strand the next update', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [userMessage('m1', 'first')] };
    const controller = makeController(
      async () => [],
      backend,
      () => 10_000,
      {
        transcriptRetryBaseDelayMs: 5,
      },
    );
    await attach(controller, 'ses_a');

    const real = backend.listMessages.bind(backend);
    let attempts = 0;
    backend.listMessages = async () => {
      attempts += 1;
      throw new BackendError('not-found', 'message.list', 'session is gone');
    };
    controller.onEvents('local', [{ kind: 'transcript-changed', sessionID: 'ses_a' }], false);
    await Bun.sleep(60);
    await flush();
    expect(attempts).toBe(1);
    expect(controller.state.transcripts['ses_a']?.stale).toBe(true);

    // The dirty flag was drained when the failure settled, so a later event is a fresh read.
    backend.listMessages = real;
    backend.messages = { ses_a: [userMessage('m1', 'first'), userMessage('m2', 'second')] };
    controller.onEvents('local', [{ kind: 'transcript-changed', sessionID: 'ses_a' }], false);
    await Bun.sleep(120);
    await flush();
    expect(
      (controller.state.transcripts['ses_a']?.messages ?? []).some(
        (message) => message.id === 'm2',
      ),
    ).toBe(true);
    expect(controller.state.transcripts['ses_a']?.stale).toBe(false);
    controller.dispose();
  });
});

describe('transcript flight identity across session recreation (#333)', () => {
  test('a read that outlives its session cannot erase the replacement session transcript', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [userMessage('m1', 'first')] };
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');

    const real = backend.listMessages.bind(backend);
    const gate = deferred<void>();
    let reads = 0;
    let gated = false;
    backend.listMessages = async (sessionID, limit, cursor) => {
      reads += 1;
      if (!gated) {
        gated = true;
        await gate.promise;
        return { messages: [] };
      }
      return real(sessionID, limit, cursor);
    };
    controller.onEvents('local', [{ kind: 'transcript-changed', sessionID: 'ses_a' }], false);
    await flush();
    expect(reads).toBe(1);

    // The old read is still blocked; delete and recreate the same server/session ID.
    controller.onEvents('local', [{ kind: 'session-deleted', sessionID: 'ses_a' }], false);
    backend.sessions = [fakeSession('ses_a')];
    await controller.loadSessions();
    controller.openSession('ses_a');
    await flush();
    expect(reads).toBe(2);

    gate.resolve();
    await flush();
    const messages = controller.state.transcripts['ses_a']?.messages ?? [];
    expect(messages.some((message) => message.id === 'm1')).toBe(true);
    // The retired read cannot drain the new flight's hints into another fetch.
    expect(reads).toBe(2);
    controller.dispose();
  });
});

describe('job state lifecycle on disconnect and removal (#136)', () => {
  const remoteJob: WorkerJob = {
    id: 'job_r',
    childSessionID: 'child_r',
    agent: 'build',
    description: 'remote work',
    status: 'running',
    startedAt: 1000,
  };

  test('a remote host disconnect clears only that host live-looking workers', async () => {
    const { controller, backendA, backendB } = twoHostController();
    backendA.jobs = { ses_a: [remoteJob] };
    backendB.jobs = { ses_b: [remoteJob] };
    await controller.bootstrap();
    controller.openSession('ses_a', 'local');
    await flush();
    controller.openSession('ses_b', 'srv_1');
    await flush();
    expect(controller.workerNodes('ses_a', 'local')).toHaveLength(1);
    expect(controller.workerNodes('ses_b', 'srv_1')).toHaveLength(1);

    controller.onStreamStatus('srv_1', 'reconnecting');
    // The remote rows stay visible but are explicitly stale; the local host is untouched.
    expect(controller.workerNodes('ses_b', 'srv_1')).toHaveLength(1);
    expect(controller.workerJobStatus('ses_b', 'srv_1')?.state).toBe('stale');
    expect(controller.workerNodes('ses_a', 'local')).toHaveLength(1);
    expect(controller.workerJobStatus('ses_a', 'local')?.state).toBe('confirmed');
    controller.dispose();
  });

  test('a delayed worker refresh after deletion cannot resurrect rows', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: [] };
    const delayed = deferred<readonly WorkerJob[]>();
    backend.listSubagentJobs = () => delayed.promise;
    const controller = makeController(async () => [], backend);
    await attach(controller, 'ses_a');
    // A refresh is in flight. The session is deleted before it resolves.
    controller.onEvents('local', [{ kind: 'session-deleted', sessionID: 'ses_a' }], false);
    delayed.resolve([remoteJob]);
    await flush();
    expect(controller.state.workers['ses_a']).toBeUndefined();
    controller.dispose();
  });

  test('a first pending job refresh with no rows cannot survive disconnect (#140)', async () => {
    const { controller, backendB } = twoHostController();
    const delayed = deferred<readonly WorkerJob[]>();
    backendB.listSubagentJobs = () => delayed.promise;
    await controller.bootstrap();
    controller.openSession('ses_b', 'srv_1');
    await flush(); // first refresh is in flight and has written no rows
    controller.onStreamStatus('srv_1', 'reconnecting');
    delayed.resolve([remoteJob]); // the pre-disconnect response arrives after reconnect
    await flush();
    expect(controller.state.workers['server:srv_1/session:ses_b']).toBeUndefined();
    controller.dispose();
  });

  test('unpairing a host removes its worker, shell-job and background records', async () => {
    const harness = adminHarness();
    const controller = controllerWith(harness.admin);
    const key = 'server:srv_1/session:ses_a';
    controller.state.sessions[key] = { ...fakeSession('ses_a'), serverID: 'srv_1' };
    controller.state.workers[key] = [remoteJob];
    controller.state.shellJobs[key] = [];
    controller.state.backgrounded[key] = [{ toolID: 't1', text: 'Moved to background' }];

    controller.setComposer(composerFrom('/unpair buildbox'));
    await controller.submit();
    expect(controller.state.workers[key]).toBeUndefined();
    expect(controller.state.shellJobs[key]).toBeUndefined();
    expect(controller.state.backgrounded[key]).toBeUndefined();
    controller.dispose();
  });
});

function controllerWithRunningTools() {
  const backend = new FakeBackend();
  backend.sessions = [fakeSession('ses_a')];
  backend.messages = {
    ses_a: [
      {
        kind: 'assistant',
        id: 'm1',
        createdAt: 1,
        agent: 'build',
        model: { providerID: 'p', modelID: 'm' },
        parts: [
          {
            kind: 'tool',
            tool: { id: 't1', name: 'bash', status: 'running', input: {}, startedAt: 1 },
          },
          {
            kind: 'tool',
            tool: { id: 't2', name: 'bash', status: 'running', input: {}, startedAt: 2 },
          },
        ],
      },
    ],
  };
  const controller = makeController(async () => [], backend);
  return { backend, controller };
}

describe('transient background confirmation lifecycle (#135)', () => {
  test('each running call gets its own confirmation; repeating does not duplicate it', async () => {
    const { controller } = controllerWithRunningTools();
    await attach(controller, 'ses_a');
    controller.onEvents(
      'local',
      [{ kind: 'execution', sessionID: 'ses_a', state: 'started' }],
      false,
    );
    await controller.backgroundTools();
    const key = 'ses_a';
    expect(controller.state.backgrounded[key]?.map((event) => event.toolID)).toEqual(['t1', 't2']);
    await controller.backgroundTools();
    expect(controller.state.backgrounded[key]).toHaveLength(2);
    controller.dispose();
  });

  test('a delayed RPC keeps captured tool identity even if a tool finishes (#147)', async () => {
    const { backend, controller } = controllerWithRunningTools();
    await attach(controller, 'ses_a');
    controller.onEvents(
      'local',
      [{ kind: 'execution', sessionID: 'ses_a', state: 'started' }],
      false,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realBackground = backend.backgroundTools.bind(backend);
    backend.backgroundTools = async (sessionID) => {
      await gate;
      await realBackground(sessionID);
    };
    const pending = controller.backgroundTools();
    // While the RPC is pending, t1 completes — no recomputation should drop it.
    const transcript = controller.state.transcripts['ses_a'];
    if (transcript !== undefined) {
      controller.state.transcripts['ses_a'] = {
        ...transcript,
        messages: transcript.messages.map((message) =>
          message.kind === 'assistant'
            ? {
                ...message,
                parts: message.parts.map((part) =>
                  part.kind === 'tool' && part.tool.id === 't1'
                    ? { ...part, tool: { ...part.tool, status: 'completed' } }
                    : part,
                ),
              }
            : message,
        ),
      };
    }
    release();
    await pending;
    expect(controller.state.backgrounded['ses_a']?.map((event) => event.toolID)).toEqual([
      't1',
      't2',
    ]);
    controller.dispose();
  });

  test('a late acknowledgement from an ended turn cannot attach to a new one (#147)', async () => {
    const { backend, controller } = controllerWithRunningTools();
    await attach(controller, 'ses_a');
    controller.onEvents(
      'local',
      [{ kind: 'execution', sessionID: 'ses_a', state: 'started' }],
      false,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realBackground = backend.backgroundTools.bind(backend);
    backend.backgroundTools = async (sessionID) => {
      await gate;
      await realBackground(sessionID);
    };
    const pending = controller.backgroundTools();
    controller.onEvents(
      'local',
      [
        { kind: 'execution', sessionID: 'ses_a', state: 'succeeded' },
        { kind: 'execution', sessionID: 'ses_a', state: 'started' },
      ],
      false,
    );
    release();
    await pending;
    expect(controller.state.backgrounded['ses_a'] ?? []).toEqual([]);
    controller.dispose();
  });

  test('turn completion clears confirmations so a later run cannot resurrect them', async () => {
    const { controller } = controllerWithRunningTools();
    await attach(controller, 'ses_a');
    controller.onEvents(
      'local',
      [{ kind: 'execution', sessionID: 'ses_a', state: 'started' }],
      false,
    );
    await controller.backgroundTools();
    expect(controller.state.backgrounded['ses_a']).toHaveLength(2);
    controller.onEvents(
      'local',
      [{ kind: 'execution', sessionID: 'ses_a', state: 'succeeded' }],
      false,
    );
    expect(controller.state.backgrounded['ses_a']).toEqual([]);
    controller.dispose();
  });
});

describe('rewind prompt selection (#102)', () => {
  const messages: TranscriptMessage[] = [
    { kind: 'user', id: 'u1', createdAt: 1000, text: 'first request', attachments: [] },
    {
      kind: 'assistant',
      id: 'm1',
      createdAt: 1100,
      agent: 'build',
      model: { providerID: 'p', modelID: 'm' },
      parts: [],
    },
    { kind: 'user', id: 'u2', createdAt: 2000, text: 'second request', attachments: [] },
    {
      kind: 'assistant',
      id: 'm2',
      createdAt: 2100,
      agent: 'build',
      model: { providerID: 'p', modelID: 'm' },
      parts: [],
    },
  ];

  function harness() {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.messages = { ses_a: messages };
    backend.diffs = [
      {
        file: 'src/a.ts',
        patch: '@@ -1 +1 @@',
        additions: 1,
        deletions: 1,
        status: 'modified',
        truncated: false,
      },
    ];
    backend.revertFiles = [...backend.diffs];
    const controller = makeController(async () => [], backend);
    return { backend, controller };
  }

  test('selects an earlier prompt, previews files read-only, then stages that boundary', async () => {
    const { backend, controller } = harness();
    await attach(controller, 'ses_a');
    controller.enterRewindSelection();
    const open = controller.state.overlay;
    expect(open.kind).toBe('rewind-picker');
    expect(controller.rewindChoices('ses_a', 'local').map((item) => item.messageID)).toEqual([
      'u1',
      'u2',
    ]);
    await flush();
    expect(backend.calls.some((call) => call.name === 'sessionDiff')).toBe(true);

    controller.moveRewindPicker(-1);
    await flush();
    const diff = backend.calls.findLast((call) => call.name === 'sessionDiff');
    expect(diff?.args[1]).toEqual({ from: 'u1' });
    expect(backend.calls.some((call) => call.name === 'stageRevert')).toBe(false);

    await controller.acceptRewindPicker();
    expect(backend.calls.find((call) => call.name === 'stageRevert')?.args).toEqual([
      'ses_a',
      'u1',
    ]);
    expect(controller.state.overlay.kind).toBe('revert');
    controller.dispose();
  });

  test('an unavailable preview is labelled, not shown as "no changes"', async () => {
    const { backend, controller } = harness();
    backend.sessionDiff = async () => {
      throw new Error('diff unavailable');
    };
    await attach(controller, 'ses_a');
    controller.enterRewindSelection();
    await flush();
    const overlay = controller.state.overlay;
    expect(overlay.kind).toBe('rewind-picker');
    if (overlay.kind !== 'rewind-picker') throw new Error('picker not open');
    expect(overlay.previewUnavailable).toBe(true);
    controller.dispose();
  });

  test('rewind is refused while the session is running', async () => {
    const { controller } = usageHarness();
    await attach(controller, 'ses_a');
    controller.onEvents(
      'local',
      [{ kind: 'execution', sessionID: 'ses_a', state: 'started' }],
      false,
    );
    controller.enterRewindSelection();
    expect(controller.state.overlay.kind).toBe('none');
    expect(controller.state.notice?.text).toContain('Wait for the current run');
    controller.dispose();
  });

  test('cancelling the selector never stages or mutates files', async () => {
    const { backend, controller } = harness();
    await attach(controller, 'ses_a');
    controller.enterRewindSelection();
    controller.closeOverlay();
    expect(controller.state.rewindPending).toBe(false);
    expect(backend.calls.some((call) => call.name === 'stageRevert')).toBe(false);
    expect(backend.calls.some((call) => call.name === 'commitRevert')).toBe(false);
    controller.dispose();
  });
});

const sharedModelCatalog = (contextLimit: number) => ({
  providerID: 'opencode',
  modelID: 'shared',
  name: 'Shared',
  enabled: true,
  variants: [],
  contextLimit,
});

const sharedModelStep = (id: string) => ({
  kind: 'assistant' as const,
  id,
  createdAt: 2,
  completedAt: 3,
  agent: 'build',
  model: { providerID: 'opencode', modelID: 'shared' },
  parts: [],
  usage: { input: 120, output: 30, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
});

function usageHarness() {
  const backend = new FakeBackend();
  backend.sessions = [
    {
      ...fakeSession('ses_a'),
      tokens: { input: 40_000, output: 5_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.5,
    },
  ];
  backend.models = [
    { providerID: 'opencode', modelID: 'longcat', name: 'Longcat', enabled: true, variants: [] },
  ];
  backend.messages = {
    ses_a: [
      { kind: 'user', id: 'u1', createdAt: 1, text: 'go', attachments: [] },
      {
        kind: 'assistant',
        id: 'a1',
        createdAt: 2,
        completedAt: 3,
        agent: 'build',
        model: { providerID: 'opencode', modelID: 'longcat' },
        parts: [
          {
            kind: 'tool',
            tool: { id: 't1', name: 'read', status: 'completed', input: {}, startedAt: 2 },
          },
        ],
        usage: { input: 120, output: 30, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
  const controller = makeController(async () => [], backend);
  return { backend, controller };
}

describe('session usage analytics and footer actions (#124)', () => {
  test('usageAnalytics is server-qualified and exposes context, lifetime and activity', async () => {
    const { controller } = usageHarness();
    await attach(controller, 'ses_a');
    const analytics = controller.usageAnalytics();
    expect(analytics.sessionID).toBe('ses_a');
    expect(analytics.serverID).toBe('local');
    expect(analytics.context.status).toBe('known');
    expect(analytics.context.tokens).toBe(150);
    expect(analytics.lifetime?.input).toBe(40_000);
    expect(analytics.cost).toBe(0.5);
    expect(analytics.toolCalls).toBe(1);
    expect(analytics.toolCategories.read).toBe(1);
    controller.dispose();
  });

  test('analytics projection is reused across unrelated updates (#285)', async () => {
    const { controller } = usageHarness();
    await attach(controller, 'ses_a');
    const first = controller.usageAnalytics();
    controller.setComposer(composerFrom('unrelated draft'));
    expect(controller.usageAnalytics()).toBe(first);

    controller.onEvents(
      'local',
      [
        {
          kind: 'usage',
          sessionID: 'ses_a',
          cost: 0.75,
          tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      false,
    );
    const second = controller.usageAnalytics();
    expect(second).not.toBe(first);
    expect(second.cost).toBe(0.75);
    expect(controller.usageAnalytics()).toBe(second);
    controller.dispose();
  });

  test('footer actions open the right overlay and are ignored behind a dialog', async () => {
    const { controller } = usageHarness();
    await attach(controller, 'ses_a');

    controller.activateFooter('context');
    expect(controller.state.overlay.kind).toBe('usage');
    controller.closeOverlay();

    controller.activateFooter('agent');
    await flush();
    expect(controller.state.overlay.kind).toBe('agent-picker');
    controller.closeOverlay();

    controller.activateFooter('model');
    await flush();
    expect(controller.state.overlay.kind).toBe('model-picker');
    controller.closeOverlay();

    // A dialog in front swallows footer clicks: no picker switch, no draft mutation.
    controller.setComposer(composerFrom('keep me'));
    controller.setOverlay({ kind: 'help' });
    controller.activateFooter('agent');
    expect(controller.state.overlay.kind).toBe('help');
    expect(controller.state.composer.text).toBe('keep me');
    controller.dispose();
  });

  test('/usage and a context click resolve to the same overlay', async () => {
    const { controller } = usageHarness();
    await attach(controller, 'ses_a');
    controller.setComposer(composerFrom('/usage'));
    await controller.submit();
    expect(controller.state.overlay).toEqual({ kind: 'usage' });
    controller.dispose();
  });

  test('a files-only staged revert does not reduce the context reading (#142)', async () => {
    const { backend, controller } = usageHarness();
    await attach(controller, 'ses_a');
    expect(controller.usageAnalytics().context.tokens).toBe(150);
    backend.sessions = [
      {
        ...fakeSession('ses_a'),
        tokens: { input: 40_000, output: 5_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0.5,
        revert: {
          messageID: 'u1',
          files: [
            {
              file: 'src/a.ts',
              patch: '',
              additions: 3,
              deletions: 0,
              status: 'modified',
              truncated: false,
            },
          ],
        },
      },
    ];
    // The revert is files-only; neither the conversation nor its context changed.
    expect(controller.usageAnalytics().context.tokens).toBe(150);
    controller.dispose();
  });

  test('context limits come from the conversation owning host, not the latest catalog (#143)', async () => {
    const backendA = new FakeBackend();
    const backendB = new FakeBackend();
    backendB.serverID = 'srv_1';
    backendA.models = [sharedModelCatalog(1000)];
    backendB.models = [sharedModelCatalog(200)];
    backendA.messages = { ses_a: [sharedModelStep('a1')] };
    backendB.messages = { ses_b: [sharedModelStep('b1')] };
    backendA.sessions = [{ ...fakeSession('ses_a'), directory: '/a' }];
    backendB.sessions = [{ ...fakeSession('ses_b'), serverID: 'srv_1', directory: '/b' }];
    const controller = new AppController({
      backend: backendA,
      config: defaultConfig,
      localState: emptyState,
      platform: 'linux',
      cwd: '/work/kohjoh',
      version: '0.0.1',
      now: () => 10_000,
      saveLocalState: async () => {},
      listFiles: () => Promise.resolve([]),
      requestExit: () => {},
      serverIDs: () => ['srv_1'],
      backendFor: (serverID: string) => (serverID === 'srv_1' ? backendB : backendA),
      serverInfo: () => ({ online: true }),
    });
    await controller.bootstrap();
    await controller.loadCatalog('/a', 'local');
    controller.openSession('ses_a');
    await flush();
    expect(controller.usageAnalytics().context.limit).toBe(1000);
    await controller.loadCatalog('/b', 'srv_1');
    controller.openSession('ses_b', 'srv_1');
    await flush();
    expect(controller.usageAnalytics().context.limit).toBe(200);
    controller.dispose();
  });
});

describe('footer picker toggle and late-open guards (#139)', () => {
  test('a second click toggles the matching overlay closed without selecting or resetting', async () => {
    const { controller } = usageHarness();
    await attach(controller, 'ses_a');
    controller.setComposer(composerFrom('keep me'));
    const agent = controller.currentAgentID();
    const model = controller.currentSession()?.model;

    controller.activateFooter('agent');
    await flush();
    expect(controller.state.overlay.kind).toBe('agent-picker');
    controller.activateFooter('agent');
    expect(controller.state.overlay.kind).toBe('none');
    expect(controller.currentAgentID()).toBe(agent);

    controller.activateFooter('model');
    await flush();
    expect(controller.state.overlay.kind).toBe('model-picker');
    controller.activateFooter('model');
    expect(controller.state.overlay.kind).toBe('none');
    expect(controller.currentSession()?.model).toEqual(model);

    controller.activateFooter('context');
    expect(controller.state.overlay.kind).toBe('usage');
    controller.activateFooter('context');
    expect(controller.state.overlay.kind).toBe('none');

    expect(controller.state.composer.text).toBe('keep me');
    controller.dispose();
  });

  test('a rapid double click during a delayed catalog load leaves no overlay', async () => {
    const backend = new FakeBackend();
    backend.sessions = [fakeSession('ses_a')];
    backend.models = [
      { providerID: 'opencode', modelID: 'longcat', name: 'Longcat', enabled: true, variants: [] },
    ];
    const controller = makeController(async () => [], backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.listAgentsHook = async () => {
      await gate;
      return [];
    };
    // A new directory makes the catalog stale, so the footer open awaits the gated load.
    controller.startNewSession('/work/other');
    await flush();

    controller.activateFooter('agent');
    controller.activateFooter('agent'); // dismiss while the catalog is still loading
    release();
    await flush();
    expect(controller.state.overlay.kind).toBe('none');
    controller.dispose();
  });

  test('a late picker open cannot resurrect after the route changes', async () => {
    const { controller } = usageHarness();
    await attach(controller, 'ses_a');
    controller.activateFooter('agent');
    controller.openOverview();
    await flush();
    expect(controller.state.overlay.kind).toBe('none');
    controller.dispose();
  });
});

function goalController(store: GoalStore) {
  const backend = new FakeBackend();
  backend.sessions = [fakeSession('ses_a')];
  return new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    requestExit: () => {},
    goalStore: store,
  });
}

const revDoc = (revision: number, title = `rev${revision}`): GoalPlanV1 => ({
  ...emptyGoalPlan('local', 'ses_a', 'p'),
  revision,
  goal: { title, acceptance: [], owner: 'user', updatedAt: 'now' },
});

describe('monotonic goal plan UI state (#161)', () => {
  test('a stale load cannot overwrite a newer saved revision', async () => {
    const stale = deferred<ReturnType<typeof revDoc>>();
    let disk = revDoc(0);
    const store: GoalStore = {
      load: () => stale.promise,
      async save(doc) {
        disk = { ...doc, revision: doc.revision + 1 };
        return disk;
      },
    };
    const controller = goalController(store);
    await attach(controller, 'ses_a'); // starts a load that we hold open

    await submitCommand(controller, '/plan alpha');
    expect(controller.state.goals['ses_a']?.revision).toBe(1);

    stale.resolve(revDoc(0, 'old read'));
    await flush();
    expect(controller.state.goals['ses_a']?.revision).toBe(1);
    expect(controller.state.goals['ses_a']?.goal?.title).not.toBe('old read');
    controller.dispose();
  });

  test('a repeated conflict is retried with a bounded budget', async () => {
    let attempts = 0;
    const store: GoalStore = {
      load: async () => undefined,
      async save(doc) {
        attempts += 1;
        throw new GoalConflictError({ ...doc, revision: attempts });
      },
    };
    const controller = goalController(store);
    await attach(controller, 'ses_a');
    await submitCommand(controller, '/plan alpha');
    expect(attempts).toBe(5);
    expect(controller.state.goals['ses_a']).toBeUndefined();
    expect(controller.state.notice?.tone).toBe('error');
    controller.dispose();
  });

  test('overlapping edits on one session end at the newest revision with both edits', async () => {
    let disk = revDoc(0);
    const store: GoalStore = {
      load: async () => disk,
      async save(doc) {
        disk = { ...doc, revision: doc.revision + 1 };
        return disk;
      },
    };
    const controller = goalController(store);
    await attach(controller, 'ses_a');
    const first = submitCommand(controller, '/plan one');
    const second = submitCommand(controller, '/plan two');
    await Promise.all([first, second]);
    expect(controller.state.goals['ses_a']?.revision).toBe(2);
    // The later edit deterministically wins; both saves were actually persisted.
    expect(controller.state.goals['ses_a']?.plan?.tasks.map((task) => task.title)).toEqual(['two']);
    expect(disk.revision).toBe(2);
    controller.dispose();
  });

  test('a load for a session removed mid-read cannot resurrect its goal', async () => {
    const pending = deferred<ReturnType<typeof revDoc>>();
    const store: GoalStore = {
      load: () => pending.promise,
      save: async (doc) => ({ ...doc, revision: doc.revision + 1 }),
    };
    const controller = goalController(store);
    await attach(controller, 'ses_a');
    controller.onEvents('local', [{ kind: 'session-deleted', sessionID: 'ses_a' }], false);
    pending.resolve(revDoc(1));
    await flush();
    expect(controller.state.goals['ses_a']).toBeUndefined();
    controller.dispose();
  });

  test('a read from a deleted lifetime cannot appear in the same-ID replacement (#278)', async () => {
    const first = deferred<ReturnType<typeof revDoc>>();
    let loads = 0;
    const store: GoalStore = {
      load: () => {
        loads += 1;
        return loads === 1 ? first.promise : Promise.resolve(revDoc(0, 'new lifetime'));
      },
      save: async (doc) => ({ ...doc, revision: doc.revision + 1 }),
    };
    const controller = goalController(store);
    await attach(controller, 'ses_a');
    controller.onEvents('local', [{ kind: 'session-deleted', sessionID: 'ses_a' }], false);
    // The server re-lists the same ID as a new lifetime.
    await controller.loadSessions('local');
    controller.openSession('ses_a', 'local');
    await flush();
    expect(controller.state.goals['ses_a']?.goal?.title).toBe('new lifetime');
    expect(controller.state.goals['ses_a']?.revision).toBe(0);

    first.resolve(revDoc(5, 'old lifetime'));
    await flush();
    expect(controller.state.goals['ses_a']?.goal?.title).toBe('new lifetime');
    expect(controller.state.goals['ses_a']?.revision).toBe(0);
    controller.dispose();
  });

  test('an unindexed new session still loads its local goal draft (#278)', async () => {
    const backend = new FakeBackend();
    backend.sessions = [];
    const store: GoalStore = {
      load: async () => revDoc(0, 'draft'),
      save: async (doc) => ({ ...doc, revision: doc.revision + 1 }),
    };
    const controller = new AppController({
      backend,
      config: defaultConfig,
      localState: emptyState,
      platform: 'linux',
      cwd: '/work/kohjoh',
      version: '0.0.1',
      now: () => 10_000,
      saveLocalState: async () => {},
      listFiles: () => Promise.resolve([]),
      requestExit: () => {},
      goalStore: store,
    });
    await controller.bootstrap();
    controller.openSession('ses_new', 'local');
    await flush();
    expect(controller.state.sessions['ses_new']).toBeUndefined();
    expect(controller.state.goals['ses_new']?.goal?.title).toBe('draft');
    controller.dispose();
  });
});

function editorFixture() {
  const backend = new FakeBackend();
  backend.sessions = [fakeSession('ses_a'), fakeSession('ses_b')];
  const written: { path: string; text: string }[] = [];
  const controller = makeController(
    () => Promise.resolve([]),
    backend,
    () => 10_000,
    {
      copyFallbackDir: '/tmp',
      writeFile: async (path, text) => {
        written.push({ path, text });
      },
    },
  );
  return { controller, written };
}

describe('external editor result ownership (#271)', () => {
  test('a late result updates the original parked draft, never the current one', async () => {
    const { controller } = editorFixture();
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    controller.setComposer(composerFrom('alpha'));
    expect(controller.attachImage(new Uint8Array([1, 2, 3]), 'image/png', 'a.png')).toBe(true);
    const origin = controller.captureExternalEditOrigin();
    const attachmentIDs = [...origin.attachmentIDs];

    controller.openSession('ses_b');
    await flush();
    controller.setComposer(composerFrom('beta'));
    expect(await controller.applyExternalEdit(origin, 'edited alpha')).toBe('draft');

    expect(controller.state.composer.text).toBe('beta');
    expect(controller.state.drafts['ses_a']?.text).toBe('edited alpha');
    expect(controller.state.draftAttachments['ses_a']?.map((entry) => entry.id)).toEqual(
      attachmentIDs,
    );
    controller.dispose();
  });

  test('a newer edit on the same route is never overwritten and the result is saved', async () => {
    const { controller, written } = editorFixture();
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    controller.setComposer(composerFrom('alpha'));
    const origin = controller.captureExternalEditOrigin();
    controller.setComposer(composerFrom('newer local text'));

    expect(await controller.applyExternalEdit(origin, 'edited alpha')).toBe('recovery');
    expect(controller.state.composer.text).toBe('newer local text');
    expect(written.map((entry) => entry.text)).toEqual(['edited alpha']);
    expect(controller.state.notice?.text).toContain('saved to');
    controller.dispose();
  });

  test('a result for a deleted session is retained, not injected into another conversation', async () => {
    const { controller, written } = editorFixture();
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    controller.setComposer(composerFrom('alpha'));
    const origin = controller.captureExternalEditOrigin();
    controller.onEvents('local', [{ kind: 'session-deleted', sessionID: 'ses_a' }], false);
    controller.openSession('ses_b');
    await flush();
    controller.setComposer(composerFrom('beta'));

    expect(await controller.applyExternalEdit(origin, 'edited alpha')).toBe('recovery');
    expect(controller.state.composer.text).toBe('beta');
    expect(controller.state.drafts['ses_a']?.text).not.toBe('edited alpha');
    expect(written.map((entry) => entry.text)).toEqual(['edited alpha']);
    controller.dispose();
  });

  test('a recreated same-ID session rejects the old lifetime result', async () => {
    const { controller, written } = editorFixture();
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    controller.setComposer(composerFrom('alpha'));
    const origin = controller.captureExternalEditOrigin();
    controller.onEvents('local', [{ kind: 'session-deleted', sessionID: 'ses_a' }], false);
    await controller.loadSessions('local');
    controller.openSession('ses_a');
    await flush();

    expect(await controller.applyExternalEdit(origin, 'edited alpha')).toBe('recovery');
    expect(written.map((entry) => entry.text)).toEqual(['edited alpha']);
    controller.dispose();
  });

  test('a same-route edit that returns to the original text still rejects the result', async () => {
    const { controller, written } = editorFixture();
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    controller.setComposer(composerFrom('alpha'));
    const origin = controller.captureExternalEditOrigin();
    controller.setComposer(composerFrom('beta'));
    controller.setComposer(composerFrom('alpha'));

    expect(await controller.applyExternalEdit(origin, 'edited alpha')).toBe('recovery');
    expect(controller.state.composer.text).toBe('alpha');
    expect(written.map((entry) => entry.text)).toEqual(['edited alpha']);
    controller.dispose();
  });

  test('a parked draft edited away from and back to the same text rejects the result', async () => {
    const { controller, written } = editorFixture();
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    controller.setComposer(composerFrom('alpha'));
    const origin = controller.captureExternalEditOrigin();
    controller.openSession('ses_b');
    await flush();
    controller.openSession('ses_a');
    await flush();
    controller.setComposer(composerFrom('beta'));
    controller.setComposer(composerFrom('alpha'));
    controller.openSession('ses_b');
    await flush();
    controller.setComposer(composerFrom('beta'));

    expect(await controller.applyExternalEdit(origin, 'edited alpha')).toBe('recovery');
    expect(controller.state.drafts['ses_a']?.text).toBe('alpha');
    expect(controller.state.composer.text).toBe('beta');
    expect(written.map((entry) => entry.text)).toEqual(['edited alpha']);
    controller.dispose();
  });

  test('a route round trip without edits preserves the untouched draft identity', async () => {
    const { controller, written } = editorFixture();
    await controller.bootstrap();
    controller.openSession('ses_a');
    await flush();
    controller.setComposer(composerFrom('alpha'));
    const origin = controller.captureExternalEditOrigin();
    controller.openSession('ses_b');
    await flush();
    controller.setComposer(composerFrom('beta'));
    controller.openSession('ses_a');
    await flush();

    expect(await controller.applyExternalEdit(origin, 'edited alpha')).toBe('composer');
    expect(controller.state.composer.text).toBe('edited alpha');
    expect(written).toEqual([]);
    controller.dispose();
  });
});
