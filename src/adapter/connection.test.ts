import { describe, expect, test } from 'bun:test';

import { checkServerUrl, connect, ConnectionError, redactUrl } from './connection.ts';

const withPassword = { hasPassword: true, allowInsecureHttp: false };

describe('server URL policy (issue #44)', () => {
  test('loopback HTTP is allowed with a password, including IPv6', () => {
    for (const url of ['http://localhost:4096', 'http://127.0.0.1:4096', 'http://[::1]:4096']) {
      expect(checkServerUrl(url, withPassword).protocol).toBe('http:');
    }
  });

  test('remote HTTPS is allowed; remote HTTP without a password is allowed', () => {
    expect(checkServerUrl('https://example.com', withPassword).host).toBe('example.com');
    expect(
      checkServerUrl('http://example.com', { hasPassword: false, allowInsecureHttp: false }).host,
    ).toBe('example.com');
  });

  test('remote HTTP with a password is refused unless explicitly overridden', () => {
    expect(() => checkServerUrl('http://example.com:4096', withPassword)).toThrow(
      /plain HTTP.*MARGARITA_ALLOW_INSECURE_HTTP/,
    );
    expect(
      checkServerUrl('http://example.com', { hasPassword: true, allowInsecureHttp: true }).host,
    ).toBe('example.com');
  });

  test('URL credentials and other protocols are rejected without echoing secrets', () => {
    const secret = 'p%40ss%3Aword';
    for (const raw of [`https://user:${secret}@example.com`, 'ftp://example.com']) {
      let message = '';
      try {
        checkServerUrl(raw, withPassword);
      } catch (error) {
        message = error instanceof ConnectionError ? error.message : 'wrong error';
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(secret);
      expect(message).not.toContain('p@ss');
    }
  });

  test('an invalid URL error does not echo the input', async () => {
    const error = await connect({ server: 'not a url token=sekrit', startServer: false }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error instanceof Error ? error.message : '').not.toContain('sekrit');
  });

  test('redactUrl drops user info, query and fragment', () => {
    expect(redactUrl('https://u:p%40ss@example.com:8443/api?token=abc#frag')).toBe(
      'https://example.com:8443/api',
    );
    expect(redactUrl('http://localhost:4096/')).toBe('http://localhost:4096');
    expect(redactUrl('garbage')).toBe('<invalid url>');
  });
});
