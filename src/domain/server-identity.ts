import { directoryKey } from './path-identity.ts';

/**
 * Stable, Margarita-managed identity for a backend. OpenCode's `ServerInfo` has no immutable
 * machine identifier, so identities are assigned (and persisted) by Margarita itself. The
 * local server keeps the reserved ID below; remote servers get their own generated IDs.
 *
 * Display labels/shortnames are never part of an identity: renaming a server must not orphan
 * sessions or local state.
 */
export const localServerID = 'local';

export type ServerRef = Readonly<{ serverID: string }>;

export type SessionRef = Readonly<{ serverID: string; sessionID: string }>;

export type ProjectRef = Readonly<{ serverID: string; directory: string }>;

const prefix = 'server:';
const sessionMarker = '/session:';
const projectMarker = '/project:';
const remotePattern = /^server:([^/]+)\/(?:session|project):(.+)$/;

function segment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Canonical key for local state maps. The reserved local server serializes to the bare native
 * ID for backward compatibility with state written before servers were identified; every other
 * server is qualified. Parsing always yields a fully server-scoped `SessionRef`.
 */
export function sessionKey(ref: SessionRef): string {
  if (ref.serverID === localServerID) return ref.sessionID;
  return `${prefix}${segment(ref.serverID)}${sessionMarker}${segment(ref.sessionID)}`;
}

export function parseSessionKey(key: string): SessionRef {
  const match = remotePattern.exec(key);
  if (match === null) return { serverID: localServerID, sessionID: key };
  return {
    serverID: decodeURIComponent(match[1] ?? ''),
    sessionID: decodeURIComponent(match[2] ?? ''),
  };
}

/**
 * Canonical equality key for a project (server plus directory). Directories are compared with
 * `directoryKey`; the local server again keeps its legacy bare key.
 */
export function projectKey(ref: ProjectRef, platform: NodeJS.Platform): string {
  const directory = directoryKey(ref.directory, platform);
  if (ref.serverID === localServerID) return directory;
  return `${prefix}${segment(ref.serverID)}${projectMarker}${segment(directory)}`;
}

export function parseProjectKey(
  key: string,
  platform: NodeJS.Platform,
): ProjectRef & { directoryKey: string } {
  const match = remotePattern.exec(key);
  if (match === null) {
    return { serverID: localServerID, directory: key, directoryKey: directoryKey(key, platform) };
  }
  const directory = decodeURIComponent(match[2] ?? '');
  return { serverID: decodeURIComponent(match[1] ?? ''), directory, directoryKey: directory };
}

/**
 * Project keys previous versions of Margarita could have persisted for the same project.
 * `linux` was derived with POSIX rules case-sensitively, `win32` folded case and separators.
 * The current key is always one of these two forms (or its own platform's), so callers can
 * compare and skip it. A win32-folded candidate loses case information: two distinct POSIX
 * directories on the same server fold onto one legacy key, and callers must not attribute
 * it without a uniqueness check.
 */
export function legacyProjectKeys(
  ref: ProjectRef,
  platform: NodeJS.Platform,
): readonly { key: string; platform: NodeJS.Platform }[] {
  const candidates: { key: string; platform: NodeJS.Platform }[] = [];
  const current = projectKey(ref, platform);
  for (const legacy of ['linux', 'win32'] as const) {
    if (legacy === platform) continue;
    const key = projectKey(ref, legacy);
    if (key === current) continue;
    candidates.push({ key, platform: legacy });
  }
  return candidates;
}

/** Session identity of a server summary. */
export function sessionRefOf(session: { serverID: string; id: string }): SessionRef {
  return { serverID: session.serverID, sessionID: session.id };
}

export function sameSession(left: SessionRef, right: SessionRef): boolean {
  return sessionKey(left) === sessionKey(right);
}
