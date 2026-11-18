import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { testRender } from '@opentui/solid';

import { AppController } from '../src/app/controller.ts';
import { defaultConfig } from '../src/config/config.ts';
import { fileGoalStore, type GoalStore } from '../src/config/goal-store.ts';
import { emptyState } from '../src/config/local-state.ts';
import { buildKeymap } from '../src/domain/keymap.ts';
import { App } from '../src/ui/app.tsx';
import { pickTheme } from '../src/ui/theme.ts';
import { FakeBackend } from './fake-backend.ts';

/** docs/15 behavioral scenarios B, C, D, G and H, driven by real keystrokes. */

type Setup = Awaited<ReturnType<typeof testRender>>;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function twoSessions(): FakeBackend {
  const backend = new FakeBackend();
  backend.agents = [
    { id: 'build', name: 'build', mode: 'primary', hidden: false },
    { id: 'plan', name: 'plan', mode: 'primary', hidden: false },
  ];
  backend.sessions = ['ses_a', 'ses_b'].map((id, index) => ({
    id,
    projectID: 'p',
    directory: '/work/kohjoh',
    title: `Session ${id}`,
    agent: 'build',
    createdAt: index,
    updatedAt: index,
    archived: false,
  }));
  backend.messages = {
    ses_a: [{ kind: 'user', id: 'a1', createdAt: 1, text: 'work on A', attachments: [] }],
    ses_b: [],
  };
  backend.active.add('ses_a');
  return backend;
}

async function mount(backend: FakeBackend, goalStore?: GoalStore) {
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
    ...(goalStore === undefined ? {} : { goalStore }),
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
    { width: 90, height: 28 },
  );
  cleanups.push(() => {
    setup.renderer.destroy();
    controller.dispose();
  });
  await setup.renderOnce();
  return { controller, setup };
}

async function settle(setup: Setup) {
  await Bun.sleep(20);
  await setup.renderOnce();
}

const navigationSideEffects = ['interrupt', 'backgroundTools', 'deleteSession'];

describe('acceptance', () => {
  test('B: leaving a running session and returning never interrupts or backgrounds it', async () => {
    const backend = twoSessions();
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    for (let round = 0; round < 10; round += 1) {
      setup.mockInput.pressArrow('left');
      await settle(setup);
      expect(controller.state.route.kind).toBe('overview');
      controller.openSession(round % 2 === 0 ? 'ses_b' : 'ses_a');
      await settle(setup);
    }
    controller.openSession('ses_a');
    await settle(setup);
    expect(controller.state.running['ses_a']).toBe(true);
    expect(setup.captureCharFrame()).toContain('work on A');
    expect(backend.calls.filter((call) => navigationSideEffects.includes(call.name))).toEqual([]);
  });

  test('C: Enter while running queues; Ctrl+C interrupts through the server', async () => {
    const backend = twoSessions();
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    await setup.mockInput.typeText('also check tests');
    setup.mockInput.pressEnter();
    await settle(setup);
    const prompts = backend.calls.filter((call) => call.name === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.args[1]).toMatchObject({ text: 'also check tests', delivery: 'queue' });
    setup.mockInput.pressKey('c', { ctrl: true });
    await settle(setup);
    expect(backend.calls.some((call) => call.name === 'interrupt')).toBe(true);
  });

  test('Up on an empty composer recalls the newest queued follow-up for editing', async () => {
    const backend = twoSessions();
    backend.inbox = [
      { id: 'in_1', kind: 'user', delivery: 'queue', text: 'first follow-up', createdAt: 1 },
      { id: 'in_2', kind: 'user', delivery: 'queue', text: 'second follow-up', createdAt: 2 },
    ];
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);

    setup.mockInput.pressArrow('up');
    await settle(setup);

    expect(controller.state.composer.text).toBe('second follow-up');
    // Older queued message survives.
    expect(controller.state.inbox['ses_a']?.map((item) => item.id)).toEqual(['in_1']);

    await setup.mockInput.typeText(' plus edited');
    setup.mockInput.pressEnter();
    await settle(setup);
    const prompts = backend.calls.filter((call) => call.name === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.args[1]).toMatchObject({
      text: 'second follow-up plus edited',
      delivery: 'queue',
    });
    expect(
      controller.state.inbox['ses_a']
        ?.filter((item) => item.kind === 'user')
        .map((item) => item.text),
    ).toEqual(['first follow-up', 'second follow-up plus edited']);
  });

  test('D: Shift+Tab asks the server to switch from build to plan', async () => {
    const backend = twoSessions();
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_b');
    await settle(setup);
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    expect(backend.calls.find((call) => call.name === 'switchAgent')?.args).toEqual([
      'ses_b',
      'plan',
    ]);
  });

  test('G: a pending permission survives switching away and is answered once', async () => {
    const backend = twoSessions();
    backend.permissions = [
      { id: 'per_1', sessionID: 'ses_a', action: 'bash', resources: ['ls'], save: [] },
    ];
    const { controller, setup } = await mount(backend);
    controller.openSession('ses_a');
    await settle(setup);
    controller.openSession('ses_b');
    await settle(setup);
    controller.openSession('ses_a');
    await settle(setup);
    expect(setup.captureCharFrame()).toContain('Permission needed');
    setup.mockInput.pressEnter();
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(backend.calls.filter((call) => call.name === 'replyPermission')).toHaveLength(1);
  });

  test('H: after a restart the accepted plan revision and task states are restored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-accept-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const store = () => fileGoalStore(dir, () => '2026-11-18T00:00:00.000Z');
    const first = await mount(twoSessions(), store());
    first.controller.openSession('ses_b');
    await settle(first.setup);
    await first.setup.mockInput.typeText('/plan one; two');
    first.setup.mockInput.pressEnter();
    await settle(first.setup);
    first.setup.mockInput.pressKey('t', { ctrl: true });
    await settle(first.setup);
    first.setup.mockInput.pressKey(' ');
    await settle(first.setup);
    const saved = first.controller.goalOf('ses_b');
    expect(saved?.plan?.tasks[0]?.state).toBe('in-progress');

    const second = await mount(twoSessions(), store());
    second.controller.openSession('ses_b');
    await settle(second.setup);
    expect(second.controller.goalOf('ses_b')).toEqual(saved);
  });
});
