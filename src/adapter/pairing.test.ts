import { describe, expect, test } from 'bun:test';

import { PairingError } from '../domain/pairing.ts';
import { redeemPairing, serverInfo } from './pairing.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('pairing redemption', () => {
  test('redeems a code and verifies server.info', async () => {
    const calls: string[] = [];
    const result = await redeemPairing('https://host', 'abc', {
      fetch: async (url, init) => {
        calls.push(`${init.method ?? 'GET'} ${url} ${String(init.redirect)}`);
        if (url.endsWith('/auth/connect/abc')) {
          expect(new Headers(init.headers).get('accept')).toContain('application/json');
          return json({ token: 'tok' });
        }
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
        return json({ version: '2.4.0', hostname: 'buildbox' });
      },
    });
    expect(result).toEqual({
      baseUrl: 'https://host',
      token: 'tok',
      version: '2.4.0',
      hostname: 'buildbox',
    });
    expect(calls).toEqual([
      'GET https://host/auth/connect/abc error',
      'GET https://host/api/info error',
    ]);
  });

  test('expired/used codes and redirects fail with actionable errors', async () => {
    expect(
      redeemPairing('https://host', 'used', {
        fetch: async () => json({}, 401),
      }),
    ).rejects.toThrow('expired, already used, or unauthorized');
    expect(
      redeemPairing('https://host', 'gone', {
        fetch: async () => new Response('', { status: 307, headers: { location: 'https://evil' } }),
      }),
    ).rejects.toThrow('redirected');
  });

  test('non-JSON responses are rejected', async () => {
    expect(
      redeemPairing('https://host', 'code', {
        fetch: async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
      }),
    ).rejects.toThrow('did not return JSON');
  });

  test('a wrong major version is incompatible', async () => {
    expect(
      serverInfo('https://host', 'Bearer tok', {
        fetch: async () => json({ version: '1.9.0' }),
      }),
    ).rejects.toThrow('compatible v2');
  });

  test('plain HTTP to a non-loopback host is refused before any request', () => {
    expect(
      redeemPairing('http://host.example', 'code', {
        fetch: async () => json({ token: 'x' }),
      }),
    ).rejects.toBeInstanceOf(PairingError);
  });

  test('loopback HTTP is allowed', async () => {
    const result = await redeemPairing('http://127.0.0.1:4096', 'code', {
      fetch: async (url) =>
        url.includes('/auth/connect') ? json({ token: 'x' }) : json({ version: '2.0.0' }),
    });
    expect(result.token).toBe('x');
  });
});
