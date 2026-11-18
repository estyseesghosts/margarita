import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import type { SessionSummary } from '../domain/session.ts';
import { AppController } from './controller.ts';

function session(id: string, serverID: string, directory: string): SessionSummary {
  return {
    id,
    serverID,
    projectID: 'p',
    directory,
    createdAt: 0,
    updatedAt: 1,
    archived: false,
  };
}

function harness() {
  const local = new FakeBackend();
  const remote = new FakeBackend();
  local.sessions = [session('ses_a', 'local', '/work/lotus')];
  remote.sessions = [session('ses_a', 'srv_1', '/work/lotus')];
  const controller = new AppController({
    backend: local,
    backendFor: (serverID: string) => (serverID === 'srv_1' ? remote : local),
    serverIDs: () => ['local', 'srv_1'],
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/lotus',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    requestExit: () => {},
  });
  return { controller, local, remote };
}

describe('cross-server aggregation', () => {
  test('identical session IDs and directories become separate projects', async () => {
    const { controller } = harness();
    await controller.loadSessions();
    expect(Object.keys(controller.state.sessions).toSorted()).toEqual([
      'server:srv_1/session:ses_a',
      'ses_a',
    ]);
    expect(controller.groups()).toHaveLength(2);
    controller.dispose();
  });
});
