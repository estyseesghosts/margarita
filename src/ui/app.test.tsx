import { afterEach, describe, expect, test } from 'bun:test';

import { testRender } from '@opentui/solid';

import { FakeBackend } from '../../test/fake-backend.ts';
import { BackendError } from '../adapter/backend.ts';
import { AppController } from '../app/controller.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import { isRecord } from '../domain/backend-event.ts';
import { composerFrom } from '../domain/composer.ts';
import { buildKeymap } from '../domain/keymap.ts';
import { App } from './app.tsx';
import { pickTheme } from './theme.ts';

const pageUp = '\u001b[5~';

type Setup = Awaited<ReturnType<typeof testRender>>;
let current: Setup | undefined;

afterEach(() => {
  current?.renderer.destroy();
  current = undefined;
});

async function mount(backend: FakeBackend) {
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
    { width: 80, height: 24 },
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
    expect(controller.state.route).toEqual({ kind: 'conversation', sessionID: 'ses_a' });
    const frame = setup.captureCharFrame();
    if (process.env['DUMP'] !== undefined) console.log(frame);
    expect(frame).toContain('Welcome back!');
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
    expect(setup.captureCharFrame()).toContain('Welcome back!');
    expect(backend.calls.some((call) => call.name === 'createSession')).toBe(false);
    await setup.mockInput.typeText('hi');
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(backend.calls.find((call) => call.name === 'createSession')?.args[0]).toMatchObject({
      directory: '/work/kohjoh',
    });
    expect(controller.state.route.kind).toBe('conversation');
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
  test('goal, plan and Ctrl+T checklist; sync failure stays local', async () => {
    const backend = backendWithSession();
    backend.instructionsUnavailable = true;
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    for (const command of ['/goal Hit 30 FPS', '/plan profile; cull; test', '/sync on']) {
      await setup.mockInput.typeText(command);
      setup.mockInput.pressEnter();
      await settle(setup);
    }
    expect(controller.state.notice?.text).toBe('Not synced to agent · local plan kept');
    expect(backend.calls.some((call) => call.name === 'prompt')).toBe(false);
    setup.mockInput.pressKey('t', { ctrl: true });
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain('Goal: Hit 30 FPS');
    expect(frame).toContain('Tasks 0/3');
    expect(frame).toContain('Not synced to agent');
    setup.mockInput.pressKey(' ');
    await settle(setup);
    setup.mockInput.pressKey(' ');
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(frame).toContain('[x] profile');
    expect(frame).toContain('Tasks 1/3');
    backend.instructionsUnavailable = false;
    setup.mockInput.pressArrow('down');
    setup.mockInput.pressKey(' ');
    await settle(setup);
    const put = backend.calls.filter((call) => call.name === 'putInstruction').at(-1);
    expect(String(put?.args[2])).toContain('cull [in progress]');
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
    controller.onEvents([], true);
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
    expect(controller.state.expandedDiffs['w1']).toBe(true);
    expect(setup.captureCharFrame()).not.toContain('more lines · Enter to expand');
    expect(controller.state.composer.text).toBe(''); // not a submit, not a draft

    setup.mockInput.pressEnter();
    await settle(setup);
    expect(controller.state.expandedDiffs['w1']).toBeUndefined();
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
