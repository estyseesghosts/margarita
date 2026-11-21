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

/**
 * The queue exists but cannot be trusted. It is never overwritten or treated as empty: the
 * original bytes stay in place so the pending credential IDs remain recoverable by hand.
 * The message names only the path and the failure class, never queue contents.
 */
export class PendingQueueError extends Error {
  constructor(
    readonly path: string,
    readonly reason: 'unreadable' | 'malformed',
    options?: ErrorOptions,
  ) {
    super(
      `The pending credential cleanup queue at ${path} is ${reason}; it was left untouched. ` +
        `Inspect or repair it by hand (it is JSON of the form {"serverIDs":["srv_..."]}), then retry.`,
      options,
    );
    this.name = 'PendingQueueError';
  }
}

/** Only a genuinely absent file is an empty queue; every other failure fails closed. */
async function readPending(path: string): Promise<Pending> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (isRecord(cause) && cause['code'] === 'ENOENT') return { serverIDs: [] };
    throw new PendingQueueError(path, 'unreadable', { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new PendingQueueError(path, 'malformed', { cause });
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['serverIDs'])) {
    throw new PendingQueueError(path, 'malformed');
  }
  const ids: string[] = [];
  for (const entry of parsed['serverIDs']) {
    if (typeof entry !== 'string' || entry === '') throw new PendingQueueError(path, 'malformed');
    if (!ids.includes(entry)) ids.push(entry);
  }
  return { serverIDs: ids };
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
