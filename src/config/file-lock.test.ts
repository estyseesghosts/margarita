import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { acquireFileLock, InvalidLockError, LockTimeoutError } from './file-lock.ts';

describe('SQLite file locks', () => {
  test('a live owner is never displaced and a previous release cannot release its successor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-lock-live-'));
    const path = join(dir, 'state.json.lock');
    try {
      const first = await acquireFileLock(path);
      let failure: unknown;
      try {
        await acquireFileLock(path, { timeoutMs: 40, retryMs: 5 });
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(LockTimeoutError);
      await first.release();

      // Simulate offline replacement before a successor opens a new lock file at this path.
      await unlink(path);
      const successor = await acquireFileLock(path);
      expect(successor.token).not.toBe(first.token);
      await first.release();
      failure = undefined;
      try {
        await acquireFileLock(path, { timeoutMs: 40, retryMs: 5 });
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(LockTimeoutError);
      await successor.release();
      const later = await acquireFileLock(path);
      await later.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('concurrent acquisitions have one critical section', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-lock-contend-'));
    const path = join(dir, 'state.json.lock');
    let active = 0;
    let maximum = 0;
    try {
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          const lock = await acquireFileLock(path, { timeoutMs: 2_000, retryMs: 2 });
          try {
            active += 1;
            maximum = Math.max(maximum, active);
            await Bun.sleep(5);
            active -= 1;
          } finally {
            await lock.release();
          }
        }),
      );
      expect(maximum).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a crashed independent owner releases the kernel lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-lock-crash-'));
    const path = join(dir, 'state.json.lock');
    const moduleURL = pathToFileURL(join(import.meta.dir, 'file-lock.ts')).href;
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { acquireFileLock } from ${JSON.stringify(moduleURL)}; await acquireFileLock(process.argv[1]); console.log('ready'); await new Promise(() => {});`,
        path,
      ],
      { env: { ...process.env, BUN_BE_BUN: '1' }, stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain('ready');
      reader.releaseLock();
      let failure: unknown;
      try {
        await acquireFileLock(path, { timeoutMs: 40, retryMs: 5 });
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(LockTimeoutError);
      child.kill();
      await child.exited;
      const recovered = await acquireFileLock(path);
      await recovered.release();
    } finally {
      child.kill();
      await child.exited;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('legacy and incomplete lock files fail closed without being modified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-lock-legacy-'));
    try {
      for (const content of ['', '{"pid":999999,"token":"old","acquiredAt":1}\n']) {
        const path = join(dir, content.length === 0 ? 'partial.lock' : 'legacy.lock');
        await writeFile(path, content);
        let failure: unknown;
        try {
          await acquireFileLock(path, { timeoutMs: 40 });
        } catch (cause) {
          failure = cause;
        }
        expect(failure).toBeInstanceOf(InvalidLockError);
        expect(await readFile(path, 'utf8')).toBe(content);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
