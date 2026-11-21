/** SQLite's OS-backed writer lock serializes Margarita state updates across processes. */
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { link, lstat, unlink, writeFile } from 'node:fs/promises';

import { isRecord } from '../domain/backend-event.ts';

const applicationID = 1_296_126_535;

export type FileLockOptions = Readonly<{
  timeoutMs?: number;
  retryMs?: number;
  now?: () => number;
}>;

export type FileLock = Readonly<{
  /** Unique to this acquisition; safe to use in temp paths. */
  token: string;
  /** Releases this acquisition without removing the shared lock file. */
  release: () => Promise<void>;
}>;

export class LockTimeoutError extends Error {
  constructor(readonly lockPath: string) {
    super(`Timed out waiting for the lock on ${lockPath}; another Margarita process holds it.`);
    this.name = 'LockTimeoutError';
  }
}

export class InvalidLockError extends Error {
  constructor(
    readonly lockPath: string,
    cause?: unknown,
  ) {
    super(
      `Invalid or legacy lock file ${lockPath}. Stop all Margarita processes, remove this lock file, and restart.`,
      { cause },
    );
    this.name = 'InvalidLockError';
  }
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error['code'] === code;
}

/** Publish a complete database atomically, so no contender sees a partially initialized file. */
async function ensureLockFile(lockPath: string): Promise<void> {
  try {
    await lstat(lockPath);
    return;
  } catch (cause) {
    if (!hasCode(cause, 'ENOENT')) throw cause;
  }

  const memory = new Database(':memory:');
  let image: Buffer;
  try {
    memory.exec(`PRAGMA application_id = ${applicationID}`);
    image = memory.serialize();
  } finally {
    memory.close(true);
  }
  const stagingPath = `${lockPath}.${randomUUID()}.tmp`;
  await writeFile(stagingPath, image, { flag: 'wx', mode: 0o600 });
  try {
    try {
      await link(stagingPath, lockPath);
    } catch (cause) {
      if (!hasCode(cause, 'EEXIST')) throw cause;
    }
  } finally {
    await unlink(stagingPath);
  }
}

/**
 * Acquire a SQLite writer transaction with a bounded, asynchronously retried wait. SQLite
 * retains the operating-system lock for the lifetime of this connection and releases it on
 * close or process exit. The pathname is never removed during acquisition or release.
 */
export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions = {},
): Promise<FileLock> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryMs = options.retryMs ?? 25;
  const now = options.now ?? (() => performance.now());
  const deadline = now() + timeoutMs;
  await ensureLockFile(lockPath);
  const database = new Database(lockPath, { readwrite: true, create: false });

  try {
    database.exec('PRAGMA busy_timeout = 0');
    let identity: unknown;
    try {
      identity = database.query('PRAGMA application_id').get();
    } catch (cause) {
      if (hasCode(cause, 'SQLITE_NOTADB') || hasCode(cause, 'SQLITE_CORRUPT')) {
        throw new InvalidLockError(lockPath, cause);
      }
      throw cause;
    }
    if (!isRecord(identity) || identity['application_id'] !== applicationID) {
      throw new InvalidLockError(lockPath);
    }

    for (;;) {
      try {
        database.exec('BEGIN IMMEDIATE');
        break;
      } catch (cause) {
        if (!hasCode(cause, 'SQLITE_BUSY')) throw cause;
        const remaining = deadline - now();
        if (remaining <= 0) throw new LockTimeoutError(lockPath);
        await Bun.sleep(Math.min(retryMs, remaining));
      }
    }
  } catch (cause) {
    database.close(true);
    throw cause;
  }

  return {
    token: randomUUID(),
    async release() {
      database.close(true);
    },
  };
}
