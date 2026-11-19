import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackendError } from '../src/adapter/backend.ts';
import type { Connection } from '../src/adapter/connection.ts';
import {
  createProductionAssembly,
  type ProductionAssemblyInput,
  wireServerStream,
} from '../src/app/production-assembly.ts';
import { defaultConfig } from '../src/config/config.ts';
import { memoryCredentialStore } from '../src/config/credentials.ts';
import { emptyState } from '../src/config/local-state.ts';
import { emptyServerProfiles, loadServerProfiles } from '../src/config/server-profiles.ts';
import { composerFrom } from '../src/domain/composer.ts';
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
  const assembly = await createProductionAssembly({
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

  test('unpair removes the credential, the profile and the live server durably', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'margarita-unpair-'));
    const serversFile = join(directory, 'servers.json');
    await writeFile(
      serversFile,
      JSON.stringify({
        schemaVersion: 1,
        profiles: [
          {
            serverID: 'srv_1',
            shortname: 'buildbox',
            baseUrl: 'http://build.test:4096',
            auth: 'bearer',
          },
        ],
      }),
    );
    const credentials = memoryCredentialStore();
    await credentials.set('srv_1', 'tok_secret');
    const { local, remote } = collidingBackends();
    const assembly = await createProductionAssembly({
      config: defaultConfig,
      platform: 'linux',
      cwd: '/work/lotus',
      version: '0.0.1',
      paths: { stateFile: join(directory, 'state.json'), serversFile, stateDir: directory },
      env: {},
      credentials,
      connections: [
        {
          serverID: 'local',
          connection: remoteConnection('http://launch.test:4096'),
          backend: local,
          remoteFilesystem: false,
        },
        {
          serverID: 'srv_1',
          label: 'buildbox',
          connection: remoteConnection('http://build.test:4096'),
          backend: remote,
          remoteFilesystem: true,
        },
      ],
      profiles: (await loadServerProfiles(serversFile)).profiles,
      localState: emptyState,
      requestExit: () => {},
    });

    await assembly.serverAdmin.unpair('srv_1');

    // The record is gone from disk, so no restart or stale snapshot can bring it back.
    expect((await loadServerProfiles(serversFile)).profiles.profiles).toHaveLength(0);
    expect(await credentials.get('srv_1')).toBeUndefined();
    expect(assembly.servers.list().map((managed) => managed.serverID)).toEqual(['local']);
    expect(() => assembly.servers.backendFor('srv_1')).toThrow('Unknown server');

    assembly.controller.dispose();
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

function summaryFor(serverID: string, id: string, updatedAt: number) {
  return {
    id,
    serverID,
    projectID: 'p',
    directory: '/work/lotus',
    createdAt: 0,
    updatedAt,
    archived: false,
  };
}

type RestoreFixture = Readonly<{
  directory: string;
  serversFile: string;
  credentials: ReturnType<typeof memoryCredentialStore>;
  local: FakeBackend;
  build: FakeBackend;
  camp: FakeBackend;
  createBackend: NonNullable<ProductionAssemblyInput['createBackend']>;
}>;

/** Disk holds two paired remotes; the factory returns pre-made fakes per server ID. */
async function restoreFixture(): Promise<RestoreFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'margarita-restore-'));
  const serversFile = join(directory, 'servers.json');
  await writeFile(
    serversFile,
    JSON.stringify({
      schemaVersion: 1,
      profiles: [
        {
          serverID: 'srv_a',
          shortname: 'buildbox',
          baseUrl: 'http://build.test:4096',
          auth: 'bearer',
        },
        { serverID: 'srv_b', shortname: 'camp', baseUrl: 'http://camp.test:4096', auth: 'bearer' },
      ],
    }),
  );
  const credentials = memoryCredentialStore();
  await credentials.set('srv_a', 'tok_a');
  await credentials.set('srv_b', 'tok_b');
  const local = new FakeBackend();
  local.sessions = [summaryFor('local', 'ses_local', 3)];
  const build = new FakeBackend();
  build.sessions = [summaryFor('srv_a', 'ses_build', 2)];
  const camp = new FakeBackend();
  camp.sessions = [summaryFor('srv_b', 'ses_camp', 1)];
  const fakes = new Map([
    ['srv_a', build],
    ['srv_b', camp],
  ]);
  const createBackend: NonNullable<ProductionAssemblyInput['createBackend']> = (
    _connection,
    options,
  ) => fakes.get(options?.serverID ?? '') ?? new FakeBackend();
  return { directory, serversFile, credentials, local, build, camp, createBackend };
}

function restoreInput(
  fixture: RestoreFixture,
  overrides: Partial<ProductionAssemblyInput> = {},
): ProductionAssemblyInput {
  return {
    config: defaultConfig,
    platform: 'linux',
    cwd: '/work/lotus',
    version: '0.0.1',
    paths: {
      stateFile: join(fixture.directory, 'state.json'),
      serversFile: fixture.serversFile,
      stateDir: fixture.directory,
    },
    env: {},
    credentials: fixture.credentials,
    connections: [
      {
        serverID: 'local',
        connection: remoteConnection('http://launch.test:4096'),
        backend: fixture.local,
        remoteFilesystem: false,
      },
    ],
    profiles: {
      schemaVersion: 1,
      profiles: [
        {
          serverID: 'srv_a',
          shortname: 'buildbox',
          baseUrl: 'http://build.test:4096',
          auth: 'bearer',
        },
        {
          serverID: 'srv_b',
          shortname: 'camp',
          baseUrl: 'http://camp.test:4096',
          auth: 'bearer',
        },
      ],
    },
    localState: emptyState,
    createBackend: fixture.createBackend,
    requestExit: () => {},
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Bun.sleep(0);
}

describe('startup restore of paired servers', () => {
  test('a restart restores local plus every paired remote into one overview', async () => {
    const fixture = await restoreFixture();
    const assembly = await createProductionAssembly(restoreInput(fixture));
    expect(assembly.servers.list().map((managed) => managed.serverID)).toEqual([
      'local',
      'srv_a',
      'srv_b',
    ]);

    await assembly.controller.bootstrap();

    expect(Object.keys(assembly.controller.state.sessions).toSorted()).toEqual([
      'server:srv_a/session:ses_build',
      'server:srv_b/session:ses_camp',
      'ses_local',
    ]);
    assembly.controller.dispose();
    await assembly.servers.dispose();
  });

  test('an offline remote does not abort startup; online entries still load', async () => {
    const fixture = await restoreFixture();
    fixture.camp.listSessionsHook = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const assembly = await createProductionAssembly(restoreInput(fixture));

    await assembly.controller.bootstrap();

    expect(assembly.controller.state.sessions['ses_local']).toBeDefined();
    expect(assembly.controller.state.sessions['server:srv_a/session:ses_build']).toBeDefined();
    expect(assembly.controller.state.sessions['server:srv_b/session:ses_camp']).toBeUndefined();
    expect(assembly.controller.state.serverPages['srv_b']?.error).toContain('ECONNREFUSED');
    expect(assembly.controller.state.serverPages['local']?.complete).toBe(true);
    expect(assembly.controller.state.serverPages['srv_a']?.complete).toBe(true);
    assembly.controller.dispose();
    await assembly.servers.dispose();
  });

  test('a paired remote without its credential registers unauthorized and does not abort startup', async () => {
    const fixture = await restoreFixture();
    await fixture.credentials.delete('srv_b');
    fixture.camp.listSessionsHook = () =>
      Promise.reject(new BackendError('unauthorized', 'session.list', 'Unauthorized.'));
    const assembly = await createProductionAssembly(restoreInput(fixture));
    expect(assembly.servers.get('srv_b')?.state).toBe('unauthorized');

    await assembly.controller.bootstrap();

    expect(assembly.controller.state.sessions['ses_local']).toBeDefined();
    expect(assembly.controller.state.serverPages['srv_b']?.error).toBeDefined();
    expect(assembly.controller.state.serverPages['local']?.complete).toBe(true);
    assembly.controller.dispose();
    await assembly.servers.dispose();
  });

  test('a launch-server failure still propagates to the CLI', async () => {
    const fixture = await restoreFixture();
    fixture.local.listSessionsHook = () => Promise.reject(new Error('launch unreachable'));
    const assembly = await createProductionAssembly(restoreInput(fixture));

    expect(assembly.controller.bootstrap()).rejects.toThrow('launch unreachable');
    // The healthy remote still loaded before the launch error was re-thrown.
    expect(assembly.controller.state.sessions['server:srv_a/session:ses_build']).toBeDefined();
    assembly.controller.dispose();
    await assembly.servers.dispose();
  });

  test('pairing a third server while running aggregates its sessions without a restart', async () => {
    const fixture = await restoreFixture();
    // Both pre-paired servers are healthy so the pair is the only change under test.
    const assembly = await createProductionAssembly(
      restoreInput(fixture, {
        pairingFetch: (url: string) => {
          const body = url.includes('/auth/connect/')
            ? { token: 'tok_three' }
            : { version: '2.3.0' };
          return Promise.resolve(
            new Response(JSON.stringify(body), {
              headers: { 'content-type': 'application/json' },
            }),
          );
        },
        generateID: () => 'three',
        createBackend: (_connection, options) => {
          if (options?.serverID === 'srv_three') {
            const third = new FakeBackend();
            third.sessions = [summaryFor('srv_three', 'ses_three', 9)];
            third.eventsHook = (signal) =>
              (async function* () {
                yield { kind: 'connected' };
                await new Promise<void>((resolve) =>
                  signal.addEventListener('abort', () => resolve(), { once: true }),
                );
              })();
            return third;
          }
          return fixture.createBackend(_connection, options);
        },
      }),
    );
    await assembly.controller.bootstrap();
    expect(
      assembly.controller.state.sessions['server:srv_three/session:ses_three'],
    ).toBeUndefined();

    assembly.controller.setComposer(
      composerFrom('/pair https://third.test:4096/auth/connect/code123 --as three'),
    );
    await assembly.controller.submit();
    await flush();

    // The host is registered, subscribed, aggregated and persisted — all without a restart.
    expect(assembly.servers.get('srv_three')).toBeDefined();
    expect(assembly.servers.get('srv_three')?.state).toBe('online');
    expect(assembly.controller.state.sessions['server:srv_three/session:ses_three']).toBeDefined();
    const persisted = await loadServerProfiles(fixture.serversFile);
    expect(persisted.profiles.profiles.map((profile) => profile.serverID).toSorted()).toEqual([
      'srv_a',
      'srv_b',
      'srv_three',
    ]);
    expect(await fixture.credentials.get('srv_three')).toBe('tok_three');

    assembly.controller.dispose();
    await assembly.servers.dispose();
  });

  test('unpairing the third server stops only its stream and is not restored on restart', async () => {
    const fixture = await restoreFixture();
    const assembly = await createProductionAssembly(
      restoreInput(fixture, {
        pairingFetch: (url: string) => {
          const body = url.includes('/auth/connect/')
            ? { token: 'tok_three' }
            : { version: '2.3.0' };
          return Promise.resolve(
            new Response(JSON.stringify(body), {
              headers: { 'content-type': 'application/json' },
            }),
          );
        },
        generateID: () => 'three',
        createBackend: fixture.createBackend,
      }),
    );
    await assembly.controller.bootstrap();
    assembly.controller.setComposer(
      composerFrom('/pair https://third.test:4096/auth/connect/code123 --as three'),
    );
    await assembly.controller.submit();
    await flush();
    expect(assembly.servers.get('srv_three')).toBeDefined();

    assembly.controller.setComposer(composerFrom('/unpair three'));
    await assembly.controller.submit();
    await flush();

    // Only the third host is gone; the other two keep their registrations.
    expect(assembly.servers.list().map((managed) => managed.serverID)).toEqual([
      'local',
      'srv_a',
      'srv_b',
    ]);
    assembly.controller.dispose();
    await assembly.servers.dispose();

    // Restarting against the same files restores the two pre-existing remotes only.
    const restarted = await createProductionAssembly(restoreInput(fixture));
    expect(
      restarted.servers
        .list()
        .map((managed) => managed.serverID)
        .toSorted(),
    ).toEqual(['local', 'srv_a', 'srv_b']);
    restarted.controller.dispose();
    await restarted.servers.dispose();
  });
});

describe('stream reconnect through the production wiring (issue #63)', () => {
  test('a restored remote’s reconnect resyncs only that host', async () => {
    const fixture = await restoreFixture();
    let campListCalls = 0;
    fixture.camp.listSessionsHook = async () => {
      campListCalls += 1;
      return { sessions: fixture.camp.sessions };
    };
    fixture.local.sessions = [summaryFor('local', 'ses_local', 3)];
    let localListCalls = 0;
    fixture.local.listSessionsHook = async () => {
      localListCalls += 1;
      return { sessions: fixture.local.sessions };
    };
    // The restored host's stream connects on its own schedule and announces with 'connected'.
    fixture.camp.eventsHook = (signal) =>
      (async function* () {
        yield { kind: 'connected' };
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      })();

    const assembly = await createProductionAssembly(
      restoreInput(fixture, {
        createBackend: (_connection, options) => {
          if (options?.serverID === 'srv_b') return fixture.camp;
          return fixture.createBackend(_connection, options);
        },
      }),
    );
    await assembly.controller.bootstrap();
    expect(campListCalls).toBe(1);
    expect(localListCalls).toBe(1);

    // The runtime wires its stream — exactly what main.ts does at startup and after pairing.
    wireServerStream(assembly.servers, assembly.controller, 'srv_b');
    await Bun.sleep(75); // the pump flushes its 'connected' resync after 50ms
    await flush();

    expect(campListCalls).toBeGreaterThan(1); // the reconnect resynced B
    expect(localListCalls).toBe(1); // A never reloaded
    // The single stream badge is not driven by the remote stream.
    expect(assembly.controller.state.stream).not.toBe('reconnecting');
    // A's cached rows survived.
    expect(assembly.controller.state.sessions['ses_local']).toBeDefined();
    expect(assembly.servers.get('srv_b')?.state).toBe('online');
    assembly.controller.dispose();
    await assembly.servers.dispose();
  });
});

// ---------------------------------------------------------- issue #66

type ThreeFixture = Readonly<{
  directory: string;
  serversFile: string;
  credentials: ReturnType<typeof memoryCredentialStore>;
  local: FakeBackend;
  bravo: FakeBackend;
  charlie: FakeBackend;
  createBackend: NonNullable<ProductionAssemblyInput['createBackend']>;
}>;

/**
 * Three hosts: the launch server (A, paginated), a paired "bravo" (B), a paired "charlie" (C).
 * Both remotes start healthy so a bootstrap can populate the cache; hooks flip them down later.
 */
async function threeServerFixture(): Promise<ThreeFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'margarita-three-'));
  const serversFile = join(directory, 'servers.json');
  await writeFile(
    serversFile,
    JSON.stringify({
      schemaVersion: 1,
      profiles: [
        {
          serverID: 'srv_b',
          shortname: 'bravo',
          baseUrl: 'http://bravo.test:4096',
          auth: 'bearer',
        },
        {
          serverID: 'srv_c',
          shortname: 'charlie',
          baseUrl: 'http://charlie.test:4096',
          auth: 'bearer',
        },
      ],
    }),
  );
  const credentials = memoryCredentialStore();
  await credentials.set('srv_b', 'tok_b');
  await credentials.set('srv_c', 'tok_c');
  const local = new FakeBackend();
  local.serverID = 'local';
  local.listSessionsHook = async (query) => {
    if (query.cursor === 'cursor-2') {
      return { sessions: [summaryFor('local', 'ses_a_2', 2)] };
    }
    return { sessions: [summaryFor('local', 'ses_a_1', 1)], nextCursor: 'cursor-2' };
  };
  const bravo = new FakeBackend();
  bravo.serverID = 'srv_b';
  bravo.sessions = [summaryFor('srv_b', 'ses_b', 4)];
  const charlie = new FakeBackend();
  charlie.serverID = 'srv_c';
  charlie.sessions = [summaryFor('srv_c', 'ses_c', 5)];
  const fakes = new Map([
    ['srv_b', bravo],
    ['srv_c', charlie],
  ]);
  const createBackend: NonNullable<ProductionAssemblyInput['createBackend']> = (
    _connection,
    options,
  ) => fakes.get(options?.serverID ?? '') ?? new FakeBackend();
  return { directory, serversFile, credentials, local, bravo, charlie, createBackend };
}

function threeServerInput(
  fixture: ThreeFixture,
  overrides: Partial<ProductionAssemblyInput> = {},
): ProductionAssemblyInput {
  return {
    config: defaultConfig,
    platform: 'linux',
    cwd: '/work/lotus',
    version: '0.0.1',
    paths: {
      stateFile: join(fixture.directory, 'state.json'),
      serversFile: fixture.serversFile,
      stateDir: fixture.directory,
    },
    env: {},
    credentials: fixture.credentials,
    connections: [
      {
        serverID: 'local',
        connection: remoteConnection('http://launch.test:4096'),
        backend: fixture.local,
        remoteFilesystem: false,
      },
    ],
    profiles: {
      schemaVersion: 1,
      profiles: [
        {
          serverID: 'srv_b',
          shortname: 'bravo',
          baseUrl: 'http://bravo.test:4096',
          auth: 'bearer',
        },
        {
          serverID: 'srv_c',
          shortname: 'charlie',
          baseUrl: 'http://charlie.test:4096',
          auth: 'bearer',
        },
      ],
    },
    localState: emptyState,
    createBackend: fixture.createBackend,
    requestExit: () => {},
    ...overrides,
  };
}

const bKey = 'server:srv_b/session:ses_b';
const cKey = 'server:srv_c/session:ses_c';
const bKey2 = 'server:srv_b/session:ses_b2';

describe('three-server failure isolation (issue #66)', () => {
  test('bootstrap and load-more succeed for A; B/C keep cache and report grey dots', async () => {
    const fixture = await threeServerFixture();
    const assembly = await createProductionAssembly(threeServerInput(fixture));
    const { controller } = assembly;
    await controller.bootstrap();

    // Bootstrap: A's first page plus B/C from the healthy pass, all present and online.
    expect(controller.state.sessions['ses_a_1']).toBeDefined();
    expect(controller.state.sessions[bKey]).toBeDefined();
    expect(controller.state.sessions[cKey]).toBeDefined();
    expect(assembly.servers.get('srv_b')?.state).toBe('online');
    expect(assembly.servers.get('srv_c')?.state).toBe('online');
    expect(assembly.servers.get('srv_b')?.label).toBe('bravo');
    expect(assembly.servers.get('srv_c')?.label).toBe('charlie');

    // B dies hard (ECONNREFUSED); C rejects the token.
    fixture.bravo.listSessionsHook = async () => {
      throw new BackendError('transport', 'listSessions', 'connect ECONNREFUSED');
    };
    fixture.charlie.listSessionsHook = async () => {
      throw new BackendError('unauthorized', 'listSessions', 'token rejected');
    };

    await controller.loadSessions();

    // A is unaffected; B/C keep their last-known rows and go grey.
    expect(controller.state.sessions['ses_a_1']).toBeDefined();
    expect(controller.state.sessions[bKey]).toBeDefined();
    expect(controller.state.sessions[cKey]).toBeDefined();
    expect(controller.state.serverPages['local']?.loading).toBe(false);
    expect(controller.state.serverPages['local']?.error).toBeUndefined();
    expect(controller.state.serverPages['srv_b']?.loading).toBe(false);
    expect(controller.state.serverPages['srv_c']?.loading).toBe(false);
    expect(controller.state.serverPages['srv_b']?.error).toContain('ECONNREFUSED');
    expect(assembly.servers.get('srv_b')?.state).toBe('offline');
    expect(assembly.servers.get('srv_c')?.state).toBe('unauthorized');
    expect(assembly.servers.get('local')?.state).toBe('online');
    const bRow = controller.state.sessions[bKey];
    if (bRow === undefined) throw new Error('bravo row dropped from the overview');
    const cRow = controller.state.sessions[cKey];
    if (cRow === undefined) throw new Error('charlie row dropped from the overview');
    expect(controller.statusOf(bRow)).toBe('unknown');
    expect(controller.statusOf(cRow)).toBe('unknown');

    // Load-more: A merges its second page; B/C stay cached with the same failures.
    await controller.loadMoreSessions();
    expect(controller.state.sessions['ses_a_2']).toBeDefined();
    expect(controller.state.serverPages['local']?.complete).toBe(true);
    expect(controller.state.sessions[bKey]).toBeDefined();
    expect(controller.state.sessions[cKey]).toBeDefined();
    expect(assembly.servers.get('srv_b')?.state).toBe('offline');
    expect(assembly.servers.get('srv_c')?.state).toBe('unauthorized');

    // B recovers: its page refreshes; A and C do not change.
    delete fixture.bravo.listSessionsHook;
    fixture.bravo.sessions = [summaryFor('srv_b', 'ses_b', 9), summaryFor('srv_b', 'ses_b2', 8)];
    const a2Before = controller.state.sessions['ses_a_2'];
    if (a2Before === undefined) throw new Error('ses_a_2 missing before recovery');
    await controller.loadSessions();
    expect(assembly.servers.get('srv_b')?.state).toBe('online');
    expect(controller.state.sessions[bKey2]).toBeDefined();
    const bRecovered = controller.state.sessions[bKey];
    if (bRecovered === undefined) throw new Error('bravo row missing after recovery');
    expect(controller.statusOf(bRecovered)).toBe('idle');
    expect(controller.state.sessions['ses_a_2']?.updatedAt).toBe(a2Before.updatedAt);
    expect(controller.state.serverPages['local']?.complete).toBe(true);
    expect(assembly.servers.get('srv_c')?.state).toBe('unauthorized');
    const cRecovered = controller.state.sessions[cKey];
    if (cRecovered === undefined) throw new Error('charlie row missing after recovery');
    expect(controller.statusOf(cRecovered)).toBe('unknown');

    assembly.controller.dispose();
    await assembly.servers.dispose();
  });

  test('a server removed mid-reload can never reappear', async () => {
    const fixture = await threeServerFixture();
    const assembly = await createProductionAssembly(threeServerInput(fixture));
    const { controller } = assembly;
    await controller.bootstrap();
    expect(controller.state.sessions[bKey]).toBeDefined();

    // B's listing hangs; A and C answer instantly.
    let releaseBravo: (() => void) | undefined;
    fixture.bravo.listSessionsHook = () =>
      new Promise((resolve) => {
        releaseBravo = () => resolve({ sessions: fixture.bravo.sessions });
      });

    const pending = controller.loadSessions();
    controller.setComposer(composerFrom('/unpair bravo'));
    await controller.submit();
    releaseBravo?.();
    await pending;
    await flush();

    // B is gone from the manager, the overview, the profile file and the keychain —
    // and its in-flight refresh was discarded, not applied.
    expect(assembly.servers.get('srv_b')).toBeUndefined();
    expect(Object.keys(controller.state.sessions).filter((key) => key.includes('srv_b'))).toEqual(
      [],
    );
    const disk = await loadServerProfiles(fixture.serversFile);
    expect(disk.profiles.profiles.map((profile) => profile.serverID)).toEqual(['srv_c']);
    expect(await fixture.credentials.get('srv_b')).toBeUndefined();
    // A and C are unaffected by the removal.
    expect(controller.state.sessions['ses_a_1']).toBeDefined();
    expect(controller.state.sessions[cKey]).toBeDefined();
    expect(assembly.servers.get('srv_c')?.state).toBe('online');

    assembly.controller.dispose();
    await assembly.servers.dispose();
  });
});
