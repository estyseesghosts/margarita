import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { BackendError, type PromptDraft } from '../adapter/backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import { composerFrom } from '../domain/composer.ts';
import { buildKeymap } from '../domain/keymap.ts';
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

async function syncedFixture() {
  const backend = new FakeBackend();
  backend.sessions = [fakeSession('ses_a')];
  backend.messages = { ses_a: [] };
  const controller = makeController(() => Promise.resolve([]), backend);
  await attach(controller, 'ses_a');
  for (const text of ['/goal Test goal', '/sync on']) {
    controller.setComposer(composerFrom(text));
    await controller.submit();
  }
  return { backend, controller };
}

async function submitCommand(controller: AppController, text: string): Promise<void> {
  controller.setComposer(composerFrom(text));
  await controller.submit();
}

describe('instruction sync confirmation (issue #5)', () => {
  test('a failed revocation never reports success and is not silently re-synced', async () => {
    const { backend, controller } = await syncedFixture();
    backend.removeInstructionError = new Error('network drop');

    await submitCommand(controller, '/sync off');
    expect(controller.state.notice?.text).toContain('Could not revoke');
    expect(controller.state.notice?.text).toContain('/sync off to retry');
    expect(controller.goalOf('ses_a')?.modelInstructionSync?.enabled).toBe(true);
    expect(controller.state.goalSync['ses_a']?.status).toBe('removal-failed');

    const puts = backend.calls.filter((call) => call.name === 'putInstruction').length;
    await submitCommand(controller, '/plan step one');
    expect(backend.calls.filter((call) => call.name === 'putInstruction')).toHaveLength(puts);
    controller.dispose();
  });

  test('a confirmed revocation disables sync and clears the pending state', async () => {
    const { backend, controller } = await syncedFixture();
    await submitCommand(controller, '/sync off');
    expect(backend.calls.some((call) => call.name === 'removeInstruction')).toBe(true);
    expect(controller.goalOf('ses_a')?.modelInstructionSync?.enabled).toBe(false);
    expect(controller.state.goalSync['ses_a']).toBeUndefined();
    expect(controller.state.notice?.text).toBe('No longer shared with the agent');
    controller.dispose();
  });

  test('reconnect retries a failed revocation and finishes it', async () => {
    const { backend, controller } = await syncedFixture();
    backend.removeInstructionError = new Error('network drop');
    await submitCommand(controller, '/sync off');
    const removals = backend.calls.filter((call) => call.name === 'removeInstruction').length;

    backend.removeInstructionError = undefined;
    controller.onStreamStatus('reconnecting');
    controller.onStreamStatus('live');
    await flush();

    expect(backend.calls.filter((call) => call.name === 'removeInstruction').length).toBe(
      removals + 1,
    );
    expect(controller.goalOf('ses_a')?.modelInstructionSync?.enabled).toBe(false);
    expect(controller.state.goalSync['ses_a']).toBeUndefined();
    controller.dispose();
  });

  test('toggling back on after a failed revocation re-syncs the instruction', async () => {
    const { backend, controller } = await syncedFixture();
    backend.removeInstructionError = new Error('network drop');
    await submitCommand(controller, '/sync off');
    const puts = backend.calls.filter((call) => call.name === 'putInstruction').length;

    backend.removeInstructionError = undefined;
    await submitCommand(controller, '/sync on');
    expect(backend.calls.filter((call) => call.name === 'putInstruction').length).toBe(puts + 1);
    expect(controller.state.goalSync['ses_a']?.status).not.toBe('removal-failed');
    controller.dispose();
  });
});
