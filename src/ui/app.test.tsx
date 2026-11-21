import { afterEach, describe, expect, test } from 'bun:test';

import { TextAttributes } from '@opentui/core';
import { testRender } from '@opentui/solid';

import { FakeBackend } from '../../test/fake-backend.ts';
import { BackendError } from '../adapter/backend.ts';
import { AppController } from '../app/controller.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import { isRecord } from '../domain/backend-event.ts';
import { composerFrom } from '../domain/composer.ts';
import { greetingCatalog } from '../domain/greetings.ts';
import { buildKeymap } from '../domain/keymap.ts';
import { directoryKey } from '../domain/path-identity.ts';
import { projectLabel } from '../domain/project-label.ts';
import type { TranscriptMessage } from '../domain/transcript.ts';
import { App } from './app.tsx';
import { pickTheme } from './theme.ts';

const pageUp = '\u001b[5~';

function expectWelcomeGreeting(frame: string): void {
  const all = Object.values(greetingCatalog).flat();
  expect(all.some((greeting) => frame.includes(greeting))).toBe(true);
}

/** Line of the cost field in a captured frame; a proxy for the pinned composer's Y. */
function footerY(frame: string): number {
  return frame.split('\n').findIndex((line) => line.includes('$0.00'));
}

/** The composer's prompt line in a captured frame; a proxy for its text layout. */
function composerLine(frame: string): string {
  return frame.split('\n').find((line) => line.includes('❯')) ?? '';
}

/** 0-indexed position of a footer segment's text, searched from the bottom of the frame. */
function footerPoint(frame: string, needle: string): [number, number] {
  const lines = frame.split('\n');
  for (let y = lines.length - 1; y >= 0; y -= 1) {
    const x = lines[y]!.indexOf(needle);
    if (x >= 0 && lines[y]!.includes('·')) return [x, y];
  }
  throw new Error(`footer segment ${needle} not found:\n${frame}`);
}

type Setup = Awaited<ReturnType<typeof testRender>>;
let current: Setup | undefined;

afterEach(() => {
  current?.renderer.destroy();
  current = undefined;
});

async function mount(
  backend: FakeBackend,
  options: { kittyKeyboard?: boolean; now?: () => number; hintTickMs?: number } = {},
) {
  const controller = new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: options.now ?? (() => 10_000),
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
  });
  await controller.bootstrap();
  const setup = await testRender(
    () =>
      App({
        controller,
        keymap: buildKeymap({}).keymap,
        theme: pickTheme({}),
        animate: false,
        ascii: false,
        env: {},
        ...(options.hintTickMs === undefined ? {} : { hintTickMs: options.hintTickMs }),
      }),
    options.kittyKeyboard === undefined
      ? { width: 80, height: 24 }
      : { width: 80, height: 24, kittyKeyboard: options.kittyKeyboard },
  );
  current = setup;
  await setup.renderOnce();
  return { controller, setup };
}

async function settle(setup: Setup) {
  await Bun.sleep(20);
  await setup.renderOnce();
}

function backendWithSession(): FakeBackend {
  const backend = new FakeBackend();
  backend.sessions = [
    {
      id: 'ses_a',
      serverID: 'local',
      projectID: 'p',
      directory: '/work/kohjoh',
      title: 'Renderer stalled near Goldenrod',
      agent: 'build',
      tokens: { input: 46_000, output: 5000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.38,
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    },
  ];
  backend.messages = {
    ses_a: [
      { kind: 'user', id: 'm1', createdAt: 1, text: 'why is it slow?', attachments: [] },
      {
        kind: 'assistant',
        id: 'm2',
        createdAt: 2,
        completedAt: 3,
        agent: 'build',
        model: { providerID: 'opencode', modelID: 'longcat' },
        parts: [{ kind: 'text', text: 'The frame budget is exceeded.' }],
      },
    ],
  };
  return backend;
}

describe('app', () => {
  test('overview lists sessions grouped by project with a new-session composer', async () => {
    const { setup } = await mount(backendWithSession());
    const frame = setup.captureCharFrame();
    if (process.env['DUMP'] !== undefined) console.log(frame);
    expect(frame).toContain('Sessions');
    expect(frame).toContain('kohjoh');
    expect(frame).toContain('Renderer stalled near Goldenrod');
    expect(frame).toContain('New session in kohjoh');
  });

  test('attach shows welcome panel, transcript and footer; empty Left returns', async () => {
    const { controller, setup } = await mount(backendWithSession());
    setup.mockInput.pressArrow('up');
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(controller.state.route).toEqual({
      kind: 'conversation',
      serverID: 'local',
      sessionID: 'ses_a',
    });
    const frame = setup.captureCharFrame();
    if (process.env['DUMP'] !== undefined) console.log(frame);
    expectWelcomeGreeting(frame);
    expect(frame).toContain('( o.o )');
    expect(frame).toContain('why is it slow?');
    expect(frame).toContain('The frame budget is exceeded.');
    expect(frame).toContain('46k in · 5k out');
    expect(frame).toContain('$0.38');

    await setup.mockInput.typeText('ab');
    setup.mockInput.pressArrow('left');
    await settle(setup);
    expect(controller.state.route.kind).toBe('conversation');

    setup.mockInput.pressBackspace();
    setup.mockInput.pressKey('DELETE');
    setup.mockInput.pressArrow('left');
    await settle(setup);
    expect(controller.state.composer.text).toBe('');
    setup.mockInput.pressArrow('left');
    await settle(setup);
    expect(controller.state.route.kind).toBe('overview');
  });

  test('Enter in a conversation sends the draft to the server', async () => {
    const backend = backendWithSession();
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    await setup.mockInput.typeText('hello');
    setup.mockInput.pressEnter();
    await settle(setup);
    const prompt = backend.calls.find((call) => call.name === 'prompt');
    expect(prompt?.args[0]).toBe('ses_a');
    expect(prompt?.args[1]).toMatchObject({ text: 'hello', files: [] });
  });

  test('startup new session: welcome panel, no server session until the first prompt', async () => {
    const backend = backendWithSession();
    const { controller, setup } = await mount(backend);
    controller.startNewSession('/work/kohjoh');
    await settle(setup);
    expectWelcomeGreeting(setup.captureCharFrame());
    expect(backend.calls.some((call) => call.name === 'createSession')).toBe(false);
    await setup.mockInput.typeText('hi');
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(backend.calls.find((call) => call.name === 'createSession')?.args[0]).toMatchObject({
      directory: '/work/kohjoh',
    });
    expect(controller.state.route.kind).toBe('conversation');
  });

  test('the caret styles only the composer insertion cell, never the welcome panel (#130/#137)', async () => {
    const { controller, setup } = await mount(backendWithSession());
    controller.startNewSession('/work/kohjoh');
    await settle(setup);
    await setup.mockInput.typeText('hi');
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain('▏'); // no layout-width caret glyph (#137)

    const lines = setup.captureSpans().lines;
    const underlined = lines.flatMap((line, row) =>
      line.spans
        .filter((span) => (span.attributes & TextAttributes.UNDERLINE) !== 0)
        .map((span) => ({ row, text: span.text })),
    );
    expect(underlined).toHaveLength(1);
    expect(underlined[0]?.text).toBe('i'); // cursor at end of "hi"
    const composerRow = lines.findIndex((line) =>
      line.spans.some((span) => span.text.includes('❯')),
    );
    expect(underlined[0]?.row).toBe(composerRow);
    expectWelcomeGreeting(frame);
    controller.dispose();
  });

  test('blink phases and wide glyphs never change the composer layout (#137)', async () => {
    const backend = backendWithSession();
    const { controller, setup } = await mount(backend);
    await setup.mockInput.typeText('ab😀cd日本語');
    await settle(setup);
    const onFrame = setup.captureCharFrame();
    expect(composerLine(onFrame)).not.toContain('▏');
    // Wait past the 530 ms blink interval and compare the actual rendered text layout.
    await new Promise((resolve) => setTimeout(resolve, 560));
    await settle(setup);
    const offFrame = setup.captureCharFrame();
    expect(composerLine(offFrame)).toBe(composerLine(onFrame));
    expect(offFrame).not.toContain('▏');
    controller.dispose();
  });

  test('the caret style marks the grapheme after the cursor, not a shifted suffix (#137)', async () => {
    const { controller, setup } = await mount(backendWithSession());
    await setup.mockInput.typeText('abcdef');
    setup.mockInput.pressArrow('left');
    setup.mockInput.pressArrow('left');
    await settle(setup);
    const composerRow = setup
      .captureSpans()
      .lines.find((line) => line.spans.some((span) => span.text.includes('❯')));
    const marked = composerRow?.spans.filter(
      (span) => (span.attributes & TextAttributes.UNDERLINE) !== 0,
    );
    expect(marked).toHaveLength(1);
    expect(marked?.[0]?.text).toBe('e'); // caret sits between "d" and "e"
    const line = setup
      .captureCharFrame()
      .split('\n')
      .find((row) => row.includes('❯'));
    expect(line).toContain('abcdef'); // suffix intact, no inserted cell
    expect(line).not.toContain('▏');
    controller.dispose();
  });

  test('overview selects the first row; typing fills the prompt', async () => {
    const { controller, setup } = await mount(backendWithSession());
    controller.startNewSession('/work/kohjoh');
    await settle(setup);
    setup.mockInput.pressArrow('left');
    await settle(setup);
    expect(controller.state.route.kind).toBe('overview');
    expect(controller.state.overview.focus).toBe('list');
    expect(controller.state.overview.selectedRow).toBe('session:ses_a');
    await setup.mockInput.typeText('go');
    await settle(setup);
    expect(controller.state.composer.text).toBe('go');
    expect(controller.state.overview.focus).toBe('composer');
  });

  test("typing 'new feature' from list selection keeps the leading n (issue 15)", async () => {
    const { controller, setup } = await mount(backendWithSession());
    controller.startNewSession('/work/kohjoh');
    await settle(setup);
    setup.mockInput.pressArrow('left');
    await settle(setup);
    expect(controller.state.route.kind).toBe('overview');
    expect(controller.state.overview.focus).toBe('list');
    expect(controller.state.overview.selectedRow).toBe('session:ses_a');
    await setup.mockInput.typeText('new feature');
    await settle(setup);
    expect(controller.state.composer.text).toBe('new feature');
    expect(controller.state.overview.focus).toBe('composer');
  });

  test('paste from list selection activates composer and Enter sends the pasted prompt (issue 15)', async () => {
    const backend = backendWithSession();
    const { controller, setup } = await mount(backend);
    controller.startNewSession('/work/kohjoh');
    await settle(setup);
    setup.mockInput.pressArrow('left');
    await settle(setup);
    expect(controller.state.route.kind).toBe('overview');
    expect(controller.state.overview.focus).toBe('list');
    expect(controller.state.overview.selectedRow).toBe('session:ses_a');
    await setup.mockInput.pasteBracketedText('fix failing tests');
    await settle(setup);
    expect(controller.state.composer.text).toBe('fix failing tests');
    expect(controller.state.overview.focus).toBe('composer');
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(controller.currentSession()?.id).not.toBe('ses_a');
    expect(backend.calls.find((call) => call.name === 'prompt')?.args[1]).toMatchObject({
      text: 'fix failing tests',
    });
  });

  test('session-list Up/Down/Right/Enter navigation still works with an empty composer (issue 15)', async () => {
    const backend = new FakeBackend();
    backend.sessions = Array.from({ length: 3 }, (_, index) => ({
      id: `ses_${index}`,
      serverID: 'local',
      projectID: 'p',
      directory: '/work/kohjoh',
      title: `Session ${index}`,
      createdAt: 0,
      updatedAt: index,
      archived: false,
    }));
    const { controller, setup } = await mount(backend);
    controller.startNewSession('/work/kohjoh');
    await settle(setup);
    setup.mockInput.pressArrow('left');
    await settle(setup);
    expect(controller.state.route.kind).toBe('overview');
    expect(controller.state.overview.focus).toBe('list');
    expect(controller.state.overview.selectedRow).toBe('session:ses_2');
    expect(controller.state.composer.text).toBe('');
    setup.mockInput.pressArrow('down');
    await settle(setup);
    expect(controller.state.overview.selectedRow).toBe('session:ses_1');
    setup.mockInput.pressArrow('up');
    await settle(setup);
    expect(controller.state.overview.selectedRow).toBe('session:ses_2');
    setup.mockInput.pressArrow('right');
    await settle(setup);
    expect(controller.state.route).toMatchObject({ kind: 'conversation', sessionID: 'ses_2' });
    setup.mockInput.pressArrow('left');
    await settle(setup);
    expect(controller.state.route.kind).toBe('overview');
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(controller.state.route).toMatchObject({ kind: 'conversation', sessionID: 'ses_2' });
  });

  test('overview keeps the selected row visible after 50 down and 50 up presses on a 24-row terminal (issue 6)', async () => {
    const backend = new FakeBackend();
    backend.sessions = Array.from({ length: 60 }, (_, index) => ({
      id: `ses_${index}`,
      serverID: 'local',
      projectID: 'p',
      directory: '/work/kohjoh',
      title: `Session number ${index}`,
      createdAt: 0,
      updatedAt: index,
      archived: false,
    }));
    const { controller, setup } = await mount(backend);
    controller.openOverview();
    await settle(setup);
    const selectedSession = () => {
      const id = controller.state.overview.selectedRow?.replace('session:', '');
      return backend.sessions.find((session) => session.id === id);
    };
    const expectSelectedVisible = () => {
      const frame = setup.captureCharFrame();
      expect(selectedSession()).toBeDefined();
      expect(frame).toContain(selectedSession()?.title ?? 'no-selection');
    };
    // Expand the group once so every session row is selectable.
    for (let step = 0; step < 6; step += 1) setup.mockInput.pressArrow('down');
    setup.mockInput.pressEnter();
    await settle(setup);
    // Clamp to the top row so the 50 downs below stay inside the list.
    for (let step = 0; step < 61; step += 1) setup.mockInput.pressArrow('up');
    await settle(setup);
    expect(controller.state.overview.focus).toBe('list');
    for (let step = 0; step < 50; step += 1) {
      setup.mockInput.pressArrow('down');
      await settle(setup);
      expectSelectedVisible();
    }
    for (let step = 0; step < 50; step += 1) {
      setup.mockInput.pressArrow('up');
      await settle(setup);
      expectSelectedVisible();
    }
  });

  test('projects collapse to six most recent sessions with inline Show more/less', async () => {
    const backend = new FakeBackend();
    backend.sessions = Array.from({ length: 8 }, (_, index) => ({
      id: `ses_${index}`,
      serverID: 'local',
      projectID: 'p',
      directory: '/work/kohjoh',
      title: `Session number ${index}`,
      createdAt: 0,
      updatedAt: index,
      archived: false,
    }));
    const { controller, setup } = await mount(backend);
    controller.openOverview();
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(frame.indexOf('Session number 7')).toBeLessThan(frame.indexOf('Session number 6'));
    expect(frame).not.toContain('Session number 1');
    expect(frame).toContain('[Show more] 2');
    for (let step = 0; step < 6; step += 1) setup.mockInput.pressArrow('down');
    setup.mockInput.pressEnter();
    await settle(setup);
    frame = setup.captureCharFrame();
    if (process.env['DUMP'] !== undefined) console.log(frame);
    expect(controller.state.route.kind).toBe('overview');
    expect(frame).toContain('Session number 0');
    expect(frame).toContain('[Show less]');
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain('Session number 0');
  });

  test('agent question: card, Enter opens the form, answers are sent once', async () => {
    const backend = backendWithSession();
    backend.forms = [
      {
        id: 'frm_1',
        sessionID: 'ses_a',
        title: 'Which branch?',
        fields: [
          {
            key: 'branch',
            title: 'Branch',
            required: true,
            when: [],
            kind: 'choice',
            custom: false,
            options: [
              { value: 'main', label: 'main' },
              { value: 'dev', label: 'dev' },
            ],
          },
        ],
      },
    ];
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    expect(setup.captureCharFrame()).toContain('Question from the agent');
    expect(controller.executionOf('ses_a').state).toBe('waiting');

    setup.mockInput.pressEnter();
    await settle(setup);
    expect(controller.state.overlay.kind).toBe('form');
    setup.mockInput.pressArrow('down');
    setup.mockInput.pressEnter();
    await settle(setup);
    await settle(setup);
    const replies = backend.calls.filter((call) => call.name === 'replyForm');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.args).toEqual(['ses_a', 'frm_1', { branch: 'dev' }]);
    expect(controller.state.overlay.kind).toBe('none');
    expect(setup.captureCharFrame()).not.toContain('Question from the agent');
  });

  test('permission answered by another client resolves without a fake success', async () => {
    const backend = backendWithSession();
    backend.permissions = [
      { id: 'per_1', sessionID: 'ses_a', action: 'bash', resources: ['git status'], save: [] },
    ];
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    expect(setup.captureCharFrame()).toContain('Permission needed');
    backend.replyError = new BackendError('conflict', 'permission.reply', 'already replied');
    backend.permissions = [];
    setup.mockInput.pressEnter();
    await settle(setup);
    await settle(setup);
    expect(backend.calls.filter((call) => call.name === 'replyPermission')).toHaveLength(1);
    expect(controller.state.notice?.text).toBe('Already answered elsewhere.');
    expect(setup.captureCharFrame()).not.toContain('Permission needed');
  });

  test('/diff turn lists server-reported files and opens a colored patch', async () => {
    const backend = backendWithSession();
    backend.diffs = [
      {
        file: 'src/gpu.ts',
        patch: '@@ -1 +1 @@\n-slow()\n+fast()\n',
        additions: 1,
        deletions: 1,
        status: 'modified',
        truncated: false,
      },
    ];
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    await setup.mockInput.typeText('/diff turn');
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(backend.calls.find((call) => call.name === 'sessionDiff')?.args).toEqual([
      'ses_a',
      { from: 'm1' },
    ]);
    let frame = setup.captureCharFrame();
    expect(frame).toContain('Changes in this turn · 1 file · +1 −1');
    expect(frame).toContain('M src/gpu.ts');
    setup.mockInput.pressEnter();
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(frame).toContain('+fast()');
    expect(frame).toContain('-slow()');
    setup.mockInput.pressArrow('left');
    setup.mockInput.pressEscape();
    await settle(setup);
    expect(controller.state.overlay.kind).toBe('none');
  });

  test('long transcripts render a window; PageUp at the top reveals then fetches older pages', async () => {
    const backend = backendWithSession();
    backend.messages['ses_a'] = Array.from({ length: 300 }, (_, index) => ({
      kind: 'user' as const,
      id: `m${String(index).padStart(4, '0')}`,
      createdAt: index,
      text: `message ${index}`,
      attachments: [],
    }));
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    // First fetch is one 120-message page; all of it fits in the 200-node window.
    expect(controller.state.transcripts['ses_a']?.messages).toHaveLength(120);
    expect(setup.captureCharFrame()).toContain('message 299');

    setup.mockInput.pressKey('HOME', { ctrl: true });
    await settle(setup);
    setup.mockInput.pressKey(pageUp);
    await settle(setup);
    await settle(setup);
    expect(controller.state.transcripts['ses_a']?.messages).toHaveLength(240);
    setup.mockInput.pressKey('HOME', { ctrl: true });
    await settle(setup);
    setup.mockInput.pressKey(pageUp);
    await settle(setup);
    await settle(setup);
    const transcript = controller.state.transcripts['ses_a'];
    expect(transcript?.messages).toHaveLength(300);
    expect(transcript?.olderCursor).toBeUndefined();
    expect(transcript?.messages[0]?.id).toBe('m0000');
  });

  test('a short page with a server cursor token does not show phantom earlier history (issue #125)', async () => {
    const backend = backendWithSession();
    backend.messages['ses_a'] = [
      {
        kind: 'user',
        id: 'm0',
        createdAt: 1,
        text: 'hello',
        attachments: [],
      },
      {
        kind: 'user',
        id: 'm1',
        createdAt: 2,
        text: 'hi',
        attachments: [],
      },
    ];
    // Emulate OpenCode v2: a token is minted for every nonempty page even when
    // there is nothing older. The backend reports the page as exhausted.
    backend.listMessages = async (sessionID, limit, cursor) => {
      const all = backend.messages[sessionID] ?? [];
      const end = cursor === undefined ? all.length : Number(cursor);
      const start = Math.max(0, end - limit);
      const messages = all.slice(start, end);
      return {
        messages,
        ...(messages.length > 0 ? { olderCursor: String(start) } : {}),
        hasEarlier: start > 0,
      };
    };
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);

    expect(controller.state.transcripts['ses_a']?.olderCursor).toBeUndefined();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain('earlier messages');

    const before = backend.calls.filter((call) => call.name === 'listMessages').length;
    setup.mockInput.pressKey('HOME', { ctrl: true });
    await settle(setup);
    setup.mockInput.pressKey(pageUp);
    await settle(setup);
    expect(backend.calls.filter((call) => call.name === 'listMessages')).toHaveLength(before);
  });

  test('goal, plan and Ctrl+T checklist; native goal shows alongside', async () => {
    const backend = backendWithSession();
    backend.serverCommands = [{ name: 'goal', description: 'Set the session goal' }];
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    for (const command of ['/goal Hit 30 FPS', '/plan profile; cull; test']) {
      await setup.mockInput.typeText(command);
      setup.mockInput.pressEnter();
      await settle(setup);
    }
    expect(backend.goals['ses_a']?.objective).toBe('Hit 30 FPS');
    expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
    setup.mockInput.pressKey('t', { ctrl: true });
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain('Goal: Hit 30 FPS');
    expect(frame).toContain('Tasks 0/3');
    setup.mockInput.pressKey(' ');
    await settle(setup);
    setup.mockInput.pressKey(' ');
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(frame).toContain('[x] profile');
    expect(frame).toContain('Tasks 1/3');
    setup.mockInput.pressArrow('down');
    setup.mockInput.pressKey(' ');
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(frame).toContain('[~] cull');
  });

  test('agent proposals need acceptance; reject keeps the plan', async () => {
    const backend = backendWithSession();
    backend.messages['ses_a']?.push({
      kind: 'assistant',
      id: 'm3',
      createdAt: 4,
      completedAt: 5,
      agent: 'build',
      model: { providerID: 'opencode', modelID: 'longcat' },
      parts: [{ kind: 'text', text: ['Plan:', '1. Measure', '2. Fix'].join('\n') }],
    });
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    for (const command of ['/plan keep me', '/plan adopt']) {
      await setup.mockInput.typeText(command);
      setup.mockInput.pressEnter();
      await settle(setup);
    }
    expect(setup.captureCharFrame()).toContain('Proposed plan');
    setup.mockInput.pressKey('r');
    await settle(setup);
    expect(controller.goalOf('ses_a')?.plan?.tasks.map((task) => task.title)).toEqual(['keep me']);
    await setup.mockInput.typeText('/plan adopt');
    setup.mockInput.pressEnter();
    await settle(setup);
    setup.mockInput.pressKey('a');
    await settle(setup);
    expect(controller.goalOf('ses_a')?.plan?.tasks.map((task) => task.title)).toEqual([
      'Measure',
      'Fix',
    ]);
  });

  test('/export writes every page of the chat as JSON; Ctrl+B backgrounds running tools', async () => {
    const backend = backendWithSession();
    backend.messages['ses_a'] = Array.from({ length: 1200 }, (_, index) => ({
      kind: 'user' as const,
      id: `m${index}`,
      createdAt: index,
      text: `message ${index}`,
      attachments: [],
    }));
    const written: { path: string; text: string }[] = [];
    const controller = new AppController({
      backend,
      config: defaultConfig,
      localState: emptyState,
      platform: 'linux',
      cwd: '/work/kohjoh',
      version: '0.0.1',
      now: () => 10_000,
      saveLocalState: async () => {},
      listFiles: async () => [],
      requestExit: () => {},
      writeFile: async (path, text) => {
        written.push({ path, text });
      },
    });
    await controller.bootstrap();
    controller.openSession('ses_a');
    await Bun.sleep(20);
    controller.setComposer(composerFrom('/export'));
    await controller.submit();
    expect(written).toHaveLength(1);
    const log: unknown = JSON.parse(written[0]?.text ?? '{}');
    expect(log).toMatchObject({ format: 'margarita.chatlog.v1' });
    const messages: unknown = isRecord(log) ? log['messages'] : [];
    expect(
      Array.isArray(messages)
        ? messages.map((message) => (isRecord(message) ? message['id'] : ''))
        : [],
    ).toEqual(Array.from({ length: 1200 }, (_, index) => `m${index}`));
    expect(written[0]?.path).toContain('marg-ses_a.json');

    await controller.backgroundTools();
    expect(backend.calls.some((call) => call.name === 'backgroundTools')).toBe(false);
    backend.active.add('ses_a');
    await controller.bootstrap();
    await controller.backgroundTools();
    expect(backend.calls.some((call) => call.name === 'backgroundTools')).toBe(true);
    controller.dispose();
  });

  test('/revert stages, Esc restores; /rename and /fork call the server', async () => {
    const backend = backendWithSession();
    backend.revertFiles = [
      { file: 'a.ts', patch: '', additions: 2, deletions: 1, status: 'modified', truncated: false },
    ];
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    await setup.mockInput.typeText('/revert');
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain('a.ts  +2 −1');
    setup.mockInput.pressEscape();
    await settle(setup);
    expect(backend.calls.some((call) => call.name === 'clearRevert')).toBe(true);
    expect(backend.calls.some((call) => call.name === 'commitRevert')).toBe(false);
    await setup.mockInput.typeText('/rename Faster');
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(controller.state.sessions['ses_a']?.title).toBe('Faster');
    await setup.mockInput.typeText('/fork');
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(backend.calls.some((call) => call.name === 'forkSession')).toBe(true);
    expect(controller.currentSession()?.id).not.toBe('ses_a');
  });
});

function richTurn(index: number) {
  return [
    {
      kind: 'user' as const,
      id: `u${index}`,
      createdAt: index * 10,
      text: `question number ${index}`,
      attachments: [],
    },
    {
      kind: 'assistant' as const,
      id: `a${index}`,
      createdAt: index * 10 + 1,
      completedAt: index * 10 + 2,
      agent: 'build',
      model: { providerID: 'opencode', modelID: 'longcat' },
      parts: [
        {
          kind: 'text' as const,
          text: `## Answer ${index}\n\n${Array.from({ length: 6 }, (_, line) => `- point ${line}`).join('\n')}`,
        },
        {
          kind: 'tool' as const,
          tool: {
            id: `t${index}`,
            name: 'edit',
            status: 'completed' as const,
            input: { filePath: 'src/a.ts', oldString: 'const a = 1;', newString: 'const a = 2;' },
            startedAt: 1,
            completedAt: 2,
          },
        },
      ],
    },
  ];
}

function richBackend(): FakeBackend {
  const backend = backendWithSession();
  backend.messages = { ses_a: [1, 2, 3, 4].flatMap(richTurn) };
  return backend;
}

function assembleTurn(id: string, at: number): TranscriptMessage[] {
  return [
    { kind: 'user', id: `u${id}`, createdAt: at, text: `ask ${id}`, attachments: [] },
    {
      kind: 'assistant' as const,
      id: `a${id}`,
      createdAt: at + 10,
      completedAt: at + 100,
      agent: 'build',
      model: { providerID: 'opencode', modelID: 'longcat' },
      parts: [{ kind: 'text' as const, text: `answer ${id}` }],
    },
    { kind: 'idle' as const, id: `i${id}`, createdAt: at + 110, outcome: 'succeeded' as const },
  ];
}

function twoTurns(backend: FakeBackend) {
  backend.messages = {
    ses_a: [...assembleTurn('one', 1_000), ...assembleTurn('two', 1_000_000)],
  };
  return backend;
}

describe('execution markers (issue #28)', () => {
  test('each completed execution keeps its own static marker between the right turns', async () => {
    const backend = twoTurns(backendWithSession());
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    const frame = setup.captureCharFrame();
    const markerLines = frame.split('\n').filter((line) => line.includes('Completed'));
    expect(markerLines).toHaveLength(2);
    // The first marker appears before the second turn's user prompt.
    const first = markerLines[0] ?? '';
    const second = markerLines[1] ?? '';
    expect(first).not.toEqual(second);
    controller.dispose();
  });

  test('a running segment animates; a queued follow-up does not reset the timer', async () => {
    const backend = backendWithSession();
    backend.active = new Set(['ses_a']);
    backend.messages = {
      ses_a: [{ kind: 'user', id: 'u1', createdAt: 1, text: 'work on it', attachments: [] }],
    };
    backend.inbox = [
      { id: 'in_1', kind: 'user', delivery: 'queue', text: 'queued follow-up', createdAt: 2 },
    ];
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    const frame = setup.captureCharFrame();
    const liveVerbs = /(Thinking|Tinkering|Pondering|Untangling|Mulling|Noodling)…/g;
    expect(frame.match(liveVerbs)).toHaveLength(1);
    controller.dispose();
  });

  test('an interrupted turn gets a distinct Interrupted marker, not a spinner', async () => {
    const backend = backendWithSession();
    backend.messages = {
      ses_a: [
        { kind: 'user', id: 'u1', createdAt: 1, text: 'work on it', attachments: [] },
        {
          kind: 'assistant' as const,
          id: 'a1',
          createdAt: 2,
          completedAt: 3,
          agent: 'build',
          model: { providerID: 'opencode', modelID: 'longcat' },
          parts: [{ kind: 'text' as const, text: 'partial' }],
        },
        { kind: 'idle' as const, id: 'i1', createdAt: 4, outcome: 'interrupted' as const },
      ],
    };
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Interrupted');
    expect(frame).not.toMatch(/(Thinking|Tinkering)…/);
    controller.dispose();
  });
});

describe('live activity indicator (issues 24, 25)', () => {
  test('unfinished empty reasoning produces no placeholder row; exactly one throbber', async () => {
    const backend = backendWithSession();
    backend.active = new Set(['ses_a']);
    backend.messages = {
      ses_a: [
        { kind: 'user', id: 'm1', createdAt: 1, text: 'why is it slow?', attachments: [] },
        {
          kind: 'assistant',
          id: 'm2',
          createdAt: 2,
          agent: 'build',
          model: { providerID: 'opencode', modelID: 'longcat' },
          parts: [
            { kind: 'reasoning', text: '', done: false },
            { kind: 'text', text: 'The frame budget is exceeded.' },
          ],
        },
      ],
    };
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain('∴');
    const liveVerbs = /(Thinking|Tinkering|Pondering|Untangling|Mulling|Noodling)…/g;
    expect(frame.match(liveVerbs)).toHaveLength(1);
  });

  test('detailed mode shows authentic in-progress reasoning with labeling', async () => {
    const backend = backendWithSession();
    backend.active = new Set(['ses_a']);
    backend.messages = {
      ses_a: [
        { kind: 'user', id: 'm1', createdAt: 1, text: 'hi', attachments: [] },
        {
          kind: 'assistant',
          id: 'm2',
          createdAt: 2,
          agent: 'build',
          model: { providerID: 'opencode', modelID: 'longcat' },
          parts: [
            { kind: 'reasoning', text: 'consider the frame budget', done: false },
            { kind: 'text', text: 'Working.' },
          ],
        },
      ],
    };
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    setup.mockInput.pressKey('o', { ctrl: true });
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('∴ Reasoning (in progress…)');
    expect(frame).toContain('consider the frame budget');
  });

  test('a running compaction reuses the throbber verb; terminal state lands as one row', async () => {
    const backend = backendWithSession();
    backend.active = new Set(['ses_a']);
    const running = [
      { kind: 'user' as const, id: 'm1', createdAt: 1, text: 'hi', attachments: [] },
      {
        kind: 'assistant' as const,
        id: 'm2',
        createdAt: 2,
        agent: 'build',
        model: { providerID: 'opencode', modelID: 'longcat' },
        parts: [{ kind: 'reasoning' as const, text: '', done: false }],
      },
      { kind: 'compaction' as const, id: 'c1', createdAt: 3, state: 'running' as const },
    ];
    backend.messages = { ses_a: running };
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame.split('Compacting conversation…').length - 1).toBe(1);
    expect(frame).not.toContain('∴');

    // Server says the compaction landed: throbber resumes from agent state, one dim row.
    backend.messages = {
      ses_a: [
        ...running.slice(0, 2),
        { kind: 'compaction' as const, id: 'c1', createdAt: 3, state: 'completed' as const },
      ],
    };
    controller.onEvents('local', [], true);
    await settle(setup);
    await settle(setup);
    const done = setup.captureCharFrame();
    expect(done).toContain('Conversation compacted');
    expect(done).not.toContain('Compacting conversation…');
  });
});

function editDiffBackend(tool: {
  id: string;
  name: string;
  input: Record<string, unknown>;
  diff?: string;
  diffFile?: string;
}) {
  const backend = backendWithSession();
  backend.messages = {
    ses_a: [
      { kind: 'user', id: 'm1', createdAt: 1, text: 'change it', attachments: [] },
      {
        kind: 'assistant' as const,
        id: 'm2',
        createdAt: 2,
        completedAt: 3,
        agent: 'build',
        model: { providerID: 'opencode', modelID: 'longcat' },
        parts: [
          {
            kind: 'tool' as const,
            tool: {
              id: tool.id,
              name: tool.name,
              status: 'completed' as const,
              input: tool.input,
              startedAt: 2,
              completedAt: 3,
              ...(tool.diff === undefined ? {} : { diff: tool.diff }),
              ...(tool.diffFile === undefined ? {} : { diffFile: tool.diffFile }),
            },
          },
        ],
      },
    ],
  };
  return backend;
}

describe('successful edit diffs (issue #22)', () => {
  test('an edit with a server-provided patch renders the diff, not a bare row', async () => {
    const backend = editDiffBackend({
      id: 'e1',
      name: 'edit',
      input: { path: 'src/a.ts', oldString: 'x', newString: 'y' },
      diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y',
    });
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Update(src/a.ts)');
    expect(frame).toContain('1 + y');
    expect(frame).toContain('Added 1 line');
    controller.dispose();
  });

  test('a completed edit-like call with no patch data reports it explicitly', async () => {
    const backend = editDiffBackend({
      id: 'e2',
      name: 'write',
      input: { path: 'src/a.ts' },
    });
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Changed(src/a.ts)');
    expect(frame).toContain('diff unavailable for this change');
    controller.dispose();
  });
});

describe('oversized inline diff clamping (issue 27)', () => {
  test('a 140-line write diff is clamped; Enter expands only that row; Enter collapses again', async () => {
    const content = Array.from({ length: 140 }, (_, index) => `row${index}`).join('\n');
    const backend = backendWithSession();
    backend.messages = {
      ses_a: [
        { kind: 'user', id: 'm1', createdAt: 1, text: 'write it', attachments: [] },
        {
          kind: 'assistant',
          id: 'm2',
          createdAt: 2,
          completedAt: 3,
          agent: 'build',
          model: { providerID: 'opencode', modelID: 'longcat' },
          parts: [
            {
              kind: 'tool',
              tool: {
                id: 'w1',
                name: 'write',
                status: 'completed',
                input: { filePath: 'src/app/debug-log.ts', content },
                startedAt: 2,
                completedAt: 3,
              },
            },
          ],
        },
      ],
    };
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    const frame = setup.captureCharFrame();
    // The header may scrolled out of the 24-row viewport; the clamp row is pinned at the bottom.
    expect(frame).toContain('… 127 more lines · Enter to expand');
    expect(frame).not.toContain('row139');

    setup.mockInput.pressArrow('down', { ctrl: true });
    await settle(setup);
    expect(controller.state.focusedGroup).toBe('diff:w1');
    expect(setup.captureCharFrame()).toContain('▸ … 127 more lines');

    setup.mockInput.pressEnter();
    await settle(setup);
    expect(controller.state.expandedDiffs['ses_a w1']).toBe(true);
    expect(setup.captureCharFrame()).not.toContain('more lines · Enter to expand');
    expect(controller.state.composer.text).toBe(''); // not a submit, not a draft

    setup.mockInput.pressEnter();
    await settle(setup);
    expect(controller.state.expandedDiffs['ses_a w1']).toBeUndefined();
    expect(setup.captureCharFrame()).toContain('… 127 more lines · Enter to expand');
  });

  test('a three-line diff renders completely with no clamp indicator', async () => {
    const backend = backendWithSession();
    backend.messages = {
      ses_a: [
        { kind: 'user', id: 'm1', createdAt: 1, text: 'fix it', attachments: [] },
        {
          kind: 'assistant',
          id: 'm2',
          createdAt: 2,
          completedAt: 3,
          agent: 'build',
          model: { providerID: 'opencode', modelID: 'longcat' },
          parts: [
            {
              kind: 'tool',
              tool: {
                id: 'e1',
                name: 'edit',
                status: 'completed',
                input: { filePath: 'src/app/debug-log.ts', oldString: 'old', newString: 'new' },
                startedAt: 2,
                completedAt: 3,
              },
            },
          ],
        },
      ],
    };
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Added 1 line');
    expect(frame).not.toContain('more lines');
  });
});

describe('transcript rendering (docs/22, docs/23)', () => {
  test('renders markdown, diff gutter and a sticky header for an earlier prompt', async () => {
    const { controller, setup } = await mount(richBackend());
    controller.openSession('ses_a');
    await settle(setup);
    const bottom = setup.captureCharFrame();
    if (process.env['DUMP'] !== undefined) console.log(bottom);
    expect(bottom).not.toContain('## Answer');
    expect(bottom).toContain('Answer 4');
    expect(bottom).toContain('const a = 2;');
    // The latest prompt is visible, so it is not duplicated as a sticky copy.
    expect(bottom.split('question number 4').length).toBe(2);

    setup.mockInput.pressKey(pageUp);
    await settle(setup);
    const middle = setup.captureCharFrame();
    if (process.env['DUMP'] !== undefined) console.log(middle);
    const header = /^ ❯ question number (\d)/.exec(middle.split('\n')[0] ?? '');
    expect(header).not.toBeNull();
    // The header names a prompt that is not also in the viewport body.
    expect(middle.split(`question number ${header?.[1]}`).length).toBe(2);

    for (let page = 0; page < 20; page += 1) setup.mockInput.pressKey(pageUp);
    await settle(setup);
    const top = setup.captureCharFrame();
    if (process.env['DUMP'] !== undefined) console.log(top);
    // At the very top the original prompts are visible, so nothing is duplicated.
    expect(top.split('question number 1').length).toBe(2);
  });
});

function runningWithQueue(): FakeBackend {
  const backend = backendWithSession();
  backend.active = new Set(['ses_a']);
  backend.messages = {
    ses_a: [{ kind: 'user', id: 'm1', createdAt: 1, text: 'work on it', attachments: [] }],
  };
  backend.inbox = [
    { id: 'in_1', kind: 'user', delivery: 'queue', text: 'first follow-up', createdAt: 2 },
    {
      id: 'in_2',
      kind: 'user',
      delivery: 'queue',
      text: 'second follow-up,\nmultiline note',
      createdAt: 3,
    },
  ];
  return backend;
}

describe('queued messages preview (issue #29)', () => {
  const verb = /(Thinking|Tinkering|Pondering|Untangling|Mulling|Noodling)…/;

  test('queued follow-ups render above the active throbber and below the transcript, FIFO, with the send-now hint', async () => {
    const backend = runningWithQueue();
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    const frame = setup.captureCharFrame();

    const queued1 = frame.indexOf('first follow-up');
    const queued2 = frame.indexOf('second follow-up');
    const hint = frame.indexOf('f6 to steer now');
    const marker = frame.search(verb);
    const composerPlaceholder = frame.lastIndexOf('← overview');

    expect(queued1).toBeGreaterThanOrEqual(0);
    expect(queued2).toBeGreaterThan(queued1);
    // The send-now hint hangs under the FIFO-first item, above the second item's row.
    expect(hint).toBeGreaterThan(queued1);
    expect(hint).toBeLessThan(queued2);
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(queued2);
    expect(marker).toBeLessThan(composerPlaceholder);
    // The hint appears exactly once (only for the FIFO-next item).
    expect(frame.match(/f6 to steer now/g)).toHaveLength(1);
    // The multiline item is clipped to one line.
    expect(frame).not.toContain('multiline note\n');
    controller.dispose();
  });

  test('Ctrl+Enter via the kitty keyboard protocol promotes the oldest queued item', async () => {
    const backend = runningWithQueue();
    const { controller, setup } = await mount(backend, { kittyKeyboard: true });
    controller.openSession('ses_a');
    await settle(setup);

    setup.mockInput.pressKey('RETURN', { ctrl: true });
    await settle(setup);

    expect(backend.calls).toEqual(
      expect.arrayContaining([{ name: 'changeDelivery', args: ['ses_a', 'in_1', 'steer'] }]),
    );
    expect(controller.state.inbox['ses_a']?.find((item) => item.id === 'in_1')?.delivery).toBe(
      'steer',
    );
    controller.dispose();
  });

  test('F6 with a draft steers the draft as a steer, without touching the queue', async () => {
    const backend = runningWithQueue();
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);

    await setup.mockInput.typeText('hurry up');
    await settle(setup);
    setup.mockInput.pressKey('F6');
    await settle(setup);

    const prompt = backend.calls.find((call) => call.name === 'prompt');
    expect(prompt?.args[0]).toBe('ses_a');
    expect(prompt?.args[1]).toMatchObject({ text: 'hurry up', delivery: 'steer' });
    expect(backend.calls.filter((call) => call.name === 'changeDelivery')).toHaveLength(0);
    controller.dispose();
  });

  test('F6 on an empty composer promotes the oldest queued item to steer; failure leaves it queued', async () => {
    const backend = runningWithQueue();
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);

    setup.mockInput.pressKey('F6');
    await settle(setup);

    expect(backend.calls).toEqual(
      expect.arrayContaining([{ name: 'changeDelivery', args: ['ses_a', 'in_1', 'steer'] }]),
    );
    // The item is now a steering item; the hint moved down the FIFO line.
    const promoted = controller.state.inbox['ses_a']?.find((item) => item.id === 'in_1');
    expect(promoted?.delivery).toBe('steer');
    const frame = setup.captureCharFrame();
    expect(frame).toContain('first follow-up');
    expect(frame).toContain('second follow-up');
    expect(frame.match(/f6 to steer now/g)).toHaveLength(1);
    // Existing in-flight delivery failure leaves the item queued.
    controller.dispose();
  });

  test('a failing promote reports the error and leaves the item visibly queued', async () => {
    const backend = runningWithQueue();
    backend.changeDelivery = async () => {
      throw new BackendError('transport', 'session.inbox.delivery-change', 'busy');
    };
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);

    setup.mockInput.pressKey('F6');
    await settle(setup);

    expect(controller.state.notice?.text).toContain('busy');
    expect(controller.state.inbox['ses_a']?.map((item) => item.delivery)).toEqual([
      'queue',
      'queue',
    ]);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('first follow-up');
    expect(frame).toContain('f6 to steer now');
    controller.dispose();
  });

  test('no queued preview when the inbox is empty or the other session has nothing queued', async () => {
    const backend = runningWithQueue();
    backend.sessions.push({
      id: 'ses_b',
      serverID: 'local',
      projectID: 'p',
      directory: '/work/kohjoh',
      title: 'other',
      agent: 'build',
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      createdAt: 2,
      updatedAt: 2,
      archived: false,
    });
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    controller.openSession('ses_b');
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain('f6 to steer now');
    expect(frame).not.toContain('first follow-up');
    controller.dispose();
  });

  test('once the server delivers, the preview disappears and the canonical user message renders', async () => {
    const backend = runningWithQueue();
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);

    // The server admits both items into the transcript and clears the inbox.
    backend.inbox = [];
    backend.messages = {
      ses_a: [
        { kind: 'user', id: 'm1', createdAt: 1, text: 'work on it', attachments: [] },
        { kind: 'user', id: 'm2', createdAt: 5, text: 'first follow-up', attachments: [] },
        {
          kind: 'user',
          id: 'm3',
          createdAt: 6,
          text: 'second follow-up,\nmultiline note',
          attachments: [],
        },
      ],
    };
    controller.openSession('ses_a');
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).not.toContain('f6 to steer now');
    expect(frame).toContain('first follow-up');
    controller.dispose();
  });
});

/** Diff rows of a rendered frame, by content line (line-gutter text included). */
function diffLines(frame: string): string[] {
  return frame.split('\n').filter((line) => /row\d+/.test(line));
}
/** Trailing cell is the scrollbar's glyph; compare content cells only. */
function normalizeFrameLine(line: string | undefined): string | undefined {
  return line?.replace(/[\s▄▀▁▂▃▅▆▇█]+$/u, '');
}

describe('inline diff stability (issue #26)', () => {
  test('a fixed 140-line highlighted diff captures stable frames under repeated and unrelated updates', async () => {
    const content = Array.from({ length: 140 }, (_, index) => `row${index}`).join('\n');
    const backend = backendWithSession();
    const messages: NonNullable<(typeof backend.messages)[string]> = [
      { kind: 'user', id: 'm1', createdAt: 1, text: 'write it', attachments: [] },
      {
        kind: 'assistant',
        id: 'm2',
        createdAt: 2,
        completedAt: 3,
        agent: 'build',
        model: { providerID: 'opencode', modelID: 'longcat' },
        parts: [
          {
            kind: 'tool',
            tool: {
              id: 'w1',
              name: 'write',
              status: 'completed',
              input: { filePath: 'src/app/debug-log.ts', content },
              startedAt: 2,
              completedAt: 3,
            },
          },
        ],
      },
    ];
    backend.messages = { ses_a: messages };
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);

    // Expand the clamped 140-line write diff to the full <diff> renderable.
    setup.mockInput.pressArrow('down', { ctrl: true });
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(controller.state.expandedDiffs['ses_a w1']).toBe(true);

    // Warm up: lay out and paint the expanded diff.
    await settle(setup);
    const warm = setup.captureCharFrame();
    const baseline = diffLines(warm);
    expect(baseline.length).toBeGreaterThan(0);
    // No state change: repeated frames are byte-identical, the diff never blanks.
    for (let index = 0; index < 5; index += 1) {
      await settle(setup);
      expect(setup.captureCharFrame()).toBe(warm);
    }

    // Unrelated update below the diff: a new user message appended to the turn.
    // Legitimately changed rows aside, the visible diff rows render byte-identically.
    backend.messages = {
      ses_a: [
        ...messages,
        { kind: 'user', id: 'm3', createdAt: 9, text: 'and then ship it', attachments: [] },
      ],
    };
    controller.openSession('ses_a');
    await settle(setup);
    const after = setup.captureCharFrame();
    expect(after).toContain('and then ship it');
    // The viewport may scroll by the appended row; every diff row visible in both frames renders byte-identically.
    const keyed = (frame: string) =>
      new Map(diffLines(frame).map((line) => [/row\d+/.exec(line)?.[0] ?? '', line]));
    const before = keyed(warm);
    const now = keyed(after);
    const shared = [...before.keys()].filter((row) => now.has(row));
    expect(shared.length).toBeGreaterThanOrEqual(10);
    for (const row of shared) {
      expect(normalizeFrameLine(now.get(row))).toBe(normalizeFrameLine(before.get(row)));
    }

    controller.dispose();
  });
});

function groupedBashPart(id: string) {
  return {
    kind: 'tool' as const,
    tool: {
      id,
      name: 'bash',
      status: 'completed' as const,
      input: { command: `bun run ${id}`, filePath: `${id}.log` },
      startedAt: 2,
      completedAt: 3,
    },
  };
}
function groupedEditPart(
  id: string,
  filePath: string,
  status: 'completed' | 'error' = 'completed',
) {
  return {
    kind: 'tool' as const,
    tool: {
      id,
      name: 'edit',
      status,
      input: { filePath },
      startedAt: 2,
      completedAt: 3,
      ...(status === 'error' ? { error: 'exit 1' } : {}),
    },
  };
}

function groupedBackend(): FakeBackend {
  const backend = backendWithSession();
  const model = { providerID: 'opencode', modelID: 'longcat' };
  backend.messages = {
    ses_a: [
      { kind: 'user', id: 'm1', createdAt: 1, text: 'rewrite the renderer', attachments: [] },
      {
        kind: 'assistant',
        id: 'mA',
        createdAt: 2,
        agent: 'build',
        model,
        parts: [
          ...Array.from({ length: 10 }, (_, index) => groupedBashPart(`s${index}`)),
          { kind: 'text', text: 'Running the build.' },
          {
            kind: 'tool',
            tool: {
              id: 'read1',
              name: 'read',
              status: 'completed',
              input: { filePath: 'a.ts' },
              startedAt: 3,
              completedAt: 4,
            },
          },
          {
            kind: 'tool',
            tool: {
              id: 'read2',
              name: 'read',
              status: 'completed',
              input: { filePath: 'b.ts' },
              startedAt: 3,
              completedAt: 4,
            },
          },
        ],
      },
      {
        kind: 'assistant',
        id: 'mB',
        createdAt: 5,
        agent: 'build',
        model,
        parts: [
          ...Array.from({ length: 6 }, (_, index) => groupedEditPart(`e${index}`, 'src/index.ts')),
          groupedBashPart('s10'),
        ],
      },
      {
        kind: 'assistant',
        id: 'mC',
        createdAt: 6,
        agent: 'build',
        model,
        parts: [groupedEditPart('eFailed', 'src/fixed.ts', 'error')],
      },
      {
        kind: 'assistant',
        id: 'mD',
        createdAt: 7,
        completedAt: 8,
        agent: 'build',
        model,
        parts: [
          {
            kind: 'text',
            text: 'The rewrite is complete: tests are green and the diff is ready.',
          },
        ],
      },
    ],
  };
  return backend;
}

function liveBackend(): FakeBackend {
  const backend = backendWithSession();
  const model = { providerID: 'opencode', modelID: 'longcat' };
  backend.mcpServers = ['lotus'];
  backend.messages = {
    ses_a: [
      { kind: 'user', id: 'm1', createdAt: 1, text: 'check the deploy', attachments: [] },
      {
        kind: 'assistant',
        id: 'mA',
        createdAt: 2,
        agent: 'build',
        model,
        parts: [
          groupedBashPart('s0'),
          groupedBashPart('s1'),
          {
            kind: 'tool',
            tool: {
              id: 'live',
              name: 'lotus_get_issue',
              status: 'running',
              input: { issue: '7' },
              startedAt: 9,
            },
          },
        ],
      },
    ],
  };
  backend.active = new Set(['ses_a']);
  return backend;
}

describe('grouped activity (issue #23)', () => {
  test('compact frame shows a few grouped rows, the visible failure and the final reply', async () => {
    const { controller, setup } = await mount(groupedBackend());
    controller.openSession('ses_a');
    await settle(setup);
    const frame = setup.captureCharFrame();

    expect(frame).toContain('Ran 10 shell commands');
    expect(frame).toContain('edited 6 files');
    // The lone failure stays visible with its error; its name is not folded away.
    expect(frame).toContain('edit src/fixed.ts');
    expect(frame).toContain('exit 1');
    // The final reply is visible.
    expect(frame).toContain('The rewrite is complete');
    // Short assistant prose is never silently dropped (#167); tools still fold away.
    expect(frame).toContain('Running the build.');
    expect(frame).not.toContain('bash s0.log');
    expect(frame).not.toContain('Update(src/index.ts)');

    controller.toggleDetails();
    await settle(setup);
    const detailedFrame = setup.captureCharFrame();
    // Tall detailed transcript: viewport is bottom-anchored; individual calls are visible.
    expect(detailedFrame).toContain('Changed(src/index.ts)');
    expect(detailedFrame).toContain('bash s10.log');
    expect(detailedFrame).toContain('edit src/fixed.ts');
    controller.dispose();
  });
});

describe('live action beneath a collapsed group (issue #75)', () => {
  test('a collapsed group shows the executing call without Ctrl+O', async () => {
    const { controller, setup } = await mount(liveBackend());
    controller.openSession('ses_a');
    await settle(setup);
    const frame = setup.captureCharFrame();

    expect(frame).toContain('Ran 2 shell commands, called lotus 1 time…');
    // The live line names the executing MCP call on its own row beneath the group.
    expect(frame).toContain('└ lotus: get_issue');
    // It is not the historical group that shows a fake action: the running one only.
    expect(frame).not.toContain('└ $ bun run');
    controller.dispose();
  });

  test('the background hint appears under a shell call only after 10 seconds (issue #76)', async () => {
    let clock = 5_000;
    const backend = backendWithSession();
    const model = { providerID: 'opencode', modelID: 'longcat' };
    backend.messages = {
      ses_a: [
        { kind: 'user', id: 'm1', createdAt: 1, text: 'run the suite', attachments: [] },
        {
          kind: 'assistant',
          id: 'mA',
          createdAt: 2,
          agent: 'build',
          model,
          parts: [
            { kind: 'text', text: 'Starting.' },
            {
              kind: 'tool',
              tool: {
                id: 's',
                name: 'shell',
                status: 'running',
                input: { command: 'bun test' },
                startedAt: 4_000,
              },
            },
          ],
        },
      ],
    };
    backend.active = new Set(['ses_a']);
    const { controller, setup } = await mount(backend, {
      now: () => clock,
      hintTickMs: 20,
    });
    controller.openSession('ses_a');
    await settle(setup);

    // 1s elapsed: the command is named, but there is no hint yet.
    let frame = setup.captureCharFrame();
    expect(frame).toContain('└ $ bun test');
    expect(frame).not.toContain('Ctrl+B to move to background');

    // Past 10s: the hint appears directly beneath the command.
    clock = 14_100;
    await Bun.sleep(50);
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    expect(frame).toContain('└ $ bun test');
    expect(frame).toContain('Ctrl+B to move to background');
    controller.dispose();
  });

  test('backgrounding keeps the composer anchored and puts the status in the transcript (#129)', async () => {
    const backend = liveShellBackend('running', 0);
    const { controller, setup } = await mount(backend, { now: () => 20_000 });
    controller.openSession('ses_a');
    await settle(setup);
    const before = setup.captureCharFrame();
    const beforeY = footerY(before);
    expect(before).not.toContain('Moved to background');

    await controller.backgroundTools();
    await settle(setup);
    const after = setup.captureCharFrame();
    expect(after).toContain('Moved to background');
    expect(footerY(after)).toBe(beforeY);
    expect(backend.calls.some((call) => call.name === 'backgroundTools')).toBe(true);
    controller.dispose();
  });

  test('each background confirmation stays under its own call when tools follow (#135)', async () => {
    const backend = new FakeBackend();
    backend.sessions = [
      {
        id: 'ses_a',
        serverID: 'local',
        projectID: 'p',
        directory: '/work/kohjoh',
        title: 'Two tools',
        agent: 'build',
        tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        createdAt: 1,
        updatedAt: 2,
        archived: false,
      },
    ];
    backend.messages = {
      ses_a: [
        { kind: 'user', id: 'u1', createdAt: 1, text: 'run both', attachments: [] },
        {
          kind: 'assistant',
          id: 'mA',
          createdAt: 2,
          agent: 'build',
          model: { providerID: 'opencode', modelID: 'longcat' },
          parts: [
            {
              kind: 'tool',
              tool: {
                id: 's1',
                name: 'bash',
                status: 'running',
                input: { command: 'bun test' },
                startedAt: 2,
              },
            },
            {
              kind: 'tool',
              tool: {
                id: 's2',
                name: 'bash',
                status: 'running',
                input: { command: 'cargo test' },
                startedAt: 2,
              },
            },
          ],
        },
      ],
    };
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    controller.toggleDetails();
    await settle(setup);
    controller.onEvents(
      'local',
      [{ kind: 'execution', sessionID: 'ses_a', state: 'started' }],
      false,
    );
    await settle(setup);
    await controller.backgroundTools();
    await settle(setup);

    const frame = setup.captureCharFrame();
    const firstCall = frame.indexOf('bun test');
    const notice = frame.indexOf('Moved to background');
    const laterCall = frame.indexOf('cargo test');
    expect(firstCall).toBeGreaterThanOrEqual(0);
    expect(notice).toBeGreaterThan(firstCall);
    expect(laterCall).toBeGreaterThan(notice);
    expect(frame.match(/Moved to background/g)).toHaveLength(2);
    controller.dispose();
  });
});

/** One shell call in a foldable group; `startedAt` is chosen relative to `now` per test. */
function liveShellBackend(status: 'running' | 'completed' = 'running', startedAt = 0): FakeBackend {
  const backend = new FakeBackend();
  backend.sessions = [
    {
      id: 'ses_a',
      serverID: 'local',
      projectID: 'p',
      directory: '/work/kohjoh',
      title: 'Live shell',
      agent: 'build',
      tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    },
  ];
  backend.messages = {
    ses_a: [
      { kind: 'user', id: 'm1', createdAt: 1, text: 'run it', attachments: [] },
      {
        kind: 'assistant',
        id: 'mA',
        createdAt: 2,
        agent: 'build',
        model: { providerID: 'opencode', modelID: 'longcat' },
        parts: [
          {
            kind: 'tool',
            tool: {
              id: 's1',
              name: 'bash',
              status,
              input: { command: 'bun test' },
              startedAt,
              ...(status === 'completed' ? { completedAt: startedAt + 100 } : {}),
            },
          },
        ],
      },
    ],
  };
  backend.active = new Set(['ses_a']);
  return backend;
}

const countOccurrences = (frame: string, needle: string) => frame.split(needle).length - 1;
/** True when the only hint row sits immediately below the row containing `anchor`. */
const hintFollows = (frame: string, anchor: string) => {
  const lines = frame.split('\n');
  const index = lines.findIndex((line) => line.includes(anchor));
  return index >= 0 && (lines[index + 1] ?? '').includes('to move to background');
};

describe('expanded tool groups do not duplicate the running action (#111)', () => {
  test('collapsed shows one live row; expanded and detailed show one tool row each', async () => {
    const { controller, setup } = await mount(liveShellBackend());
    controller.openSession('ses_a');
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(countOccurrences(frame, '└ $ bun test')).toBe(1);
    expect(countOccurrences(frame, 'bash bun test')).toBe(0);

    controller.toggleGroup('group:s1');
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(countOccurrences(frame, 'bash bun test')).toBe(1);
    expect(countOccurrences(frame, '└ $ bun test')).toBe(0);

    // Ctrl+O detailed mode renders the call on its own, never a second live copy.
    controller.toggleDetails();
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(countOccurrences(frame, 'bash bun test')).toBe(1);
    expect(countOccurrences(frame, '└ $ bun test')).toBe(0);
    controller.dispose();
  });

  test('the 10s hint stays once and adjacent to the shell across expansion', async () => {
    const { controller, setup } = await mount(liveShellBackend('running', 0), {
      now: () => 15_000,
    });
    controller.openSession('ses_a');
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(countOccurrences(frame, 'to move to background')).toBe(1);
    expect(hintFollows(frame, '└ $ bun test')).toBe(true);

    controller.toggleGroup('group:s1');
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(countOccurrences(frame, 'bash bun test')).toBe(1);
    expect(countOccurrences(frame, '└ $ bun test')).toBe(0);
    expect(countOccurrences(frame, 'to move to background')).toBe(1);
    expect(hintFollows(frame, 'bash bun test')).toBe(true);
    controller.dispose();
  });

  test('a finished group never shows a live row or hint', async () => {
    const { controller, setup } = await mount(liveShellBackend('completed', 0), {
      now: () => 60_000,
    });
    controller.openSession('ses_a');
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(countOccurrences(frame, '└ $ bun test')).toBe(0);
    expect(countOccurrences(frame, 'to move to background')).toBe(0);
    controller.dispose();
  });
});

/** Two hosts, both owning `ses_same`, with different queued counts and goal readings. */
async function mountColliding() {
  const local = new FakeBackend();
  local.serverID = 'local';
  local.sessions = [
    {
      id: 'ses_same',
      serverID: 'local',
      projectID: 'p',
      directory: '/work/kohjoh',
      title: 'Local',
      createdAt: 1,
      updatedAt: 5,
      archived: false,
    },
  ];
  local.inbox = [
    { id: 'in_a', kind: 'user', delivery: 'queue', text: 'local queued', createdAt: 1 },
  ];
  local.inboxSession = { in_a: 'ses_same' };
  const remote = new FakeBackend();
  remote.serverID = 'srv_b';
  remote.sessions = [
    {
      id: 'ses_same',
      serverID: 'srv_b',
      projectID: 'p',
      directory: '/srv/app',
      title: 'Remote',
      createdAt: 1,
      updatedAt: 9,
      archived: false,
    },
  ];
  remote.inbox = [
    { id: 'in_b1', kind: 'user', delivery: 'queue', text: 'remote one', createdAt: 2 },
    { id: 'in_b2', kind: 'user', delivery: 'queue', text: 'remote two', createdAt: 3 },
  ];
  remote.inboxSession = { in_b1: 'ses_same', in_b2: 'ses_same' };
  const backends = new Map([
    ['local', local],
    ['srv_b', remote],
  ]);
  const controller = new AppController({
    backend: local,
    backendFor: (serverID: string) => backends.get(serverID),
    serverIDs: () => ['local', 'srv_b'],
    serverInfo: (serverID: string) =>
      serverID === 'local' ? undefined : { label: 'bravo', online: true },
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
  });
  await controller.bootstrap();
  const setup = await testRender(
    () =>
      App({
        controller,
        keymap: buildKeymap({}).keymap,
        theme: pickTheme({}),
        animate: false,
        ascii: false,
        env: {},
      }),
    { width: 90, height: 30 },
  );
  current = setup;
  await setup.renderOnce();
  return { controller, setup };
}

describe('server-qualified views in the UI (issue #78)', () => {
  test('the footer queued count follows the selected host', async () => {
    const { controller, setup } = await mountColliding();
    controller.openSession('ses_same', 'local');
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain('1 queued');

    controller.openSession('ses_same', 'srv_b');
    await settle(setup);
    frame = setup.captureCharFrame();
    // A bare-id lookup would show A's count here.
    expect(frame).toContain('2 queued');

    controller.dispose();
  });

  test('the queue dialog lists only the displayed host and steers there', async () => {
    const { controller, setup } = await mountColliding();
    controller.openSession('ses_same', 'srv_b');
    await settle(setup);
    controller.setOverlay({ kind: 'queue', index: 0 });
    await settle(setup);

    let frame = setup.captureCharFrame();
    expect(frame).toContain('remote one');
    expect(frame).toContain('remote two');
    expect(frame).not.toContain('local queued');

    // Cancelling from here addresses the remote host only.
    await controller.cancelQueued('in_b2');
    await settle(setup);
    const remote = controller.state.inbox['server:srv_b/session:ses_same'];
    expect(remote?.map((item) => item.id)).toEqual(['in_b1']);

    // Switching host changes what the dialog would show, and A's queue is intact.
    controller.openSession('ses_same', 'local');
    await settle(setup);
    expect(controller.state.inbox['ses_same']?.map((item) => item.id)).toEqual(['in_a']);
    frame = setup.captureCharFrame();
    expect(frame).toContain('local queued');
    expect(frame).not.toContain('remote one');
    controller.dispose();
  });
});

async function mountProjects(
  options: {
    themeName?: 'dark' | 'light' | 'high-contrast';
    ascii?: boolean;
    noColor?: boolean;
  } = {},
) {
  const local = new FakeBackend();
  local.serverID = 'local';
  local.sessions = [
    {
      id: 'ses_a',
      serverID: 'local',
      projectID: 'p',
      directory: '/work/kohjoh',
      title: 'Local refactor',
      createdAt: 1,
      updatedAt: 5,
      archived: false,
    },
    {
      id: 'ses_d',
      serverID: 'local',
      projectID: 'p',
      directory: '/work/kohjoh',
      title: 'Needs a decision',
      createdAt: 1,
      updatedAt: 6,
      archived: false,
    },
  ];
  local.active = new Set(['ses_d']);
  local.permissions = [
    { id: 'per_a', sessionID: 'ses_d', action: 'bash deploy', resources: [], save: [] },
  ];
  const bravo = new FakeBackend();
  bravo.serverID = 'srv_b';
  bravo.sessions = [
    {
      id: 'ses_b',
      serverID: 'srv_b',
      projectID: 'p',
      directory: '/srv/app',
      title: 'Bravo build',
      createdAt: 1,
      updatedAt: 9,
      archived: false,
    },
  ];
  bravo.active = new Set(['ses_b']);
  const charlie = new FakeBackend();
  charlie.serverID = 'srv_c';
  charlie.sessions = [
    {
      id: 'ses_c',
      serverID: 'srv_c',
      projectID: 'p',
      directory: '/srv/app',
      title: 'Charlie build',
      createdAt: 1,
      updatedAt: 8,
      archived: false,
      outcome: 'failed',
    },
  ];
  const backends = new Map([
    ['local', local],
    ['srv_b', bravo],
    ['srv_c', charlie],
  ]);
  const controller = new AppController({
    backend: local,
    backendFor: (serverID: string) => backends.get(serverID),
    serverIDs: () => ['local', 'srv_b', 'srv_c'],
    serverInfo: (serverID: string) =>
      serverID === 'local'
        ? undefined
        : { label: serverID === 'srv_b' ? 'bravo' : 'charlie', online: true },
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/kohjoh',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
  });
  await controller.bootstrap();
  const theme =
    options.noColor === true ? pickTheme({ NO_COLOR: '1' }) : pickTheme({}, options.themeName);
  const setup = await testRender(
    () =>
      App({
        controller,
        keymap: buildKeymap({}).keymap,
        theme,
        animate: false,
        ascii: options.ascii ?? false,
        env: {},
      }),
    { width: 80, height: 32 },
  );
  current = setup;
  await setup.renderOnce();
  return { controller, setup };
}

function hexOf(color: { toInts(): readonly [number, number, number, number] }): string {
  const [r, g, b] = color.toInts();
  return `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
}

function spanDump(setup: Setup) {
  return setup.captureSpans().lines.map((line) =>
    line.spans.map((span) => ({
      text: span.text,
      fg: hexOf(span.fg),
      bg: hexOf(span.bg),
    })),
  );
}
type SpanDump = ReturnType<typeof spanDump>;

function titleSpans(dump: SpanDump, needle: string, background: string) {
  return dump.flatMap((line) =>
    line.filter((span) => span.text.includes(needle) && span.bg === background),
  );
}

/** The span on the same line as `needle` whose trimmed text is exactly the dot glyph. */
function dotSpan(dump: SpanDump, needle: string, glyph: string) {
  const line = dump.find((entry) => entry.some((span) => span.text.includes(needle)));
  const dot = line?.find((span) => span.text.trim() === glyph);
  if (dot === undefined)
    throw new Error(
      `no dot span on the ${needle} line; line spans: ${JSON.stringify(line) ?? 'missing line'}`,
    );
  return dot;
}

describe('overview project titles and semantic dots (issue #68)', () => {
  for (const themeName of ['dark', 'light', 'high-contrast'] as const) {
    test(`title text is filled with its own computed label in ${themeName}`, async () => {
      const { setup } = await mountProjects({ themeName });
      const dump = spanDump(setup);
      const localLabel = projectLabel('local', directoryKey('/work/kohjoh', 'linux'));
      const bravoLabel = projectLabel('srv_b', directoryKey('/srv/app', 'linux'));
      const charlieLabel = projectLabel('srv_c', directoryKey('/srv/app', 'linux'));
      const [localTitle] = titleSpans(dump, 'kohjoh', localLabel.background.toLowerCase());
      expect(localTitle?.fg).toBe(localLabel.foreground.toLowerCase());
      const [bravoTitle] = titleSpans(dump, 'app', bravoLabel.background.toLowerCase());
      expect(bravoTitle?.fg).toBe(bravoLabel.foreground.toLowerCase());
      const [charlieTitle] = titleSpans(dump, 'app', charlieLabel.background.toLowerCase());
      expect(charlieTitle?.fg).toBe(charlieLabel.foreground.toLowerCase());
      // The two identical basenames carry different remote markers outside the label.
      const flat = dump.flat();
      expect(flat.some((span) => span.text.includes('bravo'))).toBe(true);
      expect(flat.some((span) => span.text.includes('charlie'))).toBe(true);
    });
  }

  test('session dots are semantic grey/yellow/green/red, never the brand accent', async () => {
    const { setup } = await mountProjects({});
    const dump = spanDump(setup);
    const dark = pickTheme({}, 'dark');
    expect(dotSpan(dump, 'Local refactor', '●').fg).toBe(dark.dim.toLowerCase());
    expect(dotSpan(dump, 'Needs a decision', '●').fg).toBe(dark.warn.toLowerCase());
    expect(dotSpan(dump, 'Bravo build', '●').fg).toBe(dark.success.toLowerCase());
    expect(dotSpan(dump, 'Charlie build', '●').fg).toBe(dark.error.toLowerCase());
    // The brand accent (a pink) appears nowhere as a dot colour.
    expect(dotSpan(dump, 'Bravo build', '●').fg).not.toBe(dark.accent.toLowerCase());
  });

  test('ASCII mode renders symbolic fallbacks with the same semantic colours', async () => {
    const { setup } = await mountProjects({ ascii: true });
    const dump = spanDump(setup);
    const dark = pickTheme({}, 'dark');
    expect(dotSpan(dump, 'Local refactor', 'o').fg).toBe(dark.dim.toLowerCase());
    expect(dotSpan(dump, 'Needs a decision', '?').fg).toBe(dark.warn.toLowerCase());
    expect(dotSpan(dump, 'Bravo build', '*').fg).toBe(dark.success.toLowerCase());
    expect(dotSpan(dump, 'Charlie build', '!').fg).toBe(dark.error.toLowerCase());
  });

  test('NO_COLOR emits no filled title label and keeps text readable', async () => {
    const { setup } = await mountProjects({ noColor: true });
    const dump = spanDump(setup);
    const flat = dump.flat();
    // The computed label fill colours must not appear anywhere.
    const fills = [
      projectLabel('local', directoryKey('/work/kohjoh', 'linux')).background,
      projectLabel('srv_b', directoryKey('/srv/app', 'linux')).background,
      projectLabel('srv_c', directoryKey('/srv/app', 'linux')).background,
    ].map((hex) => hex.toLowerCase());
    for (const fill of fills) {
      expect(flat.some((span) => span.bg === fill)).toBe(false);
    }
    expect(flat.some((span) => span.text.includes('kohjoh'))).toBe(true);
    expect(flat.some((span) => span.text.includes('bravo'))).toBe(true);
  });
});

test('help dismisses and retains typed and pasted input', async () => {
  const { controller, setup } = await mount(backendWithSession());
  controller.openSession('ses_a');
  await settle(setup);
  controller.setOverlay({ kind: 'help' });
  await setup.mockInput.typeText('hello');
  await settle(setup);
  expect(controller.state.overlay.kind).toBe('none');
  expect(controller.state.composer.text).toBe('hello');

  controller.setOverlay({ kind: 'help' });
  await setup.mockInput.pasteBracketedText('\nsecond line');
  await settle(setup);
  expect(controller.state.overlay.kind).toBe('none');
  expect(controller.state.composer.text).toBe('hello\nsecond line');
  controller.dispose();
});

test('Enter accepts a partial command before executing it', async () => {
  const backend = backendWithSession();
  const { controller, setup } = await mount(backend);
  controller.openSession('ses_a');
  await settle(setup);
  await setup.mockInput.typeText('/comp');
  setup.mockInput.pressEnter();
  await settle(setup);
  expect(controller.state.composer.text).toBe('/compact ');
  expect(backend.calls.some((call) => call.name === 'compactSession')).toBe(false);
  setup.mockInput.pressEnter();
  await settle(setup);
  expect(backend.calls.some((call) => call.name === 'compactSession')).toBe(true);
  controller.dispose();
});

test('command completion honors the selected index and keeps exact local commands local', async () => {
  const backend = backendWithSession();
  backend.serverCommands = [{ name: 'compact' }, { name: 'compare' }];
  const { controller, setup } = await mount(backend);
  controller.openSession('ses_a');
  await settle(setup);

  await setup.mockInput.typeText('/comp');
  expect(controller.state.completion?.items.map((item) => item.label)).toEqual([
    '/compact',
    '/compare',
  ]);
  setup.mockInput.pressArrow('down');
  setup.mockInput.pressEnter();
  await settle(setup);
  expect(controller.state.composer.text).toBe('/compare ');
  expect(backend.calls.some((call) => call.name === 'command')).toBe(false);

  controller.setComposer(composerFrom('/compact'));
  expect(controller.state.completion).toBeUndefined();
  setup.mockInput.pressEnter();
  await settle(setup);
  expect(backend.calls.some((call) => call.name === 'compactSession')).toBe(true);
  expect(backend.calls.some((call) => call.name === 'command')).toBe(false);
  controller.dispose();
});

test('clicking the screen dismisses help', async () => {
  const { controller, setup } = await mount(backendWithSession());
  controller.openSession('ses_a');
  await settle(setup);
  controller.setOverlay({ kind: 'help' });
  await setup.renderOnce();
  await setup.mockMouse.click(1, 1);
  await settle(setup);
  expect(controller.state.overlay.kind).toBe('none');
  controller.dispose();
});

test('welcome greeting stays stable across redraws and route revisits (#128)', async () => {
  const { controller, setup } = await mount(backendWithSession());
  controller.startNewSession('/work/kohjoh');
  await settle(setup);
  const frame = setup.captureCharFrame();
  const greeting = Object.values(greetingCatalog)
    .flat()
    .find((candidate) => frame.includes(candidate));
  if (greeting === undefined) throw new Error('no greeting rendered in the welcome panel');

  await setup.mockInput.typeText('some draft');
  await settle(setup);
  expect(setup.captureCharFrame()).toContain(greeting);

  controller.openOverview();
  await settle(setup);
  controller.startNewSession('/work/kohjoh');
  await settle(setup);
  expect(setup.captureCharFrame()).toContain(greeting);
  controller.dispose();
});

test('server-confirmed workers render with identity and expand to child details (#101)', async () => {
  const backend = backendWithSession();
  backend.messages = {
    ses_a: [
      {
        kind: 'assistant',
        id: 'm1',
        createdAt: 1,
        agent: 'build',
        model: { providerID: 'p', modelID: 'm' },
        parts: [],
      },
    ],
  };
  backend.jobs = {
    ses_a: [
      {
        id: 'job_a',
        childSessionID: 'child_a',
        agent: 'build',
        description: 'review patch',
        status: 'running',
        startedAt: 1000,
      },
      {
        id: 'job_b',
        childSessionID: 'child_b',
        agent: 'plan',
        description: 'audit tests',
        status: 'error',
        startedAt: 2000,
        completedAt: 4000,
      },
    ],
  };
  const { controller, setup } = await mount(backend);
  controller.openSession('ses_a');
  await settle(setup);

  const frame = setup.captureCharFrame();
  expect(frame).toContain('review patch');
  expect(frame).toContain('audit tests');
  expect(frame).toContain('running');
  expect(frame).toContain('failed');
  expect(frame).not.toContain('child_a'); // collapsed by default

  controller.moveGroupFocus(1);
  controller.toggleFocusedGroup();
  await settle(setup);
  expect(setup.captureCharFrame()).toContain('child_a');
  controller.dispose();
});

test('rewind picker lists earlier prompts and shows file scope and honest limits (#102)', async () => {
  const backend = backendWithSession();
  backend.messages = {
    ses_a: [
      { kind: 'user', id: 'u1', createdAt: 1000, text: 'first request', attachments: [] },
      { kind: 'user', id: 'u2', createdAt: 2000, text: 'second request', attachments: [] },
    ],
  };
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
  const { controller, setup } = await mount(backend);
  controller.openSession('ses_a');
  await settle(setup);
  controller.enterRewindSelection();
  await settle(setup);

  const frame = setup.captureCharFrame();
  expect(frame).toContain('first request');
  expect(frame).toContain('second request');
  expect(frame).toContain('src/a.ts');
  expect(frame).toContain('Files only');
  expect(frame).toContain('no redo');
  expect(backend.calls.some((call) => call.name === 'stageRevert')).toBe(false);
  controller.dispose();
});

test('clicking agent, model and context footer segments opens the right overlay (#124)', async () => {
  const backend = backendWithSession();
  backend.sessions = [
    {
      ...backend.sessions[0]!,
      agent: 'agentX',
      model: { providerID: 'opencode', modelID: 'longcat' },
    },
  ];
  backend.models = [
    { providerID: 'opencode', modelID: 'longcat', name: 'Longcat', enabled: true, variants: [] },
  ];
  backend.messages = {
    ses_a: [
      { kind: 'user', id: 'u1', createdAt: 1, text: 'why?', attachments: [] },
      {
        kind: 'assistant',
        id: 'a1',
        createdAt: 2,
        completedAt: 3,
        agent: 'agentX',
        model: { providerID: 'opencode', modelID: 'longcat' },
        parts: [],
        usage: { input: 120, output: 30, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
  const { controller, setup } = await mount(backend);
  controller.openSession('ses_a');
  await settle(setup);

  const clickFooter = async (needle: string) => {
    const [x, y] = footerPoint(setup.captureCharFrame(), needle);
    await setup.mockMouse.click(x, y);
    await settle(setup);
  };

  await setup.mockInput.typeText('keep this draft');
  await settle(setup);

  await clickFooter('agentX');
  expect(controller.state.overlay.kind).toBe('agent-picker');
  expect(controller.state.composer.text).toBe('keep this draft');
  const agentBefore = controller.currentAgentID();
  await clickFooter('agentX'); // second click on the same control closes, no selection
  expect(controller.state.overlay.kind).toBe('none');
  expect(controller.currentAgentID()).toBe(agentBefore);
  expect(controller.state.composer.text).toBe('keep this draft');

  await clickFooter('longcat');
  expect(controller.state.overlay.kind).toBe('model-picker');
  expect(controller.state.composer.text).toBe('keep this draft');
  const modelBefore = controller.currentSession()?.model;
  await clickFooter('longcat');
  expect(controller.state.overlay.kind).toBe('none');
  expect(controller.currentSession()?.model).toEqual(modelBefore);
  expect(controller.state.composer.text).toBe('keep this draft');

  await clickFooter('ctx');
  expect(controller.state.overlay.kind).toBe('usage');
  expect(setup.captureCharFrame()).toContain('session analytics');
  await clickFooter('ctx');
  expect(controller.state.overlay.kind).toBe('none');
  expect(controller.state.composer.text).toBe('keep this draft');
  controller.dispose();
});

test('a second footer click cannot dismiss an unrelated modal overlay (#139)', async () => {
  const { controller, setup } = await mount(backendWithSession());
  controller.openSession('ses_a');
  await settle(setup);
  controller.setOverlay({ kind: 'help' });
  await settle(setup);
  controller.activateFooter('agent');
  controller.activateFooter('model');
  controller.activateFooter('context');
  expect(controller.state.overlay.kind).toBe('help');
  controller.dispose();
});

const timedOutShell: TranscriptMessage = {
  kind: 'shell',
  id: 'sh_msg',
  shellID: 'sh_1',
  createdAt: 1,
  command: 'npm test',
  status: 'timeout',
};

test('a timed-out shell alone stays plainly labelled, not invented as background (#103)', async () => {
  const backend = backendWithSession();
  backend.messages = { ses_a: [timedOutShell] };
  const { controller, setup } = await mount(backend);
  controller.openSession('ses_a');
  await settle(setup);
  expect(setup.captureCharFrame()).toContain('timeout');
  expect(setup.captureCharFrame()).not.toContain('still running in background');
  controller.dispose();
});

test('a timed-out shell shows background when the server reports a running job (#103)', async () => {
  const backend = backendWithSession();
  backend.messages = { ses_a: [timedOutShell] };
  backend.shellJobs = {
    ses_a: [
      {
        id: 'job_shell_1',
        shellID: 'sh_1',
        sessionID: 'ses_a',
        status: 'running',
        startedAt: 1,
      },
    ],
  };
  const { controller, setup } = await mount(backend);
  controller.openSession('ses_a');
  await settle(setup);
  expect(setup.captureCharFrame()).toContain('timeout · still running in background');
  controller.dispose();
});

test('/usage and a context click render the same analytics view (#124)', async () => {
  const backend = backendWithSession();
  const { controller, setup } = await mount(backend);
  controller.openSession('ses_a');
  await settle(setup);

  controller.setComposer(composerFrom('/usage'));
  setup.mockInput.pressEnter();
  await settle(setup);
  const fromCommand = setup.captureCharFrame();
  expect(fromCommand).toContain('session analytics');
  expect(fromCommand).toContain('Lifetime server totals');
  controller.closeOverlay();
  await settle(setup);

  controller.activateFooter('context');
  await settle(setup);
  expect(setup.captureCharFrame()).toContain('session analytics');
  expect(setup.captureCharFrame()).toContain('Lifetime server totals');
  controller.dispose();
});
