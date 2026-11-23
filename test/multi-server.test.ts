import { describe, expect, test } from 'bun:test';

import type { Backend } from '../src/adapter/backend.ts';
import type { Connection } from '../src/adapter/connection.ts';
import { ServerConnectionManager } from '../src/adapter/server-manager.ts';
import { AppController } from '../src/app/controller.ts';
import { defaultConfig } from '../src/config/config.ts';
import { emptyState } from '../src/config/local-state.ts';
import { FakeBackend } from './fake-backend.ts';

function connection(url: string): Connection {
  return { baseUrl: url, headers: {}, origin: 'remote' };
}

/** Two backends that deliberately collide on session IDs and permission IDs. */
function colliding() {
  const local = new FakeBackend();
  const remote = new FakeBackend();
  local.sessions = [
    {
      id: 'ses_same',
      serverID: 'local',
      projectID: 'p',
      directory: '/work/lotus',
      createdAt: 0,
      updatedAt: 1,
      archived: false,
    },
  ];
  remote.sessions = [
    {
      id: 'ses_same',
      serverID: 'srv_1',
      projectID: 'p',
      directory: '/work/lotus',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    },
  ];
  local.permissions = [
    { id: 'per_same', sessionID: 'ses_same', action: 'local', resources: [], save: [] },
  ];
  remote.permissions = [
    { id: 'per_same', sessionID: 'ses_same', action: 'remote', resources: [], save: [] },
  ];
  return { local, remote };
}

describe('multi-server harness', () => {
  test('colliding session and permission IDs stay on their own backends', async () => {
    const { local, remote } = colliding();
    const manager = new ServerConnectionManager();
    manager.add({
      serverID: 'local',
      connection: connection('http://localhost:4096'),
      backend: local,
      remoteFilesystem: false,
    });
    manager.add({
      serverID: 'srv_1',
      connection: connection('http://build:4096'),
      backend: remote,
    });

    expect(manager.backendFor('local')).toBe(local);
    expect(manager.backendFor('srv_1')).toBe(remote);
    expect((await local.listPermissions('ses_same'))[0]?.action).toBe('local');
    expect((await remote.listPermissions('ses_same'))[0]?.action).toBe('remote');
    await manager.remove('srv_1');
    expect((await local.listPermissions('ses_same'))[0]?.action).toBe('local');
    expect(remote.calls.filter((call) => call.name === 'interrupt')).toEqual([]);
  });

  test('a controller routes a colliding remote session to its backend', async () => {
    const { local, remote } = colliding();
    const byServer: Record<string, Backend> = { local, srv_1: remote };
    const controller = new AppController({
      backend: local,
      backendFor: (serverID: string) => byServer[serverID],
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
    controller.state.sessions['server:srv_1/session:ses_same'] = remote.sessions[0]!;
    controller.openSession('ses_same', 'srv_1');
    for (let round = 0; round < 5; round += 1) await Promise.resolve();
    const all = Object.values(controller.state.permissions).flat();
    expect(all.some((permission) => permission.action === 'remote')).toBe(true);
    expect(all.some((permission) => permission.action === 'local')).toBe(false);
    controller.dispose();
  });
});
