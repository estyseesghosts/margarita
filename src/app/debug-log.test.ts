import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDebugLog, noDebugLog } from './debug-log.ts';

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) throw new Error('expected an object log entry');
  return value;
}

function tempLog(): string {
  dir = mkdtempSync(join(tmpdir(), 'marg-debug-'));
  return join(dir, 'marg.log');
}

describe('createDebugLog', () => {
  test('creates entries in the requested file and without the flag nothing is written', () => {
    const path = tempLog();
    const created = createDebugLog(path);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    created.log.write('startup', { version: '0.0.1' });
    created.log.close();

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = parseEntry(lines[0] ?? '');
    expect(entry['kind']).toBe('startup');
    expect(entry['version']).toBe('0.0.1');
    expect(typeof entry['ts']).toBe('string');
  });

  test('appends to an existing file', () => {
    const path = tempLog();
    const first = createDebugLog(path);
    if (!first.ok) throw new Error('expected ok');
    first.log.write('first');
    first.log.close();
    const second = createDebugLog(path);
    if (!second.ok) throw new Error('expected ok');
    second.log.write('second');
    second.log.close();

    const kinds = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => parseEntry(line)['kind']);
    expect(kinds).toEqual(['first', 'second']);
  });

  test('an unwritable path is a clear error, not a silent no-op', () => {
    const base = mkdtempSync(join(tmpdir(), 'marg-debug-'));
    const missing = join(base, 'no', 'such', 'directory', 'marg.log');
    const result = createDebugLog(missing);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('--debug-log');
    expect(result.message).toContain(missing);

    const directory = createDebugLog(base); // base is an existing directory
    expect(directory.ok).toBe(false);
    if (directory.ok) return;
    expect(directory.message).toContain('--debug-log');
    rmSync(base, { recursive: true, force: true });
  });

  test('secret-bearing payloads never reach the file', () => {
    const path = tempLog();
    const created = createDebugLog(path);
    if (!created.ok) throw new Error('expected ok');
    created.log.write('backend-error', {
      authorization: 'Bearer abcdef1234567890secret',
      password: 'hunter2',
      headers: { cookie: 'session=xyzsecretcookie', 'x-api-key': 'sk-live-123456789' },
      note: 'used Bearer abcdef1234567890secret to call the API',
    });
    created.log.close();

    const raw = readFileSync(path, 'utf8');
    for (const needle of [
      'abcdef1234567890secret',
      'hunter2',
      'session=xyzsecretcookie',
      'sk-live-123456789',
    ]) {
      expect(raw).not.toContain(needle);
    }
    expect(raw).toContain('[redacted]');
  });

  test('buffered writes are drained in order on close', () => {
    const path = tempLog();
    const created = createDebugLog(path);
    if (!created.ok) throw new Error('expected ok');
    for (let index = 0; index < 200; index += 1) created.log.write(`entry-${index}`);
    created.log.close();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(200);
    const kinds = lines.map((line) => parseEntry(line)['kind']);
    expect(kinds[0]).toBe('entry-0');
    expect(kinds.at(-1)).toBe('entry-199');
  });

  test('a pathological write burst is bounded and reports dropped records', () => {
    const path = tempLog();
    const created = createDebugLog(path);
    if (!created.ok) throw new Error('expected ok');
    for (let index = 0; index < 1200; index += 1) created.log.write('burst', { index });
    created.log.close();
    const lines = readFileSync(path, 'utf8').trim().split('\n').map(parseEntry);
    expect(lines.length).toBeLessThanOrEqual(600);
    expect(lines.some((entry) => entry['kind'] === 'debug-log-dropped')).toBe(true);
    expect(lines.some((entry) => entry['kind'] === 'burst')).toBe(true);
  });

  test('noDebugLog creates nothing and never throws', () => {
    const path = tempLog();
    expect(noDebugLog.enabled).toBe(false);
    noDebugLog.write('anything', { nested: { deep: 'value' } });
    noDebugLog.close();
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });

  test('long values are truncated and circular values do not break writes', () => {
    const path = tempLog();
    const created = createDebugLog(path);
    if (!created.ok) throw new Error('expected ok');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    created.log.write('truncation', { payload: 'x'.repeat(1000) });
    expect(() => created.log.write('circular', circular)).not.toThrow();
    created.log.close();

    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('[truncated 1000 chars]');
    expect(raw).toContain('[deep]'); // depth cap, so cyclic graphs still serialize
  });
});
