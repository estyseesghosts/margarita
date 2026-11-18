import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isRecord } from '../domain/backend-event.ts';
import type { ModelSelection } from '../domain/model-ref.ts';

/** Frontend-only presentation state. Session history is never stored here. */
export type LocalState = Readonly<{
  schemaVersion: 1;
  /** Prompt history keyed by canonical project directory key. */
  history: Readonly<Record<string, readonly string[]>>;
  recentModels: readonly ModelSelection[];
}>;

export const emptyState: LocalState = { schemaVersion: 1, history: {}, recentModels: [] };

export async function loadState(path: string): Promise<{ state: LocalState; warning?: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (isRecord(cause) && cause['code'] === 'ENOENT') return { state: emptyState };
    return { state: emptyState, warning: `Could not read local state: ${String(cause)}` };
  }
  try {
    return { state: parseState(JSON.parse(text)) };
  } catch (cause) {
    return {
      state: emptyState,
      warning: `Local state was unreadable and was reset: ${String(cause)}`,
    };
  }
}

export function parseState(raw: unknown): LocalState {
  if (!isRecord(raw) || raw['schemaVersion'] !== 1) return emptyState;
  const history: Record<string, string[]> = {};
  if (isRecord(raw['history'])) {
    for (const [key, entries] of Object.entries(raw['history'])) {
      if (Array.isArray(entries))
        history[key] = entries.filter((entry) => typeof entry === 'string');
    }
  }
  const recentModels: ModelSelection[] = [];
  if (Array.isArray(raw['recentModels'])) {
    for (const entry of raw['recentModels']) {
      if (!isRecord(entry)) continue;
      const { providerID, modelID, variant } = entry;
      if (typeof providerID !== 'string' || typeof modelID !== 'string') continue;
      recentModels.push({
        providerID,
        modelID,
        ...(typeof variant === 'string' ? { variant } : {}),
      });
    }
  }
  return { schemaVersion: 1, history, recentModels };
}

/** Bounds used when merging two snapshots written by different processes. */
export type MergeLimits = Readonly<{ historyLimit: number; recentLimit: number }>;

const defaultMergeLimits: MergeLimits = { historyLimit: 1_000, recentLimit: 20 };

/**
 * Merges two snapshots written by different processes. Entries from both sides are kept;
 * `ours` (the writer's in-memory snapshot) wins ordering conflicts because it is newer.
 */
export function mergeState(
  ours: LocalState,
  theirs: LocalState,
  limits: MergeLimits = defaultMergeLimits,
): LocalState {
  const historyKeys = new Set([...Object.keys(theirs.history), ...Object.keys(ours.history)]);
  const history: Record<string, string[]> = {};
  for (const key of historyKeys) {
    const theirsEntries = theirs.history[key] ?? [];
    const oursEntries = new Set(ours.history[key] ?? []);
    // Theirs keeps entries ours already has; ours re-appends them at the end (newest last).
    const kept = theirsEntries.filter((entry) => !oursEntries.has(entry));
    history[key] = [...kept, ...oursEntries].slice(-limits.historyLimit);
  }
  const seen = new Set<string>();
  const recentModels: ModelSelection[] = [];
  for (const entry of [...ours.recentModels, ...theirs.recentModels]) {
    const key = `${entry.providerID}/${entry.modelID}/${entry.variant ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recentModels.push(entry);
    if (recentModels.length >= limits.recentLimit) break;
  }
  return { schemaVersion: 1, history, recentModels };
}

// In-process serialization: saves to one path run one at a time, latest state wins per run.
const saveChains = new Map<string, Promise<void>>();
const noop = (): void => {};
let tempCounter = 0;

export type SaveResult = Readonly<{
  /** The snapshot actually written after merging with whatever was on disk. */
  state: LocalState;
  warning?: string;
}>;

const lockStaleMs = 10_000;
const lockRetryMs = 25;
const lockTimeoutMs = 5_000;

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + lockTimeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      return async () => {
        await handle.close();
        await rm(lockPath, { force: true });
      };
    } catch (cause) {
      if (!isRecord(cause) || cause['code'] !== 'EEXIST') throw cause;
      // Steal a stale lock left by a crashed process.
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > lockStaleMs) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // Lock vanished between checks; retry immediately.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the local state lock (${lockPath})`, {
          cause: cause,
        });
      }
      await Bun.sleep(lockRetryMs + Math.floor(Math.random() * lockRetryMs));
    }
  }
}

async function readForMerge(path: string): Promise<{ state: LocalState; warning?: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (isRecord(cause) && cause['code'] === 'ENOENT') return { state: emptyState };
    return { state: emptyState, warning: `Could not read local state for merge: ${String(cause)}` };
  }
  try {
    return { state: parseState(JSON.parse(text)) };
  } catch (cause) {
    // Never silently destroy what another process may have written: keep a backup.
    const backup = `${path}.corrupt-${Date.now()}`;
    await rename(path, backup).catch(() => {});
    return {
      state: emptyState,
      warning: `Local state was unreadable; moved aside to ${backup}: ${String(cause)}`,
    };
  }
}

/**
 * Concurrency-safe save: serialized per path in this process, cross-process lock file,
 * read-merge-write so distinct project histories from different processes survive, unique
 * temp name, atomic rename, restrictive permissions, errors thrown for the caller to surface.
 */
export async function saveState(
  path: string,
  state: LocalState,
  limits: MergeLimits = defaultMergeLimits,
): Promise<SaveResult> {
  const previous = saveChains.get(path) ?? Promise.resolve();
  let release: () => void = noop;
  const ours = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  saveChains.set(
    path,
    previous.then(() => ours),
  );
  await previous;
  try {
    await mkdir(dirname(path), { recursive: true });
    const lockPath = `${path}.lock`;
    const releaseLock = await acquireLock(lockPath);
    try {
      const disk = await readForMerge(path);
      const merged = mergeState(state, disk.state, limits);
      tempCounter += 1;
      const temp = `${path}.${process.pid}.${Date.now()}.${tempCounter}.tmp`;
      await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temp, path);
      const warning = disk.warning;
      return warning === undefined ? { state: merged } : { state: merged, warning };
    } finally {
      await releaseLock();
    }
  } finally {
    release();
    // Drop the map entry once the whole chain settles, so the map does not grow unbounded.
    const tail = saveChains.get(path);
    if (tail !== undefined) {
      void tail.then(() => {
        if (saveChains.get(path) === tail) saveChains.delete(path);
      });
    }
  }
}
