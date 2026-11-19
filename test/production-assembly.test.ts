import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Connection } from '../src/adapter/connection.ts';
import { createProductionAssembly } from '../src/app/production-assembly.ts';
import { defaultConfig } from '../src/config/config.ts';
import { memoryCredentialStore } from '../src/config/credentials.ts';
import { emptyState } from '../src/config/local-state.ts';
import { emptyServerProfiles } from '../src/config/server-profiles.ts';
import { FakeBackend } from './fake-backend.ts';

function remoteConnection(url: string): Connection {
  return { baseUrl: url, headers: {}, origin: 'remote' };
}

function remoteSummary(serverID: string) {
  return {
    id: 'ses_same',
    serverID,
    projectID: 'p',
    directory: '/work/lotus',
    createdAt: 0,
    updatedAt: 1,
    archived: false,
  };
}

/** A and B both hold session and permission `ses_same`/`per_same` with different data. */
function collidingBackends() {
  const local = new FakeBackend();
  const remote = new FakeBackend();
  local.sessions = [remoteSummary('local')];
  remote.sessions = [remoteSummary('srv_1')];
  local.permissions = [
    { id: 'per_same', sessionID: 'ses_same', action: 'local', resources: [], save: [] },
  ];
  remote.permissions = [
    { id: 'per_same', sessionID: 'ses_same', action: 'remote', resources: [], save: [] },
  ];
  return { local, remote };
}

async function makeAssembly() {
  const directory = await mkdtemp(join(tmpdir(), 'margarita-assembly-'));
  const { local, remote } = collidingBackends();
  const assembly = createProductionAssembly({
    config: defaultConfig,
    platform: 'linux',
    cwd: '/work/lotus',
    version: '0.0.1',
    paths: {
      stateFile: join(directory, 'state.json'),
      serversFile: join(directory, 'servers.json'),
      stateDir: directory,
    },
    env: {},
    credentials: memoryCredentialStore(),
    connections: [
      {
        serverID: 'local',
        connection: remoteConnection('http://launch.test:4096'),
        backend: local,
        remoteFilesystem: false,
      },
      {
        serverID: 'srv_1',
        label: 'build',
        connection: remoteConnection('http://build.test:4096'),
        backend: remote,
        remoteFilesystem: true,
      },
    ],
    profiles: emptyServerProfiles,
    localState: emptyState,
    requestExit: () => {},
  });
  return { assembly, local, remote };
}

describe('production assembly (main-path wiring)', () => {
  test('opens the remote row and routes its actions to the remote backend only', async () => {
    const { assembly, local, remote } = await makeAssembly();
    const { controller } = assembly;
    await controller.bootstrap();

    // The overview session keys are distinct even though the wire IDs collide.
    expect(Object.keys(controller.state.sessions).toSorted()).toEqual([
      'server:srv_1/session:ses_same',
      'ses_same',
    ]);

    controller.openSession('ses_same', 'srv_1');
    for (let round = 0; round < 10; round += 1) await Bun.sleep(0);

    const sent = await controller.sendToSession('ses_same', 'ship it');
    expect(sent).toBe(true);
    expect(remote.calls.filter((call) => call.name === 'prompt')).toHaveLength(1);
    expect(local.calls.filter((call) => call.name === 'prompt')).toHaveLength(0);

    controller.dispose();
    await assembly.servers.dispose();
  });

  test('after removing the remote server, actions fail closed and never touch the launch backend', async () => {
    const { assembly, local, remote } = await makeAssembly();
    const { controller, servers } = assembly;
    await controller.bootstrap();
    controller.openSession('ses_same', 'srv_1');
    for (let round = 0; round < 10; round += 1) await Bun.sleep(0);
    expect(await controller.sendToSession('ses_same', 'first')).toBe(true);
    expect(remote.calls.filter((call) => call.name === 'prompt')).toHaveLength(1);

    await servers.remove('srv_1');

    const sent = await controller.sendToSession('ses_same', 'again');
    expect(sent).toBe(false);
    expect(local.calls.filter((call) => call.name === 'prompt')).toHaveLength(0);
    expect(remote.calls.filter((call) => call.name === 'prompt')).toHaveLength(1);
    expect(controller.state.notice?.tone).toBe('error');
    expect(controller.state.notice?.text).toContain('srv_1');

    controller.dispose();
    await assembly.servers.dispose();
  });
});
