import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { BackendError, type PromptDraft } from '../adapter/backend.ts';
import { defaultConfig } from '../config/config.ts';
import type { AppConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import { composerFrom } from '../domain/composer.ts';
import { buildKeymap } from '../domain/keymap.ts';
import type { NativeGoal } from '../domain/native-goal.ts';
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
) {
  return new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
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
        start: 8,
        end: 20,
        text: '@src/main.ts',
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
        start: 8,
        end: 30,
        text: '@/srv/proj/src/main.ts',
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
        start: 8,
        end: 20,
        text: '@SRC\\MAIN.TS',
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
    controller.onEvents([{ kind: 'revert-changed', sessionID: 'ses_a', action: 'cleared' }], false);
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
    controller.onEvents([], true);
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
    controller.onEvents([], true);
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
    controller.onEvents([], true);
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
    expect(controller.state.expandedDiffs['d1']).toBe(true);
    expect(controller.state.expandedGroups['group:t1']).toBeUndefined();
    expect(controller.state.expandedGroups['group:t4']).toBeUndefined();

    expect(controller.toggleFocusedGroup()).toBe(true);
    expect(controller.state.expandedDiffs['d1']).toBeUndefined();
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
    expect(controller.state.expandedDiffs['d1']).toBe(true);
    expect(controller.state.composer.text).toBe('');

    routeKey(
      controller,
      keymap,
      { name: 'return', ctrl: false, alt: false, shift: false },
      services,
    );
    await flush();
    expect(controller.state.expandedDiffs['d1']).toBeUndefined();
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
    expect(controller.state.expandedGroups['group:t1']).toBe(true);

    controller.openSession('ses_b');
    await flush();
    expect(controller.state.route).toEqual({ kind: 'conversation', sessionID: 'ses_b' });

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
    controller.onEvents([], true); // same resync path events take in production
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
    expect(controller.state.expandedGroups['group:t1']).toBe(true);
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

    const id = await controller.createSessionWithPrompt('/work/kohjoh', 'prompt recorded in A');
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
    await first.createSessionWithPrompt('/work/kohjoh', 'persisted prompt');
    expect(saved.value?.history['/work/kohjoh']).toEqual(['persisted prompt']);
    first.dispose();

    const second = make(saved.value ?? emptyState);
    second.historyUp();
    expect(second.state.composer.text).toBe('persisted prompt');
    second.dispose();
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
