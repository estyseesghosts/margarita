import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackendError } from '../src/adapter/backend.ts';
import type { Connection } from '../src/adapter/connection.ts';
import {
  createProductionAssembly,
  type ProductionAssemblyInput,
} from '../src/app/production-assembly.ts';
import { remoteConnectionFor } from '../src/app/remote-connection.ts';
import { defaultConfig } from '../src/config/config.ts';
import { memoryCredentialStore, unavailableCredentialStore } from '../src/config/credentials.ts';
import { emptyState } from '../src/config/local-state.ts';
import { emptyServerProfiles, loadServerProfiles } from '../src/config/server-profiles.ts';
import { composerFrom } from '../src/domain/composer.ts';
import { FakeBackend } from './fake-backend.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const anonSummary = (id: string) => ({
  id,
  serverID: 'srv_anon',
  projectID: 'p',
  directory: '/work/anon',
  createdAt: 0,
  updatedAt: 1,
  archived: false,
});

const basicSummary = (id: string) => ({
  ...anonSummary(id),
  serverID: 'srv_basic',
  directory: '/work/basic',
});

const basicInfo = (_url: string, init: RequestInit) => {
  const auth = new Headers(init.headers).get('authorization') ?? '';
  return Promise.resolve(
    auth === `Basic ${Buffer.from('opencode:s3cret').toString('base64')}`
      ? jsonResponse({ version: '2.3.0', hostname: 'buildbox' })
      : jsonResponse({ message: 'unauthorized' }, 401),
  );
};

const localSummary = {
  id: 'ses_local',
  serverID: 'local',
  projectID: 'p',
  directory: '/work/kohjoh',
  createdAt: 0,
  updatedAt: 1,
  archived: false,
};

/**
 * Fixture with a local launch server and two paired remotes. The basic host enforces auth
 * like a real server: a request without a valid Basic credential is answered with 401.
 */
async function baseFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'margarita-manual-'));
  const serversFile = join(directory, 'servers.json');
  await writeFile(serversFile, JSON.stringify({ schemaVersion: 1, profiles: [] }));
  const credentials = memoryCredentialStore();
  const connections: Connection[] = [];

  const local = new FakeBackend();
  local.serverID = 'local';
  local.sessions = [localSummary];
  const anon = new FakeBackend();
  anon.serverID = 'srv_anon';
  anon.sessions = [anonSummary('ses_anon')];

  const createBackend: NonNullable<ProductionAssemblyInput['createBackend']> = (
    connection,
    options,
  ) => {
    connections.push(connection);
    if (options?.serverID === 'srv_anon') return anon;
    if (options?.serverID === 'srv_basic') {
      const basic = new FakeBackend();
      basic.serverID = 'srv_basic';
      basic.sessions = [basicSummary('ses_basic')];
      const authed = (connection.headers?.['authorization'] ?? '').startsWith('Basic ');
      basic.listSessionsHook = () =>
        authed
          ? Promise.resolve({ sessions: basic.sessions })
          : Promise.reject(
              new BackendError('unauthorized', 'session.list', 'missing or invalid credential'),
            );
      return basic;
    }
    return new FakeBackend();
  };

  const input = (overrides: Partial<ProductionAssemblyInput> = {}): ProductionAssemblyInput => ({
    config: defaultConfig,
    platform: 'linux',
    cwd: '/work/kohjoh',
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
        connection: {
          baseUrl: 'http://launch.test:4096',
          headers: {},
          origin: 'discovered',
        },
        backend: local,
        remoteFilesystem: false,
      },
    ],
    profiles: emptyServerProfiles,
    localState: emptyState,
    createBackend,
    requestExit: () => {},
    ...overrides,
  });
  return { directory, serversFile, credentials, local, anon, connections, input };
}

async function flush(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
}

function headersFor(
  connections: readonly Connection[],
  baseUrlPart: string,
): Record<string, string> | undefined {
  return connections.find((connection) => connection.baseUrl.includes(baseUrlPart))?.headers;
}

describe('anonymous manual pairing (issue #71)', () => {
  test('pairs without a credential, persists auth:none, and reconnects anonymously after restart', async () => {
    const fixture = await baseFixture();
    const infoCalls: { url: string; authorization: string | null }[] = [];
    const anonInfo = (url: string, init: RequestInit) => {
      infoCalls.push({ url, authorization: new Headers(init.headers).get('authorization') });
      return Promise.resolve(jsonResponse({ version: '2.3.0', hostname: 'buildbox' }));
    };
    const first = await createProductionAssembly(
      fixture.input({ env: {}, generateID: () => 'anon', pairingFetch: anonInfo }),
    );
    await first.controller.bootstrap();
    first.controller.setComposer(composerFrom('/pair --url https://anon.test:4096 --as buildbox'));
    await first.controller.submit();
    await flush();

    // Persisted as an anonymous profile; the credential store was never touched.
    const persisted = await loadServerProfiles(fixture.serversFile);
    expect(persisted.profiles.profiles).toMatchObject([
      { serverID: 'srv_anon', shortname: 'buildbox', auth: 'none' },
    ]);
    expect(fixture.credentials.secrets.size).toBe(0);
    // The verification call went out with no Authorization header at all.
    expect(infoCalls).toEqual([{ url: 'https://anon.test:4096/api/info', authorization: null }]);
    first.controller.dispose();
    await first.servers.dispose();

    // Restart: restore from disk alone; no credential exists anywhere.
    fixture.connections.length = 0;
    const second = await createProductionAssembly(
      fixture.input({ profiles: persisted.profiles, generateID: () => 'unused' }),
    );
    await second.controller.bootstrap();
    expect(second.controller.state.sessions['server:srv_anon/session:ses_anon']).toBeDefined();
    expect(second.servers.get('srv_anon')?.state).toBe('online');
    expect(headersFor(fixture.connections, 'anon.test')).toEqual({});
    second.controller.dispose();
    await second.servers.dispose();
  });

  test('a Basic profile paired with a secret re-authenticates after restart', async () => {
    const fixture = await baseFixture();
    const first = await createProductionAssembly(
      fixture.input({
        env: { MARGARITA_SERVER_PASSWORD: 's3cret' },
        generateID: () => 'basic',
        pairingFetch: basicInfo,
      }),
    );
    await first.controller.bootstrap();
    first.controller.setComposer(composerFrom('/pair --url https://basic.test:4096 --as basicbox'));
    await first.controller.submit();
    await flush();
    expect(await fixture.credentials.get('srv_basic')).toBe('s3cret');
    const persisted = await loadServerProfiles(fixture.serversFile);
    expect(persisted.profiles.profiles[0]?.auth).toBe('basic');
    first.controller.dispose();
    await first.servers.dispose();

    fixture.connections.length = 0;
    const second = await createProductionAssembly(
      fixture.input({ profiles: persisted.profiles, generateID: () => 'unused' }),
    );
    await second.controller.bootstrap();
    expect(second.controller.state.sessions['server:srv_basic/session:ses_basic']).toBeDefined();
    expect(second.servers.get('srv_basic')?.state).toBe('online');
    expect(headersFor(fixture.connections, 'basic.test')).toEqual({
      authorization: `Basic ${Buffer.from('opencode:s3cret').toString('base64')}`,
    });
    second.controller.dispose();
    await second.servers.dispose();
  });

  test('an authenticated profile with its secret missing fails closed, sends no auth header', async () => {
    const fixture = await baseFixture();
    const first = await createProductionAssembly(
      fixture.input({
        env: { MARGARITA_SERVER_PASSWORD: 's3cret' },
        generateID: () => 'basic',
        pairingFetch: () =>
          Promise.resolve(jsonResponse({ version: '2.3.0', hostname: 'buildbox' })),
      }),
    );
    await first.controller.bootstrap();
    first.controller.setComposer(composerFrom('/pair --url https://basic.test:4096 --as basicbox'));
    await first.controller.submit();
    await flush();
    const persisted = await loadServerProfiles(fixture.serversFile);
    first.controller.dispose();
    await first.servers.dispose();

    // Simulate the missing secret: the authenticated profile can no longer authenticate.
    await fixture.credentials.delete('srv_basic');
    fixture.connections.length = 0;
    const second = await createProductionAssembly(
      fixture.input({ profiles: persisted.profiles, generateID: () => 'unused' }),
    );
    await second.controller.bootstrap();
    expect(second.servers.get('srv_basic')?.state).toBe('unauthorized');
    expect(second.controller.state.sessions['server:srv_basic/session:ses_basic']).toBeUndefined();
    // No Authorization header is sent anywhere; the launch host is unaffected.
    expect(headersFor(fixture.connections, 'basic.test')).toEqual({});
    expect(second.controller.state.sessions['ses_local']).toBeDefined();
    second.controller.dispose();
    await second.servers.dispose();
  });

  test('wrong credentials are rejected before persisting anything', async () => {
    const fixture = await baseFixture();
    const first = await createProductionAssembly(
      fixture.input({
        env: { MARGARITA_SERVER_PASSWORD: 'wrong' },
        generateID: () => 'basic',
        pairingFetch: () => Promise.resolve(jsonResponse({ message: 'unauthorized' }, 401)),
      }),
    );
    await first.controller.bootstrap();
    first.controller.setComposer(composerFrom('/pair --url https://basic.test:4096 --as basicbox'));
    await first.controller.submit();
    await flush();
    expect(fixture.credentials.secrets.size).toBe(0);
    const persisted = await loadServerProfiles(fixture.serversFile);
    expect(persisted.profiles.profiles).toEqual([]);
    expect(first.servers.get('srv_basic')).toBeUndefined();
    first.controller.dispose();
    await first.servers.dispose();
  });

  test('an anonymous server that demands credentials is not persisted either', async () => {
    const fixture = await baseFixture();
    const first = await createProductionAssembly(
      fixture.input({
        env: {},
        generateID: () => 'anon',
        pairingFetch: () => Promise.resolve(jsonResponse({ message: 'unauthorized' }, 401)),
      }),
    );
    await first.controller.bootstrap();
    first.controller.setComposer(composerFrom('/pair --url https://anon.test:4096 --as buildbox'));
    await first.controller.submit();
    await flush();
    const persisted = await loadServerProfiles(fixture.serversFile);
    expect(persisted.profiles.profiles).toEqual([]);
    expect(fixture.credentials.secrets.size).toBe(0);
    first.controller.dispose();
    await first.servers.dispose();
  });
});

describe('--remote connection for a paired alias (issue #71)', () => {
  const baseProfile = {
    serverID: 'srv_x',
    shortname: 'buildbox',
    baseUrl: 'https://buildbox.test:4096',
  };

  test('auth:none connects anonymously without touching the credential store', async () => {
    const store = {
      kind: 'system' as const,
      description: 'exploding on read',
      get: () => Promise.reject(new Error('must not be called')),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    const result = await remoteConnectionFor({ ...baseProfile, auth: 'none' }, store);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.connection.headers).toEqual({});
  });

  test('basic restores a stored secret; absent secret fails with a clear message', async () => {
    const withSecret = memoryCredentialStore();
    await withSecret.set('srv_x', 's3cret');
    const ok = await remoteConnectionFor({ ...baseProfile, auth: 'basic' }, withSecret);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.connection.headers).toEqual({
        authorization: `Basic ${Buffer.from('opencode:s3cret').toString('base64')}`,
      });
    }
    const missing = await remoteConnectionFor(
      { ...baseProfile, auth: 'basic' },
      memoryCredentialStore(),
    );
    expect(missing).toEqual({
      ok: false,
      reason: 'missing-credential',
      message: expect.stringContaining('no saved credential for "buildbox"'),
    });
    if (!missing.ok) expect(missing.message).toContain('Basic auth');
  });

  test('bearer restores a stored token; a read failure is reported distinctly', async () => {
    const withSecret = memoryCredentialStore();
    await withSecret.set('srv_x', 'tok');
    const ok = await remoteConnectionFor({ ...baseProfile, auth: 'bearer' }, withSecret);
    if (ok.ok) expect(ok.connection.headers).toEqual({ authorization: 'Bearer tok' });
    const exploding = {
      kind: 'system' as const,
      description: 'locked',
      get: () => Promise.reject(new Error('keychain locked')),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    const broken = await remoteConnectionFor({ ...baseProfile, auth: 'bearer' }, exploding);
    expect(broken).toEqual({
      ok: false,
      reason: 'store-error',
      message: expect.stringContaining('keychain locked'),
    });
  });

  test('a legacy profile with no auth field never degrades to anonymous', async () => {
    const result = await remoteConnectionFor({ ...baseProfile }, memoryCredentialStore());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-credential');
  });
});

describe('anonymous profiles never depend on a credential store (issue #81)', () => {
  /** A machine with no usable keyring: every store call fails, like a locked Secret Service. */
  const locked = unavailableCredentialStore('no keyring on this host');

  test('pairing works with no credential store and needs no secret anywhere', async () => {
    const fixture = await baseFixture();
    const assembly = await createProductionAssembly(
      fixture.input({
        env: {},
        credentials: locked,
        generateID: () => 'anon',
        pairingFetch: () =>
          Promise.resolve(jsonResponse({ version: '2.3.0', hostname: 'buildbox' })),
      }),
    );
    await assembly.controller.bootstrap();
    assembly.controller.setComposer(
      composerFrom('/pair --url https://anon.test:4096 --as buildbox'),
    );
    await assembly.controller.submit();
    await flush();

    expect(assembly.controller.state.notice?.tone).not.toBe('error');
    const persisted = await loadServerProfiles(fixture.serversFile);
    expect(persisted.profiles.profiles).toMatchObject([
      { serverID: 'srv_anon', shortname: 'buildbox', auth: 'none' },
    ]);
    assembly.controller.dispose();
    await assembly.servers.dispose();
  });

  test('an anonymous profile can be unpaired on a machine with no credential store', async () => {
    const fixture = await baseFixture();
    const first = await createProductionAssembly(
      fixture.input({
        env: {},
        credentials: locked,
        generateID: () => 'anon',
        pairingFetch: () =>
          Promise.resolve(jsonResponse({ version: '2.3.0', hostname: 'buildbox' })),
      }),
    );
    await first.controller.bootstrap();
    first.controller.setComposer(composerFrom('/pair --url https://anon.test:4096 --as buildbox'));
    await first.controller.submit();
    await flush();
    const paired = await loadServerProfiles(fixture.serversFile);
    first.controller.dispose();
    await first.servers.dispose();

    // Restart on the same keyring-less machine, then forget the anonymous host entirely.
    fixture.connections.length = 0;
    const second = await createProductionAssembly(
      fixture.input({ profiles: paired.profiles, credentials: locked }),
    );
    await second.controller.bootstrap();
    second.controller.setComposer(composerFrom('/unpair buildbox'));
    await second.controller.submit();
    await flush();

    // No store was consulted, so the durable removal succeeded and nothing is left behind.
    expect(second.controller.state.notice?.tone).toBe('dim');
    expect(second.controller.state.notice?.text).toContain('Unpaired buildbox');
    expect((await loadServerProfiles(fixture.serversFile)).profiles.profiles).toEqual([]);
    expect(second.servers.get('srv_anon')).toBeUndefined();
    second.controller.dispose();
    await second.servers.dispose();
  });

  test('an authenticated profile still fails visibly when its store is unusable', async () => {
    const fixture = await baseFixture();
    const first = await createProductionAssembly(
      fixture.input({
        env: { MARGARITA_SERVER_PASSWORD: 's3cret' },
        generateID: () => 'basic',
        pairingFetch: basicInfo,
      }),
    );
    await first.controller.bootstrap();
    first.controller.setComposer(composerFrom('/pair --url https://basic.test:4096 --as basicbox'));
    await first.controller.submit();
    await flush();
    const paired = await loadServerProfiles(fixture.serversFile);
    expect(paired.profiles.profiles[0]?.auth).toBe('basic');
    first.controller.dispose();
    await first.servers.dispose();

    // The secret cannot be removed from a locked store: the profile is still removed (so no
    // unusable host is registered), the error says why, and cleanup is queued for a retry (#156).
    fixture.connections.length = 0;
    const second = await createProductionAssembly(
      fixture.input({ profiles: paired.profiles, credentials: locked }),
    );
    await second.controller.bootstrap();
    second.controller.setComposer(composerFrom('/unpair basicbox'));
    await second.controller.submit();
    await flush();

    expect(second.controller.state.notice?.tone).toBe('error');
    expect(second.controller.state.notice?.text).toContain('credential storage is unavailable');
    expect(second.controller.state.notice?.text).toContain('retried on next launch');
    expect((await loadServerProfiles(fixture.serversFile)).profiles.profiles).toHaveLength(0);
    const pending = JSON.parse(
      await Bun.file(join(fixture.directory, 'pending-unpair.json')).text(),
    );
    expect(pending.serverIDs).toContain('srv_basic');
    second.controller.dispose();
    await second.servers.dispose();
  });
});
