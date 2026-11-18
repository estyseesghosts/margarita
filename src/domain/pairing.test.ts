import { describe, expect, test } from 'bun:test';

import {
  PairingError,
  parsePairArgs,
  parsePairingUrl,
  redactPairingCode,
  suggestShortname,
} from './pairing.ts';

describe('pairing URLs', () => {
  test('parses a /auth/connect link with a base path', () => {
    expect(parsePairingUrl('https://host.example/base/auth/connect/abc123')).toEqual({
      baseUrl: 'https://host.example/base',
      code: 'abc123',
    });
  });

  test('accepts a root base URL', () => {
    expect(parsePairingUrl('http://localhost:4096/auth/connect/code')).toEqual({
      baseUrl: 'http://localhost:4096',
      code: 'code',
    });
  });

  test('rejects foreign protocols, credentials, query strings, and paths', () => {
    expect(() => parsePairingUrl('ftp://host/auth/connect/x')).toThrow(PairingError);
    expect(() => parsePairingUrl('https://u:p@host/auth/connect/x')).toThrow(
      'embedded credentials',
    );
    expect(() => parsePairingUrl('https://host/auth/connect/x?next=evil')).toThrow('query string');
    expect(() => parsePairingUrl('https://host/other/x')).toThrow('/auth/connect/');
    expect(() => parsePairingUrl('https://host/auth/connect/')).toThrow('one-time code');
  });
});

describe('pair arguments', () => {
  test('parses a link and --as', () => {
    expect(parsePairArgs('https://host/auth/connect/abc --as buildbox')).toEqual({
      baseUrl: 'https://host',
      code: 'abc',
      shortname: 'buildbox',
    });
  });

  test('parses manual --url with a required shortname', () => {
    expect(parsePairArgs('--url https://host --as home')).toEqual({
      baseUrl: 'https://host',
      code: '',
      shortname: 'home',
    });
    expect(() => parsePairArgs('--url https://host')).toThrow('needs a shortname');
  });

  test('rejects unknown options and multiple URLs', () => {
    expect(() => parsePairArgs('--bogus x')).toThrow('Unknown /pair option');
    expect(() => parsePairArgs('https://a https://b')).toThrow('Only one pairing URL');
    expect(() => parsePairArgs('')).toThrow('Usage: /pair');
  });
});

describe('pairing redaction', () => {
  test('redacts the code in a link and on its own', () => {
    expect(redactPairingCode('failed https://h/auth/connect/secret')).toBe(
      'failed https://h/auth/connect/<redacted>',
    );
    expect(redactPairingCode('bad secret code', 'secret')).toBe('bad <redacted> code');
  });

  test('suggests a valid shortname from the host', () => {
    expect(suggestShortname('https://Build.Example.com')).toBe('build');
    expect(suggestShortname('https://localhost:4096')).toBe('server');
    expect(suggestShortname('https://_weird.example')).toBe('weird');
  });
});
