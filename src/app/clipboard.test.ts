import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { copyToClipboard } from './clipboard.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(overrides: { term?: string | undefined; isTTY?: boolean } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'marg-clip-'));
  dirs.push(stateDir);
  const written: string[] = [];
  const env = {
    term: 'xterm-256color',
    isTTY: true,
    ...overrides,
    write: (sequence: string) => void written.push(sequence),
    stateDir,
    pid: 42,
  };
  return { env, written, stateDir };
}

describe('copy to clipboard (#184)', () => {
  test('a TTY emits exactly one OSC 52 set sequence for multi-line Unicode text', async () => {
    const { env, written } = await setup();
    const text = 'line one\nünï 🔑 two\n';
    expect(await copyToClipboard(text, env)).toEqual({ method: 'clipboard' });
    expect(written).toHaveLength(1);
    const sequence = written[0] ?? '';
    const prefix = `${String.fromCharCode(27)}]52;c;`;
    const suffix = `${String.fromCharCode(27)}\\`;
    expect(sequence.startsWith(prefix) && sequence.endsWith(suffix)).toBe(true);
    const payload = sequence.slice(prefix.length, sequence.length - suffix.length);
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe(text);
  });

  test('no TTY, TERM=dumb and over-limit payloads write an exact owner-only file', async () => {
    const cases = [
      { label: 'no tty', env: { isTTY: false }, text: 'plain\n' },
      { label: 'dumb', env: { term: 'dumb' }, text: 'ünï\n' },
      { label: 'unset TERM', env: { term: undefined, isTTY: false }, text: 'x' },
      { label: 'oversize', env: {}, text: 'a'.repeat(4000) },
    ];
    for (const entry of cases) {
      const { env, written, stateDir } = await setup(entry.env);
      const outcome = await copyToClipboard(entry.text, env);
      expect(outcome.method).toBe('file');
      expect(written).toEqual([]);
      expect(await readFile(outcome.path ?? '', 'utf8')).toBe(entry.text);
      expect(outcome.path?.startsWith(stateDir)).toBe(true);
      if (process.platform !== 'win32') {
        expect((await stat(outcome.path ?? '')).mode & 0o777).toBe(0o600);
      }
    }
  });

  test('private text is never printed as raw escape data on the fallback path', async () => {
    const { env, written } = await setup({ isTTY: false });
    await copyToClipboard('secret-looking text', env);
    expect(written.join('')).not.toContain('secret');
  });

  test('every fallback gets its own file (no overwrite between copies)', async () => {
    const { env, stateDir } = await setup({ isTTY: false });
    await copyToClipboard('first', env);
    await copyToClipboard('second', env);
    expect(await readdir(stateDir)).toHaveLength(2);
  });
});
