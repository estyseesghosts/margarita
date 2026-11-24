import { afterEach, expect, test } from 'bun:test';

import { testRender } from '@opentui/solid';

import { FakeBackend } from '../../test/fake-backend.ts';
import { AppController } from '../app/controller.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import { buildKeymap } from '../domain/keymap.ts';
import { App } from './app.tsx';
import { pickTheme } from './theme.ts';

let current: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  current?.renderer.destroy();
  current = undefined;
});

test('overview names paired hosts while their credentials restore (#346)', async () => {
  const backend = new FakeBackend();
  const controller = new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/deferred',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
  });
  await controller.bootstrap();
  controller.registerDeferredServers([
    {
      serverID: 'srv_1',
      label: 'buildbox',
      baseUrl: 'http://build.test:4096',
      state: 'restoring',
    },
  ]);
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
    { width: 100, height: 30 },
  );
  current = setup;
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain('Restoring paired server buildbox');

  controller.resolveDeferredServer('srv_1', 'unauthorized');
  await setup.renderOnce();
  const unavailable = setup.captureCharFrame();
  expect(unavailable).toContain('Paired server buildbox is unavailable');
  expect(unavailable).not.toContain('Restoring paired server buildbox');

  controller.dispose();
});
