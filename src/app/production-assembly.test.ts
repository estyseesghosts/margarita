import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBackend } from '../../test/fake-backend.ts';
import type { Connection } from '../adapter/connection.ts';
import { defaultConfig } from '../config/config.ts';
import {
  type CredentialStore,
  memoryCredentialStore,
  unavailableCredentialStore,
} from '../config/credentials.ts';
import { emptyState } from '../config/local-state.ts';
import { loadServerProfiles, type ServerProfiles } from '../config/server-profiles.ts';
import { reconcileCredentialCleanup } from '../config/unpair-recovery.ts';
import { createProductionAssembly } from './production-assembly.ts';

const launchConnection: Connection = {
  baseUrl: 'http://localhost:4096',
  headers: {},
  origin: 'discovered',
};

const pairedProfiles = (auth: 'bearer' | 'none' = 'bearer'): ServerProfiles => ({
  schemaVersion: 1,
  profiles: [
    {
      serverID: 'srv_1',
      shortname: 'remote',
      baseUrl: 'https://remote.example.com',
      auth,
    },
  ],
});

async function harness(options: {
  credentials?: CredentialStore;
  profiles?: ServerProfiles;
  onCredentialDelete?: () => void | Promise<void>;
  deleteFails?: boolean;
}) {
  const dir = await mkdtemp(join(tmpdir(), 'marg-unpair-'));
  const serversFile = join(dir, 'servers.json');
  const stateDir = join(dir, 'state');
  const memory = options.credentials ?? memoryCredentialStore();
  const deletes: string[] = [];
  const credentials: CredentialStore = {
    ...memory,
    async delete(serverID: string) {
      deletes.push(serverID);
      await options.onCredentialDelete?.();
      if (options.deleteFails === true) throw new Error('keyring unavailable');
      await memory.delete(serverID);
    },
  };
  if (options.profiles?.profiles[0]?.auth !== 'none')
    await credentials.set('srv_1', 'a secret with spaces');
  const pairedBackend = new FakeBackend();
  pairedBackend.serverID = 'srv_1';
  const assembly = await createProductionAssembly({
    config: defaultConfig,
    platform: 'linux',
    cwd: '/work',
    version: '0.0.1',
    paths: { stateFile: join(dir, 'state.json'), serversFile, stateDir },
    env: {},
    credentials,
    connections: [{ serverID: 'local', connection: launchConnection, backend: new FakeBackend() }],
    profiles: options.profiles ?? pairedProfiles(),
    localState: emptyState,
    createBackend: () => pairedBackend,
    requestExit: () => {},
  });
  return { dir, serversFile, stateDir, credentials, deletes, assembly };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('recoverable unpair (#156)', () => {
  test('a failure before the registry mutation preserves profile and credential', async () => {
    const setup = await harness({});
    try {
      // An incompatible on-disk schema makes removeServerProfile reject without changing it.
      await Bun.write(
        setup.serversFile,
        '{"schemaVersion":2,"profiles":[{"serverID":"srv_1","shortname":"remote"}]}',
      );
      let failed = false;
      try {
        await setup.assembly.serverAdmin.unpair('srv_1');
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(await setup.credentials.get('srv_1')).toBe('a secret with spaces');
      expect(setup.deletes).toEqual([]);
    } finally {
      await rm(setup.dir, { recursive: true, force: true });
    }
  });

  test('a credential deletion failure removes the profile and queues durable recovery', async () => {
    const setup = await harness({ deleteFails: true });
    try {
      const outcome = await setup.assembly.serverAdmin.unpair('srv_1');
      expect(outcome).toMatchObject({ credentialCleanup: 'pending' });
      expect((await loadServerProfiles(setup.serversFile)).profiles.profiles).toEqual([]);
      expect(setup.assembly.servers.get('srv_1')).toBeUndefined();

      const queue = await readJson(join(setup.stateDir, 'pending-unpair.json'));
      expect(queue).toMatchObject({ serverIDs: ['srv_1'] });

      // A later startup with a working keyring clears the queued secret.
      const repaired = memoryCredentialStore();
      await repaired.set('srv_1', 'orphan');
      const result = await reconcileCredentialCleanup(setup.stateDir, repaired);
      expect(result).toEqual({ cleared: 1, remaining: [] });
      expect(await repaired.get('srv_1')).toBeUndefined();
      expect(await readJson(join(setup.stateDir, 'pending-unpair.json'))).toEqual({
        serverIDs: [],
      });
    } finally {
      await rm(setup.dir, { recursive: true, force: true });
    }
  });

  test('an anonymous unpair works with an unavailable credential store', async () => {
    const setup = await harness({
      credentials: unavailableCredentialStore('no keyring'),
      profiles: pairedProfiles('none'),
    });
    try {
      await setup.assembly.serverAdmin.unpair('srv_1');
      expect((await loadServerProfiles(setup.serversFile)).profiles.profiles).toEqual([]);
      expect(setup.assembly.servers.get('srv_1')).toBeUndefined();
    } finally {
      await rm(setup.dir, { recursive: true, force: true });
    }
  });

  test('a successful unpair deletes the credential exactly once', async () => {
    const setup = await harness({});
    try {
      await setup.assembly.serverAdmin.unpair('srv_1');
      expect(setup.deletes).toEqual(['srv_1']);
      expect(await setup.credentials.get('srv_1')).toBeUndefined();
      expect((await loadServerProfiles(setup.serversFile)).profiles.profiles).toEqual([]);
      expect(setup.assembly.servers.get('srv_1')).toBeUndefined();
    } finally {
      await unlink(join(setup.stateDir, 'pending-unpair.json')).catch(() => {});
      await rm(setup.dir, { recursive: true, force: true });
    }
  });
});
