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

describe('path-prefixed servers (proxy base path, issue #70)', () => {
  test('redemption and info requests stay beneath the base path', async () => {
    const calls: string[] = [];
    const result = await redeemPairing('https://example.test/opencode', 'once', {
      fetch: async (url) => {
        calls.push(url);
        if (url === 'https://example.test/opencode/auth/connect/once')
          return json({ token: 'tok' });
        if (url === 'https://example.test/opencode/api/info')
          return json({ version: '2.4.0', hostname: 'buildbox' });
        throw new Error(`unexpected request: ${url}`);
      },
    });
    expect(calls).toEqual([
      'https://example.test/opencode/auth/connect/once',
      'https://example.test/opencode/api/info',
    ]);
    expect(result.token).toBe('tok');
    expect(result.baseUrl).toBe('https://example.test/opencode');
  });

  test('a trailing slash on the base path is not doubled', async () => {
    const calls: string[] = [];
    await serverInfo('https://example.test/opencode/', 'Bearer tok', {
      fetch: async (url) => {
        calls.push(url);
        return json({ version: '2.4.0' });
      },
    });
    expect(calls).toEqual(['https://example.test/opencode/api/info']);
  });

  test('root-level servers resolve exactly as before', async () => {
    const calls: string[] = [];
    await serverInfo('https://example.test', 'Bearer tok', {
      fetch: async (url) => {
        calls.push(url);
        return json({ version: '2.4.0' });
      },
    });
    expect(calls).toEqual(['https://example.test/api/info']);
  });

  test('redirects are never followed, even once-removed to a different path on the same host', async () => {
    const calls: string[] = [];
    expect(
      redeemPairing('https://example.test/opencode', 'once', {
        fetch: async (url) => {
          calls.push(url);
          return new Response('', {
            status: 302,
            headers: { location: 'https://example.test/other/capture' },
          });
        },
      }),
    ).rejects.toThrow('redirected');
    expect(calls).toEqual(['https://example.test/opencode/auth/connect/once']);
  });

  test('SDK client requests remain beneath the base path', async () => {
    const { createBackend } = await import('./backend.ts');
    const realFetch = globalThis.fetch;
    const requests: string[] = [];
    const stub = Object.assign(
      (...[input]: Parameters<typeof fetch>): Promise<Response> => {
        requests.push(
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        );
        return Promise.resolve(
          new Response(JSON.stringify({ data: [], cursor: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
      { preconnect: () => {} },
    );
    globalThis.fetch = stub;
    try {
      const backend = createBackend(
        { baseUrl: 'https://example.test/opencode', headers: {}, origin: 'remote' },
        { serverID: 'srv_1' },
      );
      await backend.listSessions({});
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]?.startsWith('https://example.test/opencode/')).toBe(true);
    expect(requests[0]?.startsWith('https://example.test/api')).toBe(false);
  });
});
