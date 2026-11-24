import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ClipboardReadResult,
  HostClipboardService,
  HostClipboardWriteResult,
  TerminalClipboardAdapter,
} from '@opentui/core';

import {
  type ClipboardRead,
  type ClipboardService,
  createClipboardService,
  isRemoteSession,
} from './clipboard.ts';

const dirs: string[] = [];
const services: ClipboardService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'marg-clip-'));
  dirs.push(dir);
  return dir;
}

type HostProbe = Readonly<{
  service: HostClipboardService;
  writes: string[];
  reads: () => number;
  disposed: () => boolean;
}>;

function fakeHost(
  writeResult: HostClipboardWriteResult = { status: 'written' },
  readResult: ClipboardReadResult = { status: 'empty' },
): HostProbe {
  const writes: string[] = [];
  let reads = 0;
  let disposed = false;
  return {
    writes,
    reads: () => reads,
    disposed: () => disposed,
    service: {
      maxWriteBytes: 8 * 1024 * 1024,
      async writeText(text) {
        writes.push(text);
        return writeResult;
      },
      async read() {
        reads += 1;
        return readResult;
      },
      async clear() {
        return { status: 'cleared' };
      },
      async dispose() {
        disposed = true;
      },
    },
  };
}

type TerminalProbe = Readonly<{ adapter: TerminalClipboardAdapter; writes: string[] }>;

function fakeTerminal(status: 'attempted' | 'local-failure' = 'attempted'): TerminalProbe {
  const writes: string[] = [];
  return {
    writes,
    adapter: {
      remote: false,
      writeText(text) {
        writes.push(text);
        return { status, capability: status === 'attempted' ? 'supported' : 'unknown' };
      },
      clear() {
        return { status: 'attempted', capability: 'supported' };
      },
    },
  };
}

async function makeService(options: {
  host?: HostClipboardService | null;
  terminal?: TerminalClipboardAdapter;
  remote?: boolean;
  dir?: string;
}): Promise<ClipboardService> {
  const created = createClipboardService({
    stateDir: options.dir ?? (await makeStateDir()),
    pid: 42,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.remote === undefined ? {} : { remote: options.remote }),
  });
  services.push(created);
  return created;
}

describe('client-local clipboard service (#184)', () => {
  test('native writes carry a 100 KB multiline Unicode payload exactly, unsplit', async () => {
    const host = fakeHost();
    const terminal = fakeTerminal();
    const clipboard = await makeService({ host: host.service, terminal: terminal.adapter });
    const text = `${'ünï 🔑 line\n'.repeat(8_000)}end`;
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(100_000);
    expect(await clipboard.writeText(text)).toEqual({ status: 'written', backend: 'native' });
    expect(host.writes).toEqual([text]);
    expect(terminal.writes).toEqual([]);
  });

  test('without a native clipboard the terminal channel is unconfirmed, never a file', async () => {
    const terminal = fakeTerminal();
    const clipboard = await makeService({ host: null, terminal: terminal.adapter });
    expect(await clipboard.writeText('line one\nünï 🔑 two')).toEqual({
      status: 'unconfirmed',
      backend: 'terminal',
    });
    expect(terminal.writes).toHaveLength(1);
  });

  test('an explicit copy may fall back to an exact owner-only file', async () => {
    const terminal = fakeTerminal('local-failure');
    const clipboard = await makeService({ host: null, terminal: terminal.adapter });
    const text = 'exact\npayload 🔑\n';
    const outcome = await clipboard.writeText(text, { fileFallback: true });
    expect(outcome.status).toBe('file');
    if (outcome.status !== 'file') throw new Error('expected a file fallback');
    expect(await readFile(outcome.path, 'utf8')).toBe(text);
    if (process.platform !== 'win32') {
      expect((await stat(outcome.path)).mode & 0o777).toBe(0o600);
    }
  });

  test('a failed autocopy never writes selection bytes to disk', async () => {
    const dir = await makeStateDir();
    const clipboard = await makeService({ host: null, dir });
    const outcome = await clipboard.writeText('private selection', { fileFallback: false });
    expect(outcome.status).toBe('unavailable');
    expect(await readdir(dir)).toEqual([]);
  });

  test('a native rejection falls through to the terminal channel', async () => {
    const host = fakeHost({ status: 'failed', error: new Error('NUL is unsupported') });
    const terminal = fakeTerminal();
    const clipboard = await makeService({ host: host.service, terminal: terminal.adapter });
    expect(await clipboard.writeText('a\u0000b')).toEqual({
      status: 'unconfirmed',
      backend: 'terminal',
    });
    expect(terminal.writes).toEqual(['a\u0000b']);
  });

  test('serializes overlapping writes so the newest request completes last', async () => {
    const order: string[] = [];
    const host: HostClipboardService = {
      maxWriteBytes: 8 * 1024 * 1024,
      async writeText(text) {
        order.push(`start:${text}`);
        await Bun.sleep(text === 'first' ? 20 : 0);
        order.push(`end:${text}`);
        return { status: 'written' };
      },
      async read() {
        return { status: 'empty' };
      },
      async clear() {
        return { status: 'cleared' };
      },
      async dispose() {},
    };
    const clipboard = await makeService({ host });
    const first = clipboard.writeText('first');
    const second = clipboard.writeText('second');
    await Promise.all([first, second]);
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  test('reads keep the source MIME type and report every unavailable state truthfully', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const png = fakeHost(undefined, {
      status: 'read',
      representation: { mimeType: 'image/png', bytes },
    });
    const clipboard = await makeService({ host: png.service });
    expect(await clipboard.read()).toEqual({ status: 'read', mimeType: 'image/png', bytes });

    const cases: readonly [ClipboardReadResult, ClipboardRead][] = [
      [{ status: 'empty' }, { status: 'empty' }],
      [
        { status: 'unsupported' },
        { status: 'unsupported', detail: 'the system clipboard cannot be read here' },
      ],
      [
        { status: 'limit-exceeded' },
        { status: 'too-large', detail: 'the clipboard payload is larger than 8 MB' },
      ],
      [{ status: 'timed-out' }, { status: 'failed', detail: 'the clipboard read timed out' }],
    ];
    for (const [result, expected] of cases) {
      const probe = fakeHost(undefined, result);
      const one = await makeService({ host: probe.service });
      expect(await one.read()).toEqual(expected);
    }
  });

  test('an SSH session never touches the host clipboard', async () => {
    const host = fakeHost();
    const terminal = fakeTerminal();
    const clipboard = await makeService({
      host: host.service,
      terminal: terminal.adapter,
      remote: true,
    });
    expect(await clipboard.read()).toEqual({
      status: 'unsupported',
      detail: 'this session has no client-side clipboard',
    });
    expect(await clipboard.writeText('ssh text')).toEqual({
      status: 'unconfirmed',
      backend: 'terminal',
    });
    expect(host.reads()).toBe(0);
    expect(host.writes).toEqual([]);
    expect(isRemoteSession({ SSH_CONNECTION: 'host 1 2 3' })).toBe(true);
    expect(isRemoteSession({ SSH_TTY: '/dev/pts/0' })).toBe(true);
    expect(isRemoteSession({ MOSH_CONNECTION: 'client 1 2 3 4' })).toBe(true);
    expect(isRemoteSession({})).toBe(false);
  });
});
