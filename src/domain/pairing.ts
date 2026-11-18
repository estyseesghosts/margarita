/**
 * Parsing and validation for `/pair`. Pairing codes are one-time secrets: they must never
 * reach prompt history, drafts, debug logs, notices, or argv echo. Everything here works on
 * the raw input only long enough to validate it and produces a redacted form for messages.
 */

export type PairRequest = Readonly<{
  /** Server origin plus base path, without the `/auth/connect/<code>` suffix. */
  baseUrl: string;
  /** One-time code; never log or persist. */
  code: string;
  /** User-chosen shortname; absent means suggest one from the host. */
  shortname?: string;
}>;

export type PairRequestError = Readonly<{ message: string }>;

export class PairingError extends Error {
  override readonly name = 'PairingError';
}

const connectPath = '/auth/connect/';

/**
 * Parses a pairing URL. Only http(s) is accepted; embedded credentials, query strings,
 * fragments, foreign protocols, and unexpected paths are rejected. A server may live under
 * a base path, as long as the final segments are `/auth/connect/<code>`.
 */
export function parsePairingUrl(raw: string): { baseUrl: string; code: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new PairingError('That is not a valid pairing URL.', { cause });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PairingError('Pairing URLs must use http or https.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new PairingError('Pairing URLs cannot contain embedded credentials.');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new PairingError('A pairing URL cannot contain a query string or fragment.');
  }
  const path = url.pathname;
  const at = path.lastIndexOf(connectPath);
  if (at === -1) {
    throw new PairingError('A pairing URL must end with /auth/connect/<code>.');
  }
  const code = path.slice(at + connectPath.length).replace(/\/+$/, '');
  if (code === '' || code.includes('/')) {
    throw new PairingError('The pairing URL is missing its one-time code.');
  }
  const basePath = path.slice(0, at);
  url.pathname = basePath === '' ? '/' : basePath;
  url.search = '';
  url.hash = '';
  const baseUrl = url.toString().replace(/\/$/, '');
  return { baseUrl, code: decodeURIComponent(code) };
}

/** Extracts `[url] [--as name]` or `--url <url> [--as name]` without touching secrets. */
export function parsePairArgs(args: string): PairRequest {
  const tokens = args.split(/\s+/).filter((token) => token !== '');
  let url: string | undefined;
  let shortname: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '--as' || token === '-a') {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new PairingError('Usage: /pair <url> [--as <shortname>]');
      }
      shortname = value;
      index += 1;
      continue;
    }
    if (token === '--url' || token === '-u') {
      const value = tokens[index + 1];
      if (value === undefined) throw new PairingError('Usage: /pair --url <url> [--as <name>]');
      if (url !== undefined) throw new PairingError('Only one pairing URL can be given.');
      url = value;
      index += 1;
      continue;
    }
    if (token.startsWith('-')) throw new PairingError(`Unknown /pair option: ${token}`);
    if (url !== undefined) throw new PairingError('Only one pairing URL can be given.');
    url = token;
  }
  if (url === undefined) {
    throw new PairingError(
      'Usage: /pair <https://host/auth/connect/code> [--as <shortname>], or /pair --url <https://host> --as <shortname>',
    );
  }
  const parsed = isPairingUrl(url) ? parsePairingUrl(url) : parseManualOptions(url, shortname);
  return {
    baseUrl: parsed.baseUrl,
    code: parsed.code,
    ...(shortname === undefined ? {} : { shortname }),
  };
}

/** Manual URL mode: no one-time code; credentials are requested separately/securely. */
function parseManualOptions(
  raw: string,
  shortname: string | undefined,
): { baseUrl: string; code: string } {
  if (shortname === undefined) {
    throw new PairingError(
      'A manual server URL needs a shortname: /pair --url <https://host> --as <shortname>',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new PairingError('That is not a valid server URL.', { cause });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PairingError('Server URLs must use http or https.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new PairingError('Server URLs cannot contain embedded credentials.');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new PairingError('A server URL cannot contain a query string or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return { baseUrl: url.toString().replace(/\/$/, ''), code: '' };
}

export function isPairingUrl(raw: string): boolean {
  try {
    return new URL(raw).pathname.includes(connectPath);
  } catch {
    return false;
  }
}

/**
 * Redacts a one-time pairing code from text that may be shown in notices or logs. The code
 * is the last path segment after `/auth/connect/`; a bare code is only redacted when it is
 * known to the caller.
 */
export function redactPairingCode(text: string, code?: string): string {
  let redacted = text.replace(/(\/auth\/connect\/)[^/?#\s]+/g, '$1<redacted>');
  if (code !== undefined && code !== '') {
    redacted = redacted.split(code).join('<redacted>');
  }
  return redacted;
}

const shortnameSafe = /[^a-z0-9-]+/g;

/** Suggests a valid shortname from a server's hostname without requiring user input. */
export function suggestShortname(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return 'server';
  }
  const label = host.split('.').find((part) => part !== '' && part !== 'localhost') ?? 'server';
  const cleaned = label
    .toLowerCase()
    .replace(shortnameSafe, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  if (cleaned === '') return 'server';
  return /^[a-z0-9]/.test(cleaned) ? cleaned : `s-${cleaned}`.slice(0, 32);
}
