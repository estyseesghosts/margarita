import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
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
