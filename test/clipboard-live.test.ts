import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ClipboardService, createClipboardService } from '../src/app/clipboard.ts';

/**
 * Real desktop-clipboard acceptance. Opt in with `MARGARITA_CLIPBOARD_LIVE=1`; the normal
 * suite never opens the desktop clipboard and never changes what the person copied.
 *
 * The previous plain-text clipboard is restored when it can be read.
 */
const live = process.env['MARGARITA_CLIPBOARD_LIVE'] === '1';
let stateDir: string | undefined;
let service: ClipboardService | undefined;
let previous: Uint8Array | undefined;

if (live) {
  stateDir = await mkdtemp(join(tmpdir(), 'marg-clip-live-'));
  service = createClipboardService({ stateDir, pid: process.pid, remote: false });
  const current = await service.read();
  if (current.status === 'read' && current.mimeType.toLowerCase().startsWith('text/')) {
    previous = current.bytes;
  }
}

afterAll(async () => {
  if (service === undefined) return;
  if (previous !== undefined) {
    await service.writeText(new TextDecoder().decode(previous), { fileFallback: false });
  }
  await service.dispose();
  if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
});

test.skipIf(!live)(
  '100 KB of multiline Unicode round-trips through the native clipboard',
  async () => {
    if (service === undefined) throw new Error('live clipboard service missing');
    const text = `${'ünï 🔑 漢字 line\n'.repeat(5_000)}end without trailing newline`;
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(100_000);
    expect(await service.writeText(text)).toEqual({ status: 'written', backend: 'native' });
    const read = await service.read();
    expect(read.status).toBe('read');
    if (read.status !== 'read') throw new Error('clipboard was not readable');
    const returned = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
    // Windows' native text clipboard stores lines with CRLF; every other byte, including
    // multi-byte Unicode, must survive exactly.
    expect(returned.replace(/\r\n/g, '\n')).toBe(text);
    expect(returned).not.toContain('\ufffd');
  },
);

test.skipIf(!live)('a Unicode code block keeps its indentation and characters', async () => {
  if (service === undefined) throw new Error('live clipboard service missing');
  const text = '```ts\nconst greeting = "héllo 🌍";\n\treturn greeting;\n```';
  expect(await service.writeText(text)).toEqual({ status: 'written', backend: 'native' });
  const read = await service.read();
  expect(read.status).toBe('read');
  if (read.status !== 'read') throw new Error('clipboard was not readable');
  const returned = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
  expect(returned.replace(/\r\n/g, '\n')).toBe(text);
});
