import { describe, expect, test } from 'bun:test';

import { testRender } from '@opentui/solid';

import { createBackend } from '../src/adapter/backend.ts';
import { connect } from '../src/adapter/connection.ts';
import { AppController } from '../src/app/controller.ts';
import { defaultConfig } from '../src/config/config.ts';
import { emptyState } from '../src/config/local-state.ts';
import { buildKeymap } from '../src/domain/keymap.ts';
import { App } from '../src/ui/app.tsx';
import { pickTheme } from '../src/ui/theme.ts';

/**
 * Opt-in (`MARGARITA_LIVE=1`). Read-only against the already-running local service:
 * discovers it, loads catalog and sessions, and renders the overview. Never starts,
 * stops or writes to the service.
 */
const live = process.env['MARGARITA_LIVE'] === '1';

describe.skipIf(!live)('live service', () => {
  test('connects, loads sessions and renders the overview', async () => {
    const connection = await connect({ startServer: false });
    const backend = createBackend(connection);
    const controller = new AppController({
      backend,
      config: defaultConfig,
      localState: emptyState,
      platform: process.platform,
      cwd: process.cwd(),
      version: 'live',
      now: Date.now,
      saveLocalState: async () => {},
      listFiles: async () => [],
      requestExit: () => {},
    });
    await controller.bootstrap();
    expect(controller.state.models.length).toBeGreaterThan(0);
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
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('Sessions');
    setup.renderer.destroy();
    controller.dispose();
  }, 30_000);
});
