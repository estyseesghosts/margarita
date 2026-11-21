import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isRecord } from '../domain/backend-event.ts';
import type { ModelSelection } from '../domain/model-ref.ts';
import { acquireFileLock } from './file-lock.ts';
import {
  declaredVersion,
  IncompatibleSchemaError,
  isIncompatibleVersion,
  supportedSchemaVersion,
} from './schema-guard.ts';

/** Frontend-only presentation state. Session history is never stored here. */
export type LocalState = Readonly<{
  schemaVersion: 1;
  /** Prompt history keyed by canonical project directory key. */
  history: Readonly<Record<string, readonly string[]>>;
  recentModels: readonly ModelSelection[];
}>;

export const emptyState: LocalState = { schemaVersion: 1, history: {}, recentModels: [] };

export type LoadStateResult = Readonly<{
  state: LocalState;
  warning?: string;
  /** The file exists but uses a schema this build cannot write; it was left untouched. */
  incompatible?: { path: string; version: unknown };
}>;

/** Moves an unreadable file aside instead of resetting it in place. */
async function preserveUnreadable(path: string): Promise<string> {
  const backup = `${path}.corrupt-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  await rename(path, backup).catch(() => {});
  return backup;
}

export async function loadState(path: string): Promise<LoadStateResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (isRecord(cause) && cause['code'] === 'ENOENT') return { state: emptyState };
    return { state: emptyState, warning: `Could not read local state: ${String(cause)}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    const backup = await preserveUnreadable(path);
    return {
      state: emptyState,
      warning: `Local state was unreadable; the original was preserved at ${backup}. ${String(cause)}`,
    };
  }
  if (isIncompatibleVersion(raw)) {
    const error = new IncompatibleSchemaError({
      path,
      version: declaredVersion(raw),
      supported: supportedSchemaVersion,
    });
    return {
      state: emptyState,
      warning: error.message,
      incompatible: { path, version: declaredVersion(raw) },
    };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    const backup = await preserveUnreadable(path);
    return {
      state: emptyState,
      warning: `Local state was unreadable; the original was preserved at ${backup}.`,
    };
  }
  return { state: parseState(raw) };
}

export function parseState(raw: unknown): LocalState {
  if (!isRecord(raw)) return emptyState;
  if (isIncompatibleVersion(raw)) {
    throw new IncompatibleSchemaError({
      path: '(parsed state)',
      version: declaredVersion(raw),
      supported: supportedSchemaVersion,
    });
  }
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

const lockRetryMs = 25;
const lockTimeoutMs = 5_000;

async function readForMerge(path: string): Promise<{ state: LocalState; warning?: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (isRecord(cause) && cause['code'] === 'ENOENT') return { state: emptyState };
    return { state: emptyState, warning: `Could not read local state for merge: ${String(cause)}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    // Never silently destroy what another process may have written: keep a backup.
    const backup = await preserveUnreadable(path);
    return {
      state: emptyState,
      warning: `Local state was unreadable; the original was preserved at ${backup}: ${String(cause)}`,
    };
  }
  // A newer schema on disk is a hard stop: a save must never downgrade it to v1 (#150).
  if (isIncompatibleVersion(raw)) {
    throw new IncompatibleSchemaError({
      path,
      version: declaredVersion(raw),
      supported: supportedSchemaVersion,
    });
  }
  return { state: parseState(raw) };
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
    const lock = await acquireFileLock(lockPath, {
      timeoutMs: lockTimeoutMs,
      retryMs: lockRetryMs,
    });
    try {
      const disk = await readForMerge(path);
      const merged = mergeState(state, disk.state, limits);
      tempCounter += 1;
      const temp = `${path}.${process.pid}.${lock.token}.${Date.now()}.${tempCounter}.tmp`;
      await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temp, path);
      const warning = disk.warning;
      return warning === undefined ? { state: merged } : { state: merged, warning };
    } finally {
      await lock.release();
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
