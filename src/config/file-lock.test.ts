import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireFileLock, LockTimeoutError } from './file-lock.ts';

const record = (token: string, acquiredAt = Date.now(), pid = 999_999) =>
  `${JSON.stringify({ pid, token, acquiredAt })}\n`;

describe('owned lockfiles (#157)', () => {
  test('a long-held live lock is never stolen, regardless of its age', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-lock-live-'));
    const path = join(dir, 'state.json.lock');
    try {
      await writeFile(path, record('live-owner', Date.now() - 3_600_000));
      let failed: unknown;
      try {
        await acquireFileLock(path, { timeoutMs: 60, retryMs: 5, isAlive: () => true });
      } catch (cause) {
        failed = cause;
      }
      expect(failed).toBeInstanceOf(LockTimeoutError);
      // The original lock is untouched.
      expect(await readFile(path, 'utf8')).toContain('live-owner');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a release never removes a lock that was replaced by another owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-lock-release-'));
    const path = join(dir, 'state.json.lock');
    try {
      const first = await acquireFileLock(path, { isAlive: () => true });
      await writeFile(path, record('replacement', Date.now(), process.pid));
      await first.release();
      expect(await readFile(path, 'utf8')).toContain('replacement');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a crash-left lock from a dead owner is recoverable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-lock-dead-'));
    const path = join(dir, 'state.json.lock');
    try {
      await writeFile(path, record('dead-owner', Date.now() - 3_600_000));
      const acquired = await acquireFileLock(path, {
        timeoutMs: 100,
        retryMs: 5,
        isAlive: () => false,
      });
      expect(await readFile(path, 'utf8')).toContain(acquired.token);
      await acquired.release();
      let missing = false;
      try {
        await readFile(path, 'utf8');
      } catch {
        missing = true;
      }
      expect(missing).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('each acquisition carries a distinct owner token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-lock-token-'));
    const path = join(dir, 'state.json.lock');
    try {
      const first = await acquireFileLock(path, { isAlive: () => true });
      await first.release();
      const second = await acquireFileLock(path, { isAlive: () => true });
      expect(second.token).not.toBe(first.token);
      await second.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
