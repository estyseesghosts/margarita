import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IncompatibleSchemaError } from './schema-guard.ts';
import {
  addProfile,
  addServerProfile,
  emptyServerProfiles,
  findDuplicates,
  loadServerProfiles,
  normalizeServerUrl,
  parseServerProfiles,
  ProfileError,
  removeServerProfile,
  renameProfile,
  renameServerProfile,
  validateShortname,
} from './server-profiles.ts';

const buildbox = {
  serverID: 'srv_1',
  shortname: 'buildbox',
  baseUrl: 'https://build.example.com/opencode',
};

describe('server profiles', () => {
  test('register, save, and reload a profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-servers-'));
    try {
      const path = join(dir, 'servers.json');
      await addServerProfile(path, buildbox);
      const loaded = await loadServerProfiles(path);
      expect(loaded.profiles.profiles).toEqual([
        {
          serverID: 'srv_1',
          shortname: 'buildbox',
          baseUrl: 'https://build.example.com/opencode',
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('two processes adding profiles do not lose each other updates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-servers-'));
    try {
      const path = join(dir, 'servers.json');
      await addServerProfile(path, buildbox);
      await addServerProfile(path, {
        ...buildbox,
        serverID: 'srv_2',
        shortname: 'home',
        baseUrl: 'https://home.example.com/opencode',
      });
      const loaded = await loadServerProfiles(path);
      expect(loaded.profiles.profiles.map((profile) => profile.shortname).toSorted()).toEqual([
        'buildbox',
        'home',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rename keeps the server identity', () => {
    const renamed = renameProfile(addProfile([], buildbox), 'srv_1', 'office');
    expect(renamed[0]?.serverID).toBe('srv_1');
    expect(renamed[0]?.shortname).toBe('office');
  });

  test('rejects duplicate shortnames and addresses', () => {
    const profiles = addProfile([], buildbox);
    expect(() => addProfile(profiles, { ...buildbox, serverID: 'srv_2' })).toThrow(ProfileError);
    expect(() =>
      addProfile(profiles, { ...buildbox, serverID: 'srv_2', shortname: 'other' }),
    ).toThrow('already registered');
  });

  test('validates shortnames and URLs', () => {
    expect(validateShortname('buildbox')).toBe('buildbox');
    expect(() => validateShortname('Build Box')).toThrow(ProfileError);
    expect(() => validateShortname('-x')).toThrow(ProfileError);
    expect(normalizeServerUrl('https://example.com/base/')).toBe('https://example.com/base');
    expect(() => normalizeServerUrl('ftp://example.com')).toThrow(ProfileError);
    expect(() => normalizeServerUrl('https://user:pass@example.com')).toThrow(
      'Do not put credentials',
    );
    expect(() => normalizeServerUrl('https://example.com/#x')).toThrow('fragment');
    expect(() => addProfile([], { ...buildbox, serverID: 'local' })).toThrow('reserved');
  });

  test('detects likely duplicates by address or alias', () => {
    const profiles = addProfile([], buildbox);
    expect(
      findDuplicates(profiles, { ...buildbox, serverID: 'srv_9', shortname: 'x' }),
    ).toHaveLength(1);
    expect(
      findDuplicates(profiles, {
        serverID: 'srv_9',
        shortname: 'x',
        baseUrl: 'https://other.example.com',
        aliases: ['https://build.example.com/opencode/'],
      }),
    ).toHaveLength(1);
  });

  test('malformed records are skipped without losing the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-servers-'));
    try {
      const path = join(dir, 'servers.json');
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: 1,
          profiles: [buildbox, { serverID: 'srv_2' }, { ...buildbox, serverID: 'srv_3' }],
        }),
      );
      const loaded = await loadServerProfiles(path);
      expect(loaded.profiles.profiles).toHaveLength(1);
      expect(loaded.profiles.profiles[0]?.serverID).toBe('srv_1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the public registry never contains a password or token field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-servers-'));
    try {
      const path = join(dir, 'servers.json');
      await addServerProfile(path, buildbox);
      const text = await readFile(path, 'utf8');
      expect(text).not.toContain('password');
      expect(text).not.toContain('token');
      expect(text).not.toContain('authorization');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a removed profile is durable against a stale snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-servers-'));
    try {
      const path = join(dir, 'servers.json');
      await addServerProfile(path, buildbox);
      await addServerProfile(path, {
        ...buildbox,
        serverID: 'srv_2',
        shortname: 'home',
        baseUrl: 'https://home.example.com/opencode',
      });
      // A stale in-memory snapshot still mentioning B cannot restore B: operations read disk.
      const removed = await removeServerProfile(path, 'srv_1');
      expect(removed.profiles.map((profile) => profile.serverID)).toEqual(['srv_2']);
      // Operations started after the removal also never see B again.
      const after = await addServerProfile(path, {
        ...buildbox,
        serverID: 'srv_3',
        shortname: 'x',
        baseUrl: 'https://x.example.com/opencode',
      });
      expect(after.profiles.map((profile) => profile.serverID)).toEqual(['srv_2', 'srv_3']);
      const loaded = await loadServerProfiles(path);
      expect(loaded.profiles.profiles.map((profile) => profile.serverID)).toEqual([
        'srv_2',
        'srv_3',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('concurrent add(A)/remove(B) and rename(A)/remove(B) keep unrelated profiles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-servers-'));
    try {
      const path = join(dir, 'servers.json');
      await addServerProfile(path, buildbox);
      await addServerProfile(path, {
        ...buildbox,
        serverID: 'srv_2',
        shortname: 'home',
        baseUrl: 'https://home.example.com/opencode',
      });
      const [added, removed] = await Promise.all([
        addServerProfile(path, {
          ...buildbox,
          serverID: 'srv_3',
          shortname: 'x',
          baseUrl: 'https://x.example.com/opencode',
        }),
        removeServerProfile(path, 'srv_1'),
      ]);
      expect(added.profiles.map((profile) => profile.serverID)).toContain('srv_3');
      expect(removed.profiles.map((profile) => profile.serverID)).not.toContain('srv_1');
      const loaded = await loadServerProfiles(path);
      expect(loaded.profiles.profiles.map((profile) => profile.serverID).toSorted()).toEqual([
        'srv_2',
        'srv_3',
      ]);
      await renameServerProfile(path, 'srv_3', 'thunder');
      await removeServerProfile(path, 'srv_2');
      const final = await loadServerProfiles(path);
      expect(final.profiles.profiles.map((profile) => profile.shortname)).toEqual(['thunder']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('parse accepts an empty registry and rejects the wrong schema', () => {
    expect(parseServerProfiles({ schemaVersion: 1, profiles: [] })).toEqual(emptyServerProfiles);
    expect(() => parseServerProfiles({ schemaVersion: 2, profiles: [] })).toThrow(
      IncompatibleSchemaError,
    );
  });

  test('a newer registry schema is reported and never downgraded by mutations (#150)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-profiles-schema-'));
    const path = join(dir, 'servers.json');
    const raw = '{"schemaVersion":2,"profiles":[{"serverID":"srv_new","shortname":"new"}]}';
    try {
      await writeFile(path, raw);
      const loaded = await loadServerProfiles(path);
      expect(loaded.incompatible?.version).toBe(2);
      expect(loaded.warning).toContain('schema version 2');

      for (const mutate of [
        () => addServerProfile(path, buildbox),
        () => renameServerProfile(path, 'srv_new', 'renamed'),
        () => removeServerProfile(path, 'srv_new'),
      ]) {
        let failed: unknown;
        try {
          await mutate();
        } catch (cause) {
          failed = cause;
        }
        expect(failed).toBeInstanceOf(IncompatibleSchemaError);
        expect(await readFile(path, 'utf8')).toBe(raw);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
