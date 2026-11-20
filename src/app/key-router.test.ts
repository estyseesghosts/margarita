import { expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import { composerFrom } from '../domain/composer.ts';
import { buildKeymap } from '../domain/keymap.ts';
import { AppController } from './controller.ts';
import { routeKey } from './key-router.ts';

test('remapped task shortcut toggles the task overlay in overview and conversation', async () => {
  const backend = new FakeBackend();
  backend.sessions = [
    {
      id: 'ses_a',
      serverID: 'local',
      projectID: 'p',
      directory: '/work',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    },
  ];
  const controller = new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work',
    version: '0.0.1',
    now: () => 1,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
  });
  const keymap = buildKeymap({ 'tasks.toggle': 'alt+t' }).keymap;
  const services = { openEditor: () => {}, redraw: () => {}, scroll: () => {} };
  const toggle = () =>
    routeKey(controller, keymap, { name: 't', ctrl: false, alt: true, shift: false }, services);
  await controller.bootstrap();
  for (const route of ['overview', 'conversation'] as const) {
    if (route === 'conversation') controller.openSession('ses_a');
    expect(controller.state.route.kind).toBe(route);
    expect(toggle()).toBe(true);
    expect(controller.state.overlay.kind).toBe('tasks');
    expect(toggle()).toBe(true);
    expect(controller.state.overlay.kind).toBe('none');
  }
  controller.dispose();
});

test('Ctrl+W deletes a whitespace-delimited unit while Ctrl+Backspace deletes a word', async () => {
  const backend = new FakeBackend();
  backend.sessions = [
    {
      id: 'ses_a',
      serverID: 'local',
      projectID: 'p',
      directory: '/work',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    },
  ];
  const controller = new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work',
    version: '0.0.1',
    now: () => 1,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
  });
  const keymap = buildKeymap({}).keymap;
  const services = { openEditor: () => {}, redraw: () => {}, scroll: () => {} };
  await controller.bootstrap();
  controller.openSession('ses_a');

  controller.setComposer(composerFrom('run src/utils/file.ts'));
  routeKey(controller, keymap, { name: 'w', ctrl: true, alt: false, shift: false }, services);
  expect(controller.state.composer.text).toBe('run ');

  controller.setComposer(composerFrom('run src/utils/file.ts'));
  routeKey(
    controller,
    keymap,
    { name: 'backspace', ctrl: true, alt: false, shift: false },
    services,
  );
  expect(controller.state.composer.text).toBe('run src/utils/file.');
  controller.dispose();
});

test('kill commands populate the buffer and Ctrl+Y yanks it back (#97)', async () => {
  const backend = new FakeBackend();
  backend.sessions = [
    {
      id: 'ses_a',
      serverID: 'local',
      projectID: 'p',
      directory: '/work',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    },
  ];
  const controller = new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work',
    version: '0.0.1',
    now: () => 1,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
  });
  const keymap = buildKeymap({}).keymap;
  const services = { openEditor: () => {}, redraw: () => {}, scroll: () => {} };
  const press = (key: string, mods: { ctrl?: boolean; alt?: boolean }) =>
    routeKey(
      controller,
      keymap,
      { name: key, ctrl: mods.ctrl ?? false, alt: mods.alt ?? false, shift: false },
      services,
    );
  await controller.bootstrap();
  controller.openSession('ses_a');

  controller.setComposer({ text: 'hello world', cursor: 6 });
  expect(press('k', { ctrl: true })).toBe(true);
  expect(controller.state.composer.text).toBe('hello ');
  expect(controller.yankText()).toBe('world');
  expect(press('y', { ctrl: true })).toBe(true);
  expect(controller.state.composer.text).toBe('hello world');
  expect(controller.state.composer.cursor).toBe(11);

  controller.setComposer({ text: 'hello world', cursor: 6 });
  press('u', { ctrl: true });
  expect(controller.state.composer.text).toBe('world');
  expect(controller.yankText()).toBe('hello ');
  press('y', { ctrl: true });
  expect(controller.state.composer.text).toBe('hello world');

  const text = 'e\u0301 🧑🏽‍💻 tail';
  const cursor = 'e\u0301 🧑🏽‍💻 '.length;
  controller.setComposer({ text, cursor });
  expect(press('d', { alt: true })).toBe(true);
  expect(controller.state.composer.text).toBe('e\u0301 🧑🏽‍💻 ');
  expect(controller.yankText()).toBe('tail');
  expect(controller.state.composer.text.isWellFormed()).toBe(true);
  press('y', { ctrl: true });
  expect(controller.state.composer.text).toBe(text);
  controller.dispose();
});
