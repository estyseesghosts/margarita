import { isRecord } from '../domain/backend-event.ts';
import { PairingError, redactPairingCode } from '../domain/pairing.ts';

export type PairingFetch = (url: string, init: RequestInit) => Promise<Response>;

export type RedeemedPairing = Readonly<{
  baseUrl: string;
  token: string;
  version: string;
  hostname?: string;
  platform?: NodeJS.Platform;
}>;

export type RedeemOptions = Readonly<{
  fetch?: PairingFetch;
  /** Explicit opt-in to send a token over plain HTTP to a non-loopback host. */
  allowInsecureHttp?: boolean;
}>;

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function assertSecureTransport(url: URL, allowInsecureHttp: boolean): void {
  if (url.protocol === 'http:' && !isLoopback(url.hostname) && !allowInsecureHttp) {
    throw new PairingError(
      `Refusing to send pairing credentials over plain HTTP to ${url.host}. Use https://, a tunnel to localhost, or set MARGARITA_ALLOW_INSECURE_HTTP=1 to override.`,
    );
  }
}

/** Rejects anything but a single-hop JSON response: redirects are never followed. */
async function jsonResponse(response: Response, operation: string): Promise<unknown> {
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new PairingError(`${operation} was redirected; refusing to follow it.`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new PairingError(`${operation} did not return JSON.`);
  }
  if (!response.ok) {
    const kind =
      response.status === 401 || response.status === 403
        ? 'The pairing code is expired, already used, or unauthorized.'
        : response.status === 404 || response.status === 410
          ? 'The pairing code is no longer valid.'
          : `The server refused the request (HTTP ${response.status}).`;
    throw new PairingError(kind);
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new PairingError(`${operation} returned invalid JSON.`, { cause });
  }
}

/**
 * Derives the server's path style from authenticated `/api/info` metadata. Temporary-directory
 * shape is the only OS signal the service exposes: drive-letter/UNC means Windows, anything
 * else is POSIX (compared case-sensitively). Returns undefined when the server does not
 * advertise a string `paths.tmp`; callers fall back to case-preserving POSIX semantics.
 */
function platformFromInfo(raw: Record<string, unknown>): NodeJS.Platform | undefined {
  const paths = raw['paths'];
  if (!isRecord(paths)) return undefined;
  const tmp = paths['tmp'];
  if (typeof tmp !== 'string' || tmp.trim() === '') return undefined;
  if (/^[A-Za-z]:[\\/]/u.test(tmp) || tmp.startsWith('\\\\')) return 'win32';
  return 'linux'; // POSIX separators; case-sensitive comparison holds for every POSIX flavor.
}

export async function serverInfo(
  baseUrl: string,
  authorization: string,
  options: RedeemOptions = {},
): Promise<{ version: string; hostname?: string; platform?: NodeJS.Platform }> {
  const fetchImpl = options.fetch ?? fetch;
  const url = new URL('/api/info', baseUrl);
  assertSecureTransport(url, options.allowInsecureHttp === true);
  const response = await fetchImpl(url.toString(), {
    headers: { accept: 'application/json', authorization },
    redirect: 'error',
  });
  const raw = await jsonResponse(response, 'server.info');
  if (!isRecord(raw) || typeof raw['version'] !== 'string') {
    throw new PairingError('The server did not report its version.');
  }
  if (!raw['version'].startsWith('2.')) {
    throw new PairingError(
      `This server runs OpenCode ${raw['version']}; Margarita needs a compatible v2 service.`,
    );
  }
  const platform = platformFromInfo(raw);
  return {
    version: raw['version'],
    ...(typeof raw['hostname'] === 'string' ? { hostname: raw['hostname'] } : {}),
    ...(platform === undefined ? {} : { platform }),
  };
}

/**
 * Redeems a one-time pairing link. `GET /auth/connect/<code>` with `Accept: application/json`
 * returns a session token (unlike the browser cookie/redirect flow). The token is verified by
 * reading `server.info` before the caller persists anything.
 */
export async function redeemPairing(
  baseUrl: string,
  code: string,
  options: RedeemOptions = {},
): Promise<RedeemedPairing> {
  const fetchImpl = options.fetch ?? fetch;
  const url = new URL(`/auth/connect/${encodeURIComponent(code)}`, baseUrl);
  assertSecureTransport(url, options.allowInsecureHttp === true);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
  } catch (cause) {
    throw new PairingError('Could not reach the pairing server.', { cause });
  }
  const raw = await jsonResponse(response, 'server.connect');
  if (!isRecord(raw) || typeof raw['token'] !== 'string' || raw['token'] === '') {
    throw new PairingError('The server did not return a pairing token.');
  }
  const info = await serverInfo(baseUrl, `Bearer ${raw['token']}`, options);
  return { baseUrl, token: raw['token'], ...info };
}

/** Safe text for notices: never echoes the code or the token. */
export function pairingFailureText(error: unknown, code?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactPairingCode(raw, code);
}
