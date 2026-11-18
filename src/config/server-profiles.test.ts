import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addProfile,
  emptyServerProfiles,
  findDuplicates,
  loadServerProfiles,
  mergeProfiles,
  normalizeServerUrl,
  parseServerProfiles,
  ProfileError,
  renameProfile,
  saveServerProfiles,
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
      const profiles = { ...emptyServerProfiles, profiles: addProfile([], buildbox) };
      await saveServerProfiles(path, profiles);
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
      await saveServerProfiles(path, {
        ...emptyServerProfiles,
        profiles: addProfile([], buildbox),
      });
      await saveServerProfiles(path, {
        ...emptyServerProfiles,
        profiles: addProfile([], { ...buildbox, serverID: 'srv_2', shortname: 'home' }),
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
      await saveServerProfiles(path, {
        ...emptyServerProfiles,
        profiles: addProfile([], buildbox),
      });
      const text = await readFile(path, 'utf8');
      expect(text).not.toContain('password');
      expect(text).not.toContain('token');
      expect(text).not.toContain('authorization');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('merge prefers our newer profile without dropping theirs', () => {
    const ours = {
      ...emptyServerProfiles,
      profiles: addProfile([], { ...buildbox, shortname: 'office' }),
    };
    const theirs = {
      ...emptyServerProfiles,
      profiles: addProfile([], { ...buildbox, serverID: 'srv_2', shortname: 'home' }),
    };
    const merged = mergeProfiles(ours, theirs);
    expect(merged.profiles.find((profile) => profile.serverID === 'srv_1')?.shortname).toBe(
      'office',
    );
    expect(merged.profiles.find((profile) => profile.serverID === 'srv_2')?.shortname).toBe('home');
  });

  test('parse accepts an empty registry and rejects the wrong schema', () => {
    expect(parseServerProfiles({ schemaVersion: 2, profiles: [] })).toEqual(emptyServerProfiles);
  });
});
