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
  auth: 'bearer' | 'basic';
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
  if (deps.credentials.kind === 'unavailable') {
    throw new PairingError(
      `Secure credential storage is unavailable (${deps.credentials.description}). Re-pair once it is available, or use --server with MARGARITA_SERVER_PASSWORD.`,
    );
  }

  const serverID = `srv_${(deps.generateID ?? randomUUID)()}`;
  let connection: Connection;
  let credential: string;
  let auth: 'bearer' | 'basic';
  if (request.code !== '') {
    auth = 'bearer';
    const redeemed = await redeemPairing(baseUrl, request.code, {
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.allowInsecureHttp === undefined
        ? {}
        : { allowInsecureHttp: deps.allowInsecureHttp }),
    });
    connection = {
      baseUrl: redeemed.baseUrl,
      headers: { authorization: `Bearer ${redeemed.token}` },
      origin: 'remote',
    };
    credential = redeemed.token;
  } else {
    auth = 'basic';
    const policy = checkServerUrl(baseUrl, {
      hasPassword: deps.password !== undefined,
      allowInsecureHttp: deps.allowInsecureHttp === true,
    });
    const normalized = policy.toString().replace(/\/$/, '');
    const headers =
      deps.password === undefined ? {} : { authorization: basicAuthHeader(deps.password) };
    await serverInfo(normalized, headers.authorization ?? '', {
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.allowInsecureHttp === undefined
        ? {}
        : { allowInsecureHttp: deps.allowInsecureHttp }),
    });
    connection = { baseUrl: normalized, headers, origin: 'remote' };
    credential = deps.password ?? '';
  }

  // Persist the secret first: a profile must never advertise a server Margarita cannot reach.
  if (credential !== '') await deps.credentials.set(serverID, credential);
  const backend = createBackend(connection, {
    serverID,
    ...(deps.toolOutputChars === undefined ? {} : { toolOutputChars: deps.toolOutputChars }),
  });
  try {
    const saved = await deps.addProfile({
      serverID,
      shortname,
      baseUrl: connection.baseUrl,
      auth,
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
    });
    deps.servers.setState(serverID, 'online');
    return { serverID, shortname: profile.shortname, baseUrl: connection.baseUrl };
  } catch (error) {
    await deps.credentials.delete(serverID).catch(() => {});
    throw error;
  }
}
