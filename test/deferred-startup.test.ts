import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DebugLog } from '../src/app/debug-log.ts';
import {
  createProductionAssembly,
  type ProductionAssemblyInput,
} from '../src/app/production-assembly.ts';
import { defaultConfig } from '../src/config/config.ts';
import {
  type CredentialStore,
  memoryCredentialStore,
  unavailableCredentialStore,
} from '../src/config/credentials.ts';
import { emptyState } from '../src/config/local-state.ts';
import {
  emptyServerProfiles,
  type ServerProfile,
  type ServerProfiles,
} from '../src/config/server-profiles.ts';
import { enqueueCredentialCleanup } from '../src/config/unpair-recovery.ts';
import type { SessionSummary } from '../src/domain/session.ts';
import { FakeBackend } from './fake-backend.ts';

function queuedIDs(text: string): string[] {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || !('serverIDs' in parsed)) {
    throw new Error('pending queue is not an object with serverIDs');
  }
  const ids = parsed.serverIDs;
  if (!Array.isArray(ids)) throw new Error('pending queue serverIDs is not an array');
  return ids.filter((entry): entry is string => typeof entry === 'string');
}

function profileFor(index: number, auth: 'bearer' | 'none' = 'bearer'): ServerProfile {
  return {
    serverID: `srv_${index}`,
    shortname: `host-${index}`,
    baseUrl: `http://host-${index}.test:4096`,
    auth,
  };
}

function profilesOf(entries: readonly ServerProfile[]): ServerProfiles {
  return { schemaVersion: 1, profiles: entries };
}

function summary(serverID: string): SessionSummary {
  return {
    id: `ses_${serverID}`,
    serverID,
    projectID: 'p',
    directory: '/work/deferred',
    title: `Deferred ${serverID}`,
    createdAt: 0,
    updatedAt: 1,
    archived: false,
  };
}

function recordingLog(): {
  log: DebugLog;
  entries: { kind: string; fields?: Record<string, unknown> }[];
} {
  const entries: { kind: string; fields?: Record<string, unknown> }[] = [];
  return {
    entries,
    log: {
      enabled: true,
      write: (kind, fields) => {
        entries.push({ kind, ...(fields === undefined ? {} : { fields }) });
      },
      close: () => {},
    },
  };
}

async function fixture(
  profiles: readonly ServerProfile[],
  options: Readonly<{
    credentials?: CredentialStore;
    defer?: boolean;
    restoreConcurrency?: number;
    debugLog?: DebugLog;
    createBackend?: ProductionAssemblyInput['createBackend'];
    onServerRestored?: (serverID: string) => void;
  }> = {},
): Promise<{
  directory: string;
  serversFile: string;
  assembly: Awaited<ReturnType<typeof createProductionAssembly>>;
  local: FakeBackend;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'margarita-deferred-'));
  const serversFile = join(directory, 'servers.json');
  await writeFile(serversFile, JSON.stringify(profilesOf(profiles)));
  const local = new FakeBackend();
  local.sessions = [summary('local')];
  const credentials = options.credentials ?? memoryCredentialStore();
  for (const profile of profiles) {
    if (profile.auth === 'none') continue;
    if (credentials.kind === 'memory')
      await credentials.set(profile.serverID, `tok_${profile.serverID}`);
  }
  const createBackend: NonNullable<ProductionAssemblyInput['createBackend']> =
    options.createBackend ??
    ((_connection, backendOptions) => {
      const backend = new FakeBackend();
      backend.serverID = backendOptions?.serverID ?? 'local';
      backend.sessions = [summary(backend.serverID)];
      return backend;
    });
  const assembly = await createProductionAssembly({
    config: defaultConfig,
    platform: 'linux',
    cwd: '/work/deferred',
    version: '0.0.1',
    paths: {
      stateFile: join(directory, 'state.json'),
      serversFile,
      stateDir: directory,
    },
    env: {},
    credentials,
    connections: [
      {
        serverID: 'local',
        connection: { baseUrl: 'http://launch.test:4096', headers: {}, origin: 'discovered' },
        backend: local,
        remoteFilesystem: false,
      },
    ],
    profiles: profilesOf(profiles),
    localState: emptyState,
    deferSavedServers: options.defer ?? true,
    ...(options.restoreConcurrency === undefined
      ? {}
      : { restoreConcurrency: options.restoreConcurrency }),
    ...(options.debugLog === undefined ? {} : { debugLog: options.debugLog }),
    createBackend,
    ...(options.onServerRestored === undefined
      ? {}
      : { onServerRestored: options.onServerRestored }),
    requestExit: () => {},
  });
  return { directory, serversFile, assembly, local };
}

async function dispose(
  assembly: Awaited<ReturnType<typeof createProductionAssembly>>,
): Promise<void> {
  assembly.controller.dispose();
  await assembly.servers.dispose();
  await assembly.clipboard.dispose();
}

describe('deferred paired-server restore (#346)', () => {
  test('metadata is visible before any credential read or session request', async () => {
    let reads = 0;
    const base = memoryCredentialStore();
    const credentials: CredentialStore = {
      ...base,
      async get(serverID) {
        reads += 1;
        return base.get(serverID);
      },
    };
    const { assembly } = await fixture([profileFor(1), profileFor(2)], {
      credentials,
      createBackend: () => {
        throw new Error('no backend may be created before restore');
      },
    });
    expect(reads).toBe(0);
    expect(assembly.servers.get('srv_1')).toBeUndefined();
    expect(assembly.controller.deferredServerList()).toEqual([
      {
        serverID: 'srv_1',
        label: 'host-1',
        baseUrl: 'http://host-1.test:4096',
        state: 'restoring',
      },
      {
        serverID: 'srv_2',
        label: 'host-2',
        baseUrl: 'http://host-2.test:4096',
        state: 'restoring',
      },
    ]);
    await dispose(assembly);
    expect(reads).toBe(0);
  });

  test('maintenance reads credentials with bounded concurrency and registers the launches', async () => {
    let active = 0;
    let peak = 0;
    const base = memoryCredentialStore();
    const credentials: CredentialStore = {
      ...base,
      async get(serverID) {
        active += 1;
        peak = Math.max(peak, active);
        await Bun.sleep(5);
        active -= 1;
        return base.get(serverID);
      },
    };
    const headers = new Map<string, string>();
    const { assembly } = await fixture(
      Array.from({ length: 12 }, (_, index) => profileFor(index)),
      {
        credentials,
        restoreConcurrency: 3,
        createBackend: (connection, backendOptions) => {
          const backend = new FakeBackend();
          backend.serverID = backendOptions?.serverID ?? 'local';
          backend.sessions = [summary(backend.serverID)];
          if (connection.headers['authorization'] !== undefined) {
            headers.set(backend.serverID, connection.headers['authorization']);
          }
          return backend;
        },
      },
    );
    const restored = await assembly.restoreSavedServers();
    expect(restored).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(3);
    expect(headers.get('srv_3')).toBe('Bearer tok_srv_3');
    expect(assembly.controller.deferredServerList()).toEqual([]);
    expect(
      assembly.servers
        .list()
        .map((entry) => entry.serverID)
        .toSorted(),
    ).toContain('srv_11');
    await dispose(assembly);
  });

  test('a missing credential registers an unauthorized host without issuing a session read', async () => {
    const credentials = memoryCredentialStore();
    let sessionReads = 0;
    const { assembly } = await fixture([profileFor(1)], {
      credentials,
      createBackend: (_connection, backendOptions) => {
        const backend = new FakeBackend();
        backend.serverID = backendOptions?.serverID ?? 'local';
        const original = backend.listSessions.bind(backend);
        backend.listSessions = async (query) => {
          if (backend.serverID === 'srv_1') sessionReads += 1;
          return original(query);
        };
        return backend;
      },
    });
    await credentials.delete('srv_1');
    await assembly.restoreSavedServers();
    expect(assembly.servers.get('srv_1')?.state).toBe('unauthorized');
    expect(assembly.controller.deferredServerList()).toMatchObject([
      { serverID: 'srv_1', state: 'unauthorized' },
    ]);
    expect(sessionReads).toBe(0);
    await dispose(assembly);
  });

  test('auth:none restores anonymously without consulting an unavailable store', async () => {
    const credentials = unavailableCredentialStore('no keyring');
    const { assembly } = await fixture([profileFor(1, 'none')], { credentials });
    await assembly.restoreSavedServers();
    expect(assembly.servers.get('srv_1')?.state).toBe('connecting');
    expect(assembly.servers.get('srv_1')?.connection.headers['authorization']).toBeUndefined();
    await dispose(assembly);
  });

  test('unpairing during an in-flight credential read cannot resurrect the host', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = memoryCredentialStore();
    const credentials: CredentialStore = {
      ...base,
      async get(serverID) {
        await gate;
        return base.get(serverID);
      },
    };
    const { assembly } = await fixture([profileFor(1)], { credentials });
    const restoring = assembly.restoreSavedServers();
    const outcome = await assembly.serverAdmin.unpair('srv_1');
    expect(outcome).toMatchObject({ credentialCleanup: 'done' });
    release?.();
    await restoring;
    expect(assembly.servers.get('srv_1')).toBeUndefined();
    expect(assembly.controller.deferredServerList()).toEqual([]);
    await dispose(assembly);
  });

  test('credential read timing is logged without the secret', async () => {
    const recorded = recordingLog();
    const { assembly } = await fixture([profileFor(1)], { debugLog: recorded.log });
    await assembly.restoreSavedServers();
    const read = recorded.entries.find((entry) => entry.kind === 'credential-read');
    expect(read?.fields?.['serverID']).toBe('srv_1');
    expect(read?.fields?.['platform']).toBe('linux');
    expect(typeof read?.fields?.['ms']).toBe('number');
    expect(JSON.stringify(recorded.entries)).not.toContain('tok_srv_1');
    await dispose(assembly);
  });
});

describe('deferred credential-cleanup recovery (#348)', () => {
  test('the queue survives until maintenance and keeps only failed deletions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'margarita-cleanup-'));
    const base = memoryCredentialStore();
    const deleted: string[] = [];
    const credentials: CredentialStore = {
      ...base,
      async delete(serverID) {
        deleted.push(serverID);
        if (serverID === 'srv_bad') throw new Error('keyring unavailable');
        await base.delete(serverID);
      },
    };
    for (const id of ['srv_ok', 'srv_bad', 'srv_other']) {
      await enqueueCredentialCleanup(directory, id);
      await credentials.set(id, 'secret');
    }
    const queuePath = join(directory, 'pending-unpair.json');
    const queuedBefore = queuedIDs(await readFile(queuePath, 'utf8'));
    expect(queuedBefore.toSorted()).toEqual(['srv_bad', 'srv_ok', 'srv_other']);

    const local = new FakeBackend();
    local.sessions = [summary('local')];
    const second = await createProductionAssembly({
      config: defaultConfig,
      platform: 'win32',
      cwd: '/work/deferred',
      version: '0.0.1',
      paths: {
        stateFile: join(directory, 'state.json'),
        serversFile: join(directory, 'servers.json'),
        stateDir: directory,
      },
      env: {},
      credentials,
      connections: [
        {
          serverID: 'local',
          connection: { baseUrl: 'http://launch.test:4096', headers: {}, origin: 'discovered' },
          backend: local,
          remoteFilesystem: false,
        },
      ],
      profiles: emptyServerProfiles,
      localState: emptyState,
      deferSavedServers: true,
      requestExit: () => {},
    });
    // Nothing ran yet: the queue is intact.
    expect(JSON.parse(await readFile(queuePath, 'utf8'))).toEqual({
      serverIDs: ['srv_ok', 'srv_bad', 'srv_other'],
    });

    await second.runDeferredMaintenance();
    const remaining = queuedIDs(await readFile(queuePath, 'utf8'));
    expect(remaining).toEqual(['srv_bad']);
    expect(await credentials.get('srv_ok')).toBeUndefined();
    expect(await credentials.get('srv_other')).toBeUndefined();
    expect(await credentials.get('srv_bad')).toBe('secret');
    expect(deleted.toSorted()).toEqual(['srv_bad', 'srv_ok', 'srv_other']);

    // A second maintenance run in the same process must not repeat the deletion attempts.
    await second.runDeferredMaintenance();
    expect(deleted).toHaveLength(3);
    second.controller.dispose();
    await second.servers.dispose();
    await second.clipboard.dispose();
  });

  test('a malformed queue is left untouched and surfaced through the notice/debug path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'margarita-cleanup-bad-'));
    const queuePath = join(directory, 'pending-unpair.json');
    await writeFile(queuePath, '{not json');
    const local = new FakeBackend();
    local.sessions = [summary('local')];
    const recorded = recordingLog();
    const assembly = await createProductionAssembly({
      config: defaultConfig,
      platform: 'linux',
      cwd: '/work/deferred',
      version: '0.0.1',
      paths: {
        stateFile: join(directory, 'state.json'),
        serversFile: join(directory, 'servers.json'),
        stateDir: directory,
      },
      env: {},
      credentials: unavailableCredentialStore('no keyring'),
      connections: [
        {
          serverID: 'local',
          connection: { baseUrl: 'http://launch.test:4096', headers: {}, origin: 'discovered' },
          backend: local,
          remoteFilesystem: false,
        },
      ],
      profiles: emptyServerProfiles,
      localState: emptyState,
      deferSavedServers: true,
      debugLog: recorded.log,
      requestExit: () => {},
    });
    await assembly.runDeferredMaintenance();
    expect(await readFile(queuePath, 'utf8')).toBe('{not json');
    expect(assembly.controller.state.notice?.tone).toBe('error');
    expect(recorded.entries.some((entry) => entry.kind === 'unpair-recovery')).toBe(true);
    assembly.controller.dispose();
    await assembly.servers.dispose();
    await assembly.clipboard.dispose();
  });
});
