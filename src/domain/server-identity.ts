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

/** Session identity of a server summary. */
export function sessionRefOf(session: { serverID: string; id: string }): SessionRef {
  return { serverID: session.serverID, sessionID: session.id };
}

export function sameSession(left: SessionRef, right: SessionRef): boolean {
  return sessionKey(left) === sessionKey(right);
}
