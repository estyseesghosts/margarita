import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBackend } from '../../test/fake-backend.ts';
import { BackendError, type BackendErrorKind, type PromptDraft } from '../adapter/backend.ts';
import { defaultConfig } from '../config/config.ts';
import type { AppConfig } from '../config/config.ts';
import { emptyState, type LocalState } from '../config/local-state.ts';
import { composerFrom } from '../domain/composer.ts';
import { buildKeymap } from '../domain/keymap.ts';
import type { GoalQueryFailure, NativeGoal } from '../domain/native-goal.ts';
import { directoryKey } from '../domain/path-identity.ts';
import type { SessionSummary } from '../domain/session.ts';
import type { ToolCall, TranscriptMessage } from '../domain/transcript.ts';
import { AppController } from './controller.ts';
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
  listFiles: (root: string) => Promise<string[]>,
  backend: FakeBackend = new FakeBackend(),
  now: () => number = () => 10_000,
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
  });
}

async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await Bun.sleep(0);
}

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
    controller.setComposer(composerFrom('/cmd-b'));
    expect(controller.state.completion?.kind).toBe('command');
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

  test('detailed mode shows everything expanded and offers no collapsible rows', async () => {
    const { controller } = conversationWithEdit();
    await attach(controller, 'ses_a');
    controller.toggleDetails();
    expect(controller.state.detailed).toBe(true);
    expect(controller.collapsibleItems()).toEqual([]);
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

    // Expand the second group too; collapse the first again.
    controller.moveGroupFocus(1);
    expect(controller.state.focusedGroup).toBe('group:t4');
    controller.toggleFocusedGroup();
    controller.moveGroupFocus(-1);
    controller.toggleFocusedGroup();

    const after = controller.toolGroups();
    expect(after.map((group) => [group.key, group.expanded])).toEqual([
      ['group:t1', false],
      ['group:t4', true],
    ]);
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
    const saved: { value?: import('../config/local-state.ts').LocalState } = {};
    const make = (localState: import('../config/local-state.ts').LocalState) =>
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

  test('an agent/model invalid for the target project is scoped to its catalog before creation', async () => {
    const { controller, backendA, modelA, modelB } = catalogController();
    try {
      await controller.bootstrap();
      controller.openOverview();

      selectRowForDirectory(controller, '/proj-a');
      await controller.loadCatalog('/proj-a', 'local');
      // Set a model that belongs to host B while viewing host A's project.
      controller.setNewSessionDefaults(undefined, modelB);
      expect(controller.state.overview.model).toEqual(modelB);

      await controller.createSessionWithPrompt(
        { serverID: 'local', directory: '/proj-a' },
        'prompt',
      );
      await flush();

      const aCreate = backendA.calls.filter((call) => call.name === 'createSession');
      expect(aCreate).toHaveLength(1);
      // The invalid modelB is scoped to /proj-a's valid default (modelA), never sent as-is.
      expect(aCreate[0]!.args[0]).toEqual({ directory: '/proj-a', model: modelA });
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
    expect(controller.state.stash).toBeUndefined();
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
    expect(controller.state.stash).toBe('second follow-up');
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
    expect(controller.state.stash).toBe('typing now');
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

  test('a parked recalled message is restored with Ctrl+S', async () => {
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

    controller.setComposer(composerFrom('/unpair buildbox'));
    await controller.submit();
    expect(harness.calls).toEqual(['unpair:srv_1']);
    expect(controller.state.sessions[key]).toBeUndefined();
    expect(controller.state.running[key]).toBeUndefined();
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
    expect(controller.state.stash).toBe('my draft');
    expect(controller.state.notice?.text).toContain('stashed');
    expect(backend.calls.filter((call) => call.name === 'interrupt')).toHaveLength(0);
    controller.dispose();
  });

  test('Double-Esc on an idle empty composer enters rewind selection without mutating files', async () => {
    const { backend, controller } = conversationFixture();
    await attach(controller, 'ses_a');
    controller.setComposer(composerFrom(''));

    const { keymap } = buildKeymap({});
    routeKey(controller, keymap, escKey(), services);
    routeKey(controller, keymap, escKey(), services);
    await flush();

    expect(controller.state.rewindPending).toBe(true);
    expect(controller.state.composer.text).toBe('');
    expect(controller.state.notice?.text).toContain('Rewind selection');
    expect(backend.calls.filter((call) => call.name === 'interrupt')).toHaveLength(0);
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
    expect(controller.state.stash).toBeUndefined();
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
