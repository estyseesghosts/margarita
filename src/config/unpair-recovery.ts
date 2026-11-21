/**
 * Durable tombstone queue for the credential half of an unpair. Removing the registry entry
 * and deleting an OS credential cannot be one atomic transaction. The registry is removed
 * first; if credential deletion then fails, the server ID is queued here so the next startup
 * retries instead of leaving an orphaned secret (or claiming the unpair fully succeeded).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isRecord } from '../domain/backend-event.ts';
import type { CredentialStore } from './credentials.ts';
import { acquireFileLock } from './file-lock.ts';

const queueName = 'pending-unpair.json';

type Pending = Readonly<{ serverIDs: string[] }>;

async function readPending(path: string): Promise<Pending> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (isRecord(parsed) && Array.isArray(parsed['serverIDs'])) {
      return {
        serverIDs: parsed['serverIDs'].filter(
          (entry): entry is string => typeof entry === 'string',
        ),
      };
    }
  } catch {
    // Missing or unreadable queue: nothing pending.
  }
  return { serverIDs: [] };
}

async function writePending(path: string, token: string, pending: Pending): Promise<void> {
  const temp = `${path}.${process.pid}.${token}.tmp`;
  await writeFile(temp, `${JSON.stringify(pending, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temp, path);
}

export async function enqueueCredentialCleanup(stateDir: string, serverID: string): Promise<void> {
  const path = join(stateDir, queueName);
  await mkdir(stateDir, { recursive: true });
  const lock = await acquireFileLock(`${path}.lock`);
  try {
    const pending = await readPending(path);
    if (!pending.serverIDs.includes(serverID)) pending.serverIDs.push(serverID);
    await writePending(path, lock.token, pending);
  } finally {
    await lock.release();
  }
}

export type ReconcileResult = Readonly<{
  /** Credentials deleted successfully this run. */
  cleared: number;
  /** IDs still needing cleanup (e.g. an unavailable keyring). */
  remaining: string[];
}>;

/** Retries queued credential deletions at startup; keeps failures queued for a later run. */
export async function reconcileCredentialCleanup(
  stateDir: string,
  credentials: CredentialStore,
): Promise<ReconcileResult> {
  const path = join(stateDir, queueName);
  await mkdir(stateDir, { recursive: true });
  const lock = await acquireFileLock(`${path}.lock`);
  try {
    const pending = await readPending(path);
    if (pending.serverIDs.length === 0) return { cleared: 0, remaining: [] };
    const remaining: string[] = [];
    let cleared = 0;
    for (const serverID of pending.serverIDs) {
      try {
        await credentials.delete(serverID);
        cleared += 1;
      } catch {
        // Never echo the failure (it may mention a secret); keep the ID for a later retry.
        remaining.push(serverID);
      }
    }
    await writePending(path, lock.token, { serverIDs: remaining });
    return { cleared, remaining };
  } finally {
    await lock.release();
  }
}
