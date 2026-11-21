/**
 * Cross-process advisory lockfiles for Margarita's own state files.
 *
 * A lock carries a unique owner token and the owning PID. A lock is never stolen merely
 * because it is old: a live-but-paused writer keeps its lock (#157). Only a lock whose owner
 * process is confirmed dead may be recovered, and release removes only a lock still carrying
 * our own token, so a stale writer can never delete a replacement lock.
 */

import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';

import { isRecord } from '../domain/backend-event.ts';

export type FileLockOptions = Readonly<{
  timeoutMs?: number;
  retryMs?: number;
  now?: () => number;
  /** Injectable for deterministic tests; defaults to a POSIX/Windows process check. */
  isAlive?: (pid: number) => boolean;
}>;

export type FileLock = Readonly<{
  /** Unique to this acquisition; safe to use in temp paths. */
  token: string;
  /** Removes the lock only if we still own it. */
  release: () => Promise<void>;
}>;

export class LockTimeoutError extends Error {
  constructor(readonly lockPath: string) {
    super(`Timed out waiting for the lock on ${lockPath}; another Margarita process holds it.`);
    this.name = 'LockTimeoutError';
  }
}

type LockRecord = Readonly<{ pid: number; token: string; acquiredAt: number }>;

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but cannot be signalled — still alive.
    if (isRecord(cause) && cause['code'] === 'EPERM') return true;
    return false;
  }
}

async function readRecord(lockPath: string): Promise<LockRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (!isRecord(parsed)) return undefined;
    const { pid, token, acquiredAt } = parsed;
    if (typeof pid !== 'number' || typeof token !== 'string' || typeof acquiredAt !== 'number')
      return undefined;
    return { pid, token, acquiredAt };
  } catch {
    return undefined;
  }
}

/**
 * Acquires the lock at `lockPath`, retrying with a bounded timeout. Inject `now`/`isAlive`
 * in tests so live-lock and dead-owner recovery are deterministic.
 */
export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions = {},
): Promise<FileLock> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryMs = options.retryMs ?? 25;
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const token = randomUUID();
  const deadline = now() + timeoutMs;

  for (;;) {
    const record: LockRecord = { pid: process.pid, token, acquiredAt: now() };
    try {
      await writeFile(lockPath, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (cause) {
      if (!isRecord(cause) || cause['code'] !== 'EEXIST') throw cause;
      const seen = await readRecord(lockPath);
      // A live owner — even one paused far past any age threshold — is never displaced.
      if (seen !== undefined && !isAlive(seen.pid)) {
        // Re-check before removing so a concurrently replaced lock is left alone.
        const current = await readRecord(lockPath);
        if (current?.token === seen.token) await unlink(lockPath).catch(() => {});
        continue;
      }
      if (now() >= deadline) throw new LockTimeoutError(lockPath);
      await Bun.sleep(retryMs);
      continue;
    }
    return {
      token,
      async release() {
        const current = await readRecord(lockPath);
        if (current?.token !== token) return;
        await unlink(lockPath).catch(() => {});
      },
    };
  }
}
