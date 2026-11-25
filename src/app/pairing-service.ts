import { randomUUID } from 'node:crypto';

import { createBackend } from '../adapter/backend.ts';
import { checkServerUrl, type Connection } from '../adapter/connection.ts';
import { type PairingFetch, redeemPairing, serverInfo } from '../adapter/pairing.ts';
import type { ServerConnectionManager } from '../adapter/server-manager.ts';
import type { CredentialStore } from '../config/credentials.ts';
import {
  findDuplicates,
  normalizeServerUrl,
  type ProfileInput,
  type ServerProfiles,
  validateShortname,
} from '../config/server-profiles.ts';
import { PairingError, type PairRequest, suggestShortname } from '../domain/pairing.ts';
import { strings } from '../i18n/index.ts';

export type PairingServiceDeps = Readonly<{
  servers: ServerConnectionManager;
  profiles: () => ServerProfiles;
  /** Persists the new profile under a lock, arbitrated against current disk state. */
  addProfile: (input: ProfileInput) => Promise<ServerProfiles>;
  credentials: CredentialStore;
  fetch?: PairingFetch;
  /** Env-provided password for manual-URL pairing; never read from argv. */
  password?: string;
  allowInsecureHttp?: boolean;
  toolOutputChars?: number;
  /** Injectable for deterministic tests. */
  generateID?: () => string;
  /** Backend factory override for tests; production uses the real SDK backend. */
  createBackend?: typeof createBackend;
}>;

export type PairResult = Readonly<{
  serverID: string;
  shortname: string;
  baseUrl: string;
}>;

function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

function profileFor(input: {
  serverID: string;
  shortname: string;
  baseUrl: string;
  auth: 'none' | 'bearer' | 'basic';
}) {
  return {
    serverID: input.serverID,
    shortname: input.shortname,
    baseUrl: input.baseUrl,
    auth: input.auth,
  };
}

/**
 * Pairs a server from a one-time link or a manual URL, persists its non-secret profile, stores
 * the credential in the OS store, and activates its backend without touching the current
 * session. Every step is fail-closed: a missing credential store, duplicate alias, or failed
 * verification leaves the registry unchanged.
 */
export async function pairServer(
  request: PairRequest,
  deps: PairingServiceDeps,
): Promise<PairResult> {
  const baseUrl = normalizeServerUrl(request.baseUrl);
  const shortname = validateShortname(request.shortname ?? suggestShortname(baseUrl));
  const duplicates = findDuplicates(deps.profiles().profiles, {
    serverID: 'pending',
    shortname,
    baseUrl,
  });
  if (duplicates.length > 0) {
    const existing = duplicates[0]?.shortname ?? 'an existing profile';
    throw new PairingError(
      `That server is already registered as "${existing}". Rename or remove it before pairing again.`,
    );
  }
  // Pairing an anonymous server persists no secret, so it does not need the credential
  // store; authenticated modes fail visibly instead of pairing something unusable.
  const needsCredentialStore = request.code !== '' || deps.password !== undefined;
  if (needsCredentialStore && deps.credentials.kind === 'unavailable') {
    throw new PairingError(
      `Secure credential storage is unavailable (${deps.credentials.description}). Re-pair once it is available, or use --server with MARGARITA_SERVER_PASSWORD.`,
    );
  }

  const serverID = `srv_${(deps.generateID ?? randomUUID)()}`;
  let connection: Connection;
  let credential: string | undefined;
  let auth: 'none' | 'bearer' | 'basic';
  let platform: NodeJS.Platform | undefined;
  if (request.code !== '') {
    auth = 'bearer';
    const redeemed = await redeemPairing(baseUrl, request.code, {
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.allowInsecureHttp === undefined
        ? {}
        : { allowInsecureHttp: deps.allowInsecureHttp }),
    });
    platform = redeemed.platform;
    connection = {
      baseUrl: redeemed.baseUrl,
      headers: { authorization: `Bearer ${redeemed.token}` },
      origin: 'remote',
    };
    credential = redeemed.token;
  } else {
    const policy = checkServerUrl(baseUrl, {
      hasPassword: deps.password !== undefined,
      allowInsecureHttp: deps.allowInsecureHttp === true,
    });
    const normalized = policy.toString().replace(/\/$/, '');
    if (deps.password !== undefined) {
      auth = 'basic';
      // Wrong credentials fail here, before anything is persisted — never at restart.
      const info = await serverInfo(normalized, basicAuthHeader(deps.password), {
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        ...(deps.allowInsecureHttp === undefined
          ? {}
          : { allowInsecureHttp: deps.allowInsecureHttp }),
        unauthorizedText: strings.notices.pairing.credentialsRejected,
      });
      platform = info.platform;
      connection = {
        baseUrl: normalized,
        headers: { authorization: basicAuthHeader(deps.password) },
        origin: 'remote',
      };
      credential = deps.password;
    } else {
      auth = 'none';
      // Anonymous servers: prove a read-only call succeeds without any Authorization
      // header, then pair reconnectably — no credential store involved.
      const info = await serverInfo(normalized, undefined, {
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        ...(deps.allowInsecureHttp === undefined
          ? {}
          : { allowInsecureHttp: deps.allowInsecureHttp }),
        unauthorizedText: strings.notices.pairing.credentialsRequired,
      });
      platform = info.platform;
      connection = { baseUrl: normalized, headers: {}, origin: 'remote' };
      credential = undefined;
    }
  }

  // Persist the secret first: a profile must never advertise a server Margarita cannot reach.
  if (credential !== undefined) await deps.credentials.set(serverID, credential);
  const backend = (deps.createBackend ?? createBackend)(connection, {
    serverID,
    ...(deps.toolOutputChars === undefined ? {} : { toolOutputChars: deps.toolOutputChars }),
  });
  try {
    const saved = await deps.addProfile({
      serverID,
      shortname,
      baseUrl: connection.baseUrl,
      auth,
      ...(platform === undefined ? {} : { platform }),
    });
    const profile =
      saved.profiles.find((entry) => entry.serverID === serverID) ??
      profileFor({
        serverID,
        shortname,
        baseUrl: connection.baseUrl,
        auth,
      });
    deps.servers.add({
      serverID,
      label: profile.shortname,
      connection,
      backend,
      remoteFilesystem: true,
      ...(platform === undefined ? {} : { platform }),
    });
    deps.servers.setState(serverID, 'online');
    return { serverID, shortname: profile.shortname, baseUrl: connection.baseUrl };
  } catch (error) {
    if (credential !== undefined) await deps.credentials.delete(serverID).catch(() => {});
    throw error;
  }
}
