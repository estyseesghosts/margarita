import type { Connection } from '../adapter/connection.ts';
import type { CredentialStore } from '../config/credentials.ts';
import type { ServerProfile } from '../config/server-profiles.ts';

/**
 * Builds the launch connection for `--remote <alias>`. Anonymous (`auth: 'none'`) profiles
 * connect with no Authorization header and no credential-store read at all; authenticated
 * profiles require a stored secret or fail with a specific, actionable message. The
 * failing paths never send a request — no unauthenticated mutation, no half-secret leak.
 */
export type RemoteConnection =
  | Readonly<{ ok: true; connection: Connection }>
  | Readonly<{ ok: false; reason: 'missing-credential' | 'store-error'; message: string }>;

export async function remoteConnectionFor(
  profile: ServerProfile,
  credentials: CredentialStore,
): Promise<RemoteConnection> {
  if (profile.auth === 'none') {
    // Anonymous servers pair with no credential by design; nothing to read or send.
    return { ok: true, connection: { baseUrl: profile.baseUrl, headers: {}, origin: 'remote' } };
  }
  const stored = await credentials.get(profile.serverID).then(
    (secret) => ({ ok: true as const, secret }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!stored.ok) {
    return {
      ok: false,
      reason: 'store-error',
      message: `could not read the credential store for "${profile.shortname}": ${
        stored.error instanceof Error ? stored.error.message : String(stored.error)
      }`,
    };
  }
  if (stored.secret === undefined) {
    const mode = profile.auth === 'basic' ? 'Basic' : 'Bearer';
    return {
      ok: false,
      reason: 'missing-credential',
      message: `no saved credential for "${profile.shortname}" (paired for ${mode} auth). Re-pair it or set MARGARITA_SERVER_PASSWORD.`,
    };
  }
  const headers =
    profile.auth === 'basic'
      ? { authorization: `Basic ${Buffer.from(`opencode:${stored.secret}`).toString('base64')}` }
      : { authorization: `Bearer ${stored.secret}` };
  return { ok: true, connection: { baseUrl: profile.baseUrl, headers, origin: 'remote' } };
}
