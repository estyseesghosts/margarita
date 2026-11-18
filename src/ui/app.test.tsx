import { afterEach, describe, expect, test } from 'bun:test';

import { testRender } from '@opentui/solid';

import { FakeBackend } from '../../test/fake-backend.ts';
import { BackendError } from '../adapter/backend.ts';
import { AppController } from '../app/controller.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
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
    version: '0.1.0',
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
});
