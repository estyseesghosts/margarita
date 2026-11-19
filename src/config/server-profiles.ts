import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isRecord } from '../domain/backend-event.ts';
import { localServerID } from '../domain/server-identity.ts';

/** A paired server. Identity is `serverID`; `shortname` is a user-editable alias. */
export type ServerProfile = Readonly<{
  serverID: string;
  shortname: string;
  /** Normalized API base URL: http(s), no credentials, query, hash, or trailing slash. */
  baseUrl: string;
  /** Additional addresses/aliases that refer to the same server. */
  aliases?: readonly string[];
  /** How the stored credential is sent; a scheme, never the secret itself. */
  auth?: 'bearer' | 'basic';
  /** Free-form non-secret metadata advertised by the server. */
  metadata?: Readonly<Record<string, string>>;
  /**
   * The server's own path style, derived from its authenticated API metadata. Absent for
   * legacy profiles: readers fall back to case-preserving POSIX semantics (never the
   * frontend OS), so two distinct directories can not be silently merged.
   */
  platform?: NodeJS.Platform;
}>;

export type ServerProfiles = Readonly<{
  schemaVersion: 1;
  profiles: readonly ServerProfile[];
}>;

export const emptyServerProfiles: ServerProfiles = { schemaVersion: 1, profiles: [] };

export class ProfileError extends Error {
  override readonly name = 'ProfileError';
}

export type ProfileInput = Readonly<{
  serverID: string;
  shortname: string;
  baseUrl: string;
  aliases?: readonly string[];
  auth?: 'bearer' | 'basic';
  metadata?: Readonly<Record<string, string>>;
  platform?: NodeJS.Platform;
}>;

const shortnamePattern = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Platforms the pairing flow can derive from authenticated server metadata. */
export const derivingPlatforms = ['win32', 'darwin', 'linux'] as const;
export type RecordedPlatform = (typeof derivingPlatforms)[number];

/** Validates a persisted platform; anything else is dropped (never trusted as-is). */
export function normalizePlatform(value: unknown): NodeJS.Platform | undefined {
  if (typeof value !== 'string') return undefined;
  return derivingPlatforms.find((platform) => platform === value);
}

/** Shortnames are lowercase, URL-safe, and unique case-insensitively. */
export function validateShortname(shortname: string): string {
  if (!shortnamePattern.test(shortname)) {
    throw new ProfileError(
      'A shortname must be 1-32 lowercase letters, digits, or single dashes, and cannot start or end with a dash.',
    );
  }
  return shortname;
}

/**
 * Normalizes a server URL. Embedded credentials, non-http(s) schemes, and fragments are
 * rejected; the path is kept (a server may live under a base path).
 */
export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new ProfileError('Invalid server URL.', { cause });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProfileError(`Unsupported URL protocol "${url.protocol}"; use http or https.`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ProfileError('Do not put credentials in a server URL.');
  }
  if (url.hash !== '') throw new ProfileError('A server URL cannot contain a fragment.');
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function normalizeProfile(input: ProfileInput): ServerProfile {
  if (input.serverID.trim() === '') throw new ProfileError('A server needs an identity.');
  if (input.serverID === localServerID) {
    throw new ProfileError('The local server is reserved and cannot be paired as a remote.');
  }
  const aliases = (input.aliases ?? []).map((alias) => normalizeServerUrl(alias));
  const metadata =
    input.metadata === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(input.metadata).filter(([, value]) => typeof value === 'string'),
        );
  const platform = normalizePlatform(input.platform);
  return {
    serverID: input.serverID,
    shortname: validateShortname(input.shortname),
    baseUrl: normalizeServerUrl(input.baseUrl),
    ...(aliases.length === 0 ? {} : { aliases }),
    ...(input.auth === undefined ? {} : { auth: input.auth }),
    ...(metadata === undefined || Object.keys(metadata).length === 0 ? {} : { metadata }),
    ...(platform === undefined ? {} : { platform }),
  };
}

/** Throws when another profile already owns the shortname or server identity. */
export function assertUnique(profiles: readonly ServerProfile[], candidate: ServerProfile): void {
  const name = candidate.shortname.toLowerCase();
  for (const profile of profiles) {
    if (profile.serverID === candidate.serverID) continue;
    if (profile.shortname.toLowerCase() === name) {
      throw new ProfileError(`The shortname "${candidate.shortname}" is already in use.`);
    }
    if (profile.baseUrl === candidate.baseUrl) {
      throw new ProfileError('That server address is already registered.');
    }
  }
}

/** Likely duplicates by normalized address or overlapping aliases; the user confirms the merge. */
export function findDuplicates(
  profiles: readonly ServerProfile[],
  candidate: ProfileInput,
): ServerProfile[] {
  const addresses = new Set(
    [candidate.baseUrl, ...(candidate.aliases ?? [])].map((url) => {
      try {
        return normalizeServerUrl(url);
      } catch {
        return url;
      }
    }),
  );
  return profiles.filter(
    (profile) =>
      profile.serverID !== candidate.serverID &&
      [profile.baseUrl, ...(profile.aliases ?? [])].some((url) => addresses.has(url)),
  );
}

/** Renames without touching identity, so cached sessions and goals stay attached. */
export function renameProfile(
  profiles: readonly ServerProfile[],
  serverID: string,
  shortname: string,
): ServerProfile[] {
  validateShortname(shortname);
  const next = profiles.map((profile) =>
    profile.serverID === serverID ? { ...profile, shortname } : profile,
  );
  const renamed = next.find((profile) => profile.serverID === serverID);
  if (renamed === undefined) throw new ProfileError(`No server profile ${serverID}.`);
  assertUnique(
    next.filter((profile) => profile.serverID !== serverID),
    renamed,
  );
  return next;
}

export function addProfile(
  profiles: readonly ServerProfile[],
  input: ProfileInput,
): ServerProfile[] {
  const profile = normalizeProfile(input);
  assertUnique(profiles, profile);
  return [...profiles, profile];
}

export function removeProfile(
  profiles: readonly ServerProfile[],
  serverID: string,
): ServerProfile[] {
  return profiles.filter((profile) => profile.serverID !== serverID);
}

export function parseServerProfiles(raw: unknown): ServerProfiles {
  if (!isRecord(raw) || raw['schemaVersion'] !== 1 || !Array.isArray(raw['profiles'])) {
    return emptyServerProfiles;
  }
  const profiles: ServerProfile[] = [];
  for (const entry of raw['profiles']) {
    if (!isRecord(entry)) continue;
    const serverID = entry['serverID'];
    const shortname = entry['shortname'];
    const baseUrl = entry['baseUrl'];
    if (
      typeof serverID !== 'string' ||
      typeof shortname !== 'string' ||
      typeof baseUrl !== 'string'
    )
      continue;
    try {
      const parsedPlatform = normalizePlatform(entry['platform']);
      const profile = normalizeProfile({
        serverID,
        shortname,
        baseUrl,
        ...(entry['auth'] === 'basic' || entry['auth'] === 'bearer' ? { auth: entry['auth'] } : {}),
        ...(Array.isArray(entry['aliases'])
          ? {
              aliases: entry['aliases'].filter(
                (alias): alias is string => typeof alias === 'string',
              ),
            }
          : {}),
        ...(isRecord(entry['metadata'])
          ? {
              metadata: Object.fromEntries(
                Object.entries(entry['metadata']).filter(
                  (pair): pair is [string, string] => typeof pair[1] === 'string',
                ),
              ),
            }
          : {}),
        ...(parsedPlatform === undefined ? {} : { platform: parsedPlatform }),
      });
      // Skip records that collide with one already parsed: never drop the older one.
      if (profiles.some((other) => other.serverID === profile.serverID)) continue;
      if (profiles.some((other) => other.shortname === profile.shortname)) continue;
      profiles.push(profile);
    } catch {
      // Malformed individual records are ignored; the rest of the registry survives.
    }
  }
  return { schemaVersion: 1, profiles };
}

const lockStaleMs = 10_000;
const lockRetryMs = 25;
const lockTimeoutMs = 5_000;

export async function loadServerProfiles(
  path: string,
): Promise<{ profiles: ServerProfiles; warning?: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (isRecord(cause) && cause['code'] === 'ENOENT') return { profiles: emptyServerProfiles };
    return {
      profiles: emptyServerProfiles,
      warning: `Could not read paired servers: ${String(cause)}`,
    };
  }
  try {
    return { profiles: parseServerProfiles(JSON.parse(text)) };
  } catch (cause) {
    return {
      profiles: emptyServerProfiles,
      warning: `Paired servers were unreadable and were reset: ${String(cause)}`,
    };
  }
}

/**
 * Atomic locked read-modify-write. The operation sees the current disk state, so removal is
 * durable: a profile deleted from one process cannot be resurrected by another process's
 * stale snapshot, while unrelated profiles added elsewhere are always retained.
 */
export async function updateServerProfiles(
  path: string,
  operation: (disk: ServerProfiles) => ServerProfiles,
): Promise<ServerProfiles> {
  await mkdir(dirname(path), { recursive: true });
  const release = await acquireLock(`${path}.lock`);
  try {
    const disk = (await loadServerProfiles(path)).profiles;
    const next = operation(disk);
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temp, path);
    return next;
  } finally {
    await release();
  }
}

/** Adds a profile against current disk state; rejects duplicates instead of merging them. */
export async function addServerProfile(path: string, input: ProfileInput): Promise<ServerProfiles> {
  return updateServerProfiles(path, (disk) => ({
    schemaVersion: 1,
    profiles: addProfile(disk.profiles, input),
  }));
}

/** Renames a profile under lock; the disk registry, not a stale snapshot, decides what exists. */
export async function renameServerProfile(
  path: string,
  serverID: string,
  shortname: string,
): Promise<ServerProfiles> {
  return updateServerProfiles(path, (disk) => ({
    schemaVersion: 1,
    profiles: renameProfile(disk.profiles, serverID, shortname),
  }));
}

/** Removes a profile durably under lock; absence of the record survives restarts. */
export async function removeServerProfile(path: string, serverID: string): Promise<ServerProfiles> {
  return updateServerProfiles(path, (disk) => ({
    schemaVersion: 1,
    profiles: removeProfile(disk.profiles, serverID),
  }));
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + lockTimeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      return async () => {
        await handle.close();
        await rm(lockPath, { force: true });
      };
    } catch (cause) {
      if (!isRecord(cause) || cause['code'] !== 'EEXIST') throw cause;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > lockStaleMs) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new ProfileError('Timed out waiting for the profile lock.');
      await Bun.sleep(lockRetryMs);
    }
  }
}
