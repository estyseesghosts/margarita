import { describe, expect, test } from 'bun:test';

import { createBackend } from '../src/adapter/backend.ts';
import type { Connection } from '../src/adapter/connection.ts';
import { ServerConnectionManager } from '../src/adapter/server-manager.ts';
import { AppController } from '../src/app/controller.ts';
import { defaultConfig } from '../src/config/config.ts';
import { emptyState } from '../src/config/local-state.ts';

/**
 * Opt-in (`MARGARITA_LIVE_MULTI=1`) read-only smoke test against two disposable OpenCode v2
 * services. Pass their base URLs in MARGARITA_LIVE_SERVER_A / MARGARITA_LIVE_SERVER_B and
 * optional passwords in MARGARITA_LIVE_PASSWORD_A / MARGARITA_LIVE_PASSWORD_B. Secrets are
 * read from the environment only; nothing is written, started, stopped, or interrupted.
 */
const enabled = process.env['MARGARITA_LIVE_MULTI'] === '1';
const urlA = process.env['MARGARITA_LIVE_SERVER_A'];
const urlB = process.env['MARGARITA_LIVE_SERVER_B'];

function headers(password: string | undefined): Record<string, string> {
  if (password === undefined) return {};
  return { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
}

function connection(url: string, password: string | undefined): Connection {
  return { baseUrl: url.replace(/\/$/, ''), headers: headers(password), origin: 'remote' };
}

describe.skipIf(!enabled || urlA === undefined || urlB === undefined)(
  'live multi-server smoke',
  () => {
    test('two live services load independently and aggregate without cross-error', async () => {
      const a = createBackend(connection(urlA ?? '', process.env['MARGARITA_LIVE_PASSWORD_A']), {
        serverID: 'srv_a',
      });
      const b = createBackend(connection(urlB ?? '', process.env['MARGARITA_LIVE_PASSWORD_B']), {
        serverID: 'srv_b',
      });
      const manager = new ServerConnectionManager();
      manager.add({ serverID: 'srv_a', connection: connection(urlA ?? '', undefined), backend: a });
      manager.add({ serverID: 'srv_b', connection: connection(urlB ?? '', undefined), backend: b });

      const [sessionsA, sessionsB] = await Promise.all([
        a.listSessions({ limit: 5 }),
        b.listSessions({ limit: 5 }),
      ]);
      for (const session of [...sessionsA.sessions, ...sessionsB.sessions]) {
        expect(['srv_a', 'srv_b']).toContain(session.serverID);
      }

      const controller = new AppController({
        backend: a,
        backendFor: (serverID) => (serverID === 'srv_b' ? b : a),
        serverIDs: () => ['srv_a', 'srv_b'],
        serverInfo: (serverID) => ({ label: serverID, online: true }),
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
      await controller.loadSessions();
      const groups = controller.groups();
      expect(
        groups.every((group) => group.serverID === 'srv_a' || group.serverID === 'srv_b'),
      ).toBe(true);
      controller.dispose();
      await manager.dispose();
    }, 30_000);
  },
);
