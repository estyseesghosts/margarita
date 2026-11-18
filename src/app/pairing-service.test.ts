import { describe, expect, test } from 'bun:test';

import { ServerConnectionManager } from '../adapter/server-manager.ts';
import { memoryCredentialStore } from '../config/credentials.ts';
import { emptyServerProfiles, type ServerProfiles } from '../config/server-profiles.ts';
import { PairingError } from '../domain/pairing.ts';
import { pairServer } from './pairing-service.ts';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

function harness() {
  const servers = new ServerConnectionManager();
  const credentials = memoryCredentialStore();
  let profiles: ServerProfiles = emptyServerProfiles;
  let calls = 0;
  return {
    servers,
    credentials,
    get profiles() {
      return profiles;
    },
    deps: {
      servers,
      credentials,
      profiles: () => profiles,
      saveProfiles: async (next: ServerProfiles) => {
        profiles = next;
        return next;
      },
      fetch: async (url: string) =>
        url.includes('/auth/connect')
          ? json({ token: `tok_${(calls += 1)}` })
          : json({ version: '2.3.0' }),
    },
  };
}

describe('pairServer', () => {
  test('pairs a link, persists the profile, stores the token, and activates the backend', async () => {
    const harnessed = harness();
    const result = await pairServer(
      { baseUrl: 'https://build.example.com', code: 'abc', shortname: 'buildbox' },
      harnessed.deps,
    );
    expect(result.shortname).toBe('buildbox');
    expect(harnessed.profiles.profiles).toHaveLength(1);
    expect(harnessed.profiles.profiles[0]?.baseUrl).toBe('https://build.example.com');
    expect(await harnessed.credentials.get(result.serverID)).toBe('tok_1');
    expect(harnessed.servers.get(result.serverID)?.state).toBe('online');
  });

  test('two different links can be paired in one process', async () => {
    const harnessed = harness();
    await pairServer(
      { baseUrl: 'https://one.example', code: 'a', shortname: 'one' },
      harnessed.deps,
    );
    await pairServer(
      { baseUrl: 'https://two.example', code: 'b', shortname: 'two' },
      harnessed.deps,
    );
    expect(harnessed.profiles.profiles.map((profile) => profile.shortname)).toEqual(['one', 'two']);
    expect(harnessed.servers.list()).toHaveLength(2);
  });

  test('duplicate address or alias is rejected without touching the registry', async () => {
    const harnessed = harness();
    await pairServer(
      { baseUrl: 'https://one.example', code: 'a', shortname: 'one' },
      harnessed.deps,
    );
    expect(
      pairServer({ baseUrl: 'https://one.example', code: 'b', shortname: 'other' }, harnessed.deps),
    ).rejects.toBeInstanceOf(PairingError);
    expect(harnessed.profiles.profiles).toHaveLength(1);
  });

  test('an unavailable credential store refuses to pair', () => {
    const harnessed = harness();
    return expect(
      pairServer(
        { baseUrl: 'https://one.example', code: 'a', shortname: 'one' },
        {
          ...harnessed.deps,
          credentials: {
            kind: 'unavailable',
            description: 'no keyring',
            get: async () => undefined,
            set: async () => {},
            delete: async () => {},
          },
        },
      ),
    ).rejects.toThrow('Secure credential storage is unavailable');
  });
});
