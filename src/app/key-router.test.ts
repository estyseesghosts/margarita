import { expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import { composerFrom } from '../domain/composer.ts';
import { buildKeymap } from '../domain/keymap.ts';
import { AppController } from './controller.ts';
import { routeKey, type RouterServices } from './key-router.ts';

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

test('a remapped navigation key reaches handlers that still expect the canonical key', () => {
  const controller = new AppController({
    backend: new FakeBackend(),
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
  const keymap = buildKeymap({ 'nav.cancel': 'f12' }).keymap;
  const services = { openEditor: () => {}, redraw: () => {}, scroll: () => {} };
  const press = (name: string) =>
    routeKey(controller, keymap, { name, ctrl: false, alt: false, shift: false }, services);
  expect(press('f1')).toBe(true);
  expect(controller.state.overlay.kind).toBe('help');
  expect(press('f12')).toBe(true);
  expect(controller.state.overlay.kind).toBe('none');
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

test('overview PageUp/PageDown and Ctrl+Home/End move the selected row (#238)', async () => {
  const backend = new FakeBackend();
  backend.sessions = Array.from({ length: 40 }, (_, index) => ({
    id: `ses_${index}`,
    serverID: 'local',
    projectID: 'p',
    // Distinct projects avoid a group toggle row; one matches the launch cwd so the
    // overview opens with list focus instead of the new-session composer.
    directory: index === 0 ? '/work' : `/work/p${index}`,
    createdAt: 1,
    updatedAt: index + 1,
    archived: false,
  }));
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
  const scrolled: string[] = [];
  const services: RouterServices = {
    openEditor: () => {},
    redraw: () => {},
    scroll: (move) => {
      scrolled.push(move);
    },
    overviewPageRows: 10,
  };
  const { keymap } = buildKeymap({});
  const press = (name: string, ctrl = false) =>
    routeKey(controller, keymap, { name, ctrl, alt: false, shift: false }, services);

  await controller.bootstrap();
  controller.openOverview();
  const rows = controller.overviewRows();
  expect(rows).toHaveLength(40);
  controller.selectOverviewEdge('first');
  expect(controller.state.overview.selectedRow).toBe(rows[0]?.key);

  expect(press('pagedown')).toBe(true);
  expect(controller.state.overview.selectedRow).toBe(rows[10]?.key);
  expect(press('pagedown')).toBe(true);
  expect(controller.state.overview.selectedRow).toBe(rows[20]?.key);
  expect(press('pageup')).toBe(true);
  expect(controller.state.overview.selectedRow).toBe(rows[10]?.key);
  expect(press('end', true)).toBe(true);
  expect(controller.state.overview.selectedRow).toBe(rows[39]?.key);
  expect(press('home', true)).toBe(true);
  expect(controller.state.overview.selectedRow).toBe(rows[0]?.key);
  // The transcript-only scroll callback is never reached from the overview.
  expect(scrolled).toEqual([]);

  // Composer focus keeps its draft; paging is a list gesture, not a route-wide scroll.
  controller.focusOverviewComposer();
  controller.setComposer(composerFrom('keep this draft'));
  expect(press('pagedown')).toBe(true);
  expect(controller.state.overview.focus).toBe('composer');
  expect(controller.state.composer.text).toBe('keep this draft');
  controller.dispose();
});
