import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

type ReadDirectory = (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;

const ignored = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.next',
  'coverage',
  '.venv',
  '__pycache__',
]);

/** Representative diagnostic for an unreadable directory, with the root-relative path. */
export interface ScanUnreadableSample {
  path: string;
  /** Filesystem error code such as `EACCES`; the raw message is not retained (it may be absolute). */
  code: string;
}

export interface ScanUnreadable {
  count: number;
  /** At most a few samples, so a directory tree full of denials cannot flood logs or notices. */
  samples: ScanUnreadableSample[];
}

/** Work bounds for one scan. Every limit is deterministic except `timeMs`. */
export type ScanBudget = Readonly<{
  /** Maximum files returned. */
  files?: number;
  /** Maximum directories opened, so trees of empty folders terminate quickly. */
  directories?: number;
  /** Maximum directory entries examined across the whole scan. */
  entries?: number;
  /**
   * Wall-clock budget in milliseconds. Node cannot cancel an in-flight directory read, so the
   * scan stops waiting at the deadline and reports `time`; the abandoned read cannot mutate the
   * returned result.
   */
  timeMs?: number;
  /** Cancels the scan; a cancelled scan reports `aborted`. */
  signal?: AbortSignal;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable directory reader for failure and latency tests. */
  readdir?: ReadDirectory;
}>;

export type ScanTruncation = 'files' | 'directories' | 'entries' | 'time' | 'aborted';

export type ScanResult = Readonly<{
  files: string[];
  /** Why a bound stopped the listing; absent when every readable directory was covered. */
  truncated?: ScanTruncation;
  /** True when a bound stopped the scan or at least one directory could not be read. */
  incomplete: boolean;
  unreadable: ScanUnreadable;
  directoriesVisited: number;
  entriesExamined: number;
}>;

export const defaultScanBudget = {
  files: 5000,
  directories: 4000,
  entries: 100_000,
  timeMs: 2000,
} as const;

const unreadableSampleLimit = 3;

type ReadOutcome =
  | { kind: 'entries'; entries: Dirent[] }
  | { kind: 'error'; error: unknown }
  | { kind: 'time' }
  | { kind: 'aborted' };

/**
 * Reads one directory while honouring the scan deadline and cancellation. `readdir` itself
 * cannot be aborted, but racing it lets the scan stop waiting and return best-effort results;
 * the abandoned promise is handled so it can never reject unhandled or mutate the result.
 */
async function readDirectory(
  reader: ReadDirectory,
  directory: string,
  signal: AbortSignal | undefined,
  deadline: number,
  now: () => number,
): Promise<ReadOutcome> {
  if (signal?.aborted === true) return { kind: 'aborted' };
  const remaining = deadline - now();
  if (remaining <= 0) return { kind: 'time' };
  const read = reader(directory, { withFileTypes: true }).then(
    (entries): ReadOutcome => ({ kind: 'entries', entries }),
    (error: unknown): ReadOutcome => ({ kind: 'error', error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupt = new Promise<ReadOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'time' }), remaining);
    if (signal !== undefined) {
      onAbort = () => resolve({ kind: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([read, interrupt]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/** Filesystem codes are safe to retain; messages can contain absolute or personal paths. */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'UNKNOWN';
}

/**
 * Bounded breadth-first listing of project files for `@` completion. It stops on the first
 * exhausted bound (files, directories opened, entries examined, time) or on cancellation and
 * says which one, so a wide tree of empty folders cannot stall the composer and the caller can
 * tell the user the candidates are incomplete. Unreadable subtrees are skipped and reported
 * separately, so their contents are never mistaken for an empty directory. The queue is walked
 * with a cursor, never `Array.shift`, so a large frontier costs O(1) per directory.
 */
export async function scanProjectFiles(root: string, budget: ScanBudget = {}): Promise<ScanResult> {
  const maxFiles = budget.files ?? defaultScanBudget.files;
  const maxDirectories = budget.directories ?? defaultScanBudget.directories;
  const maxEntries = budget.entries ?? defaultScanBudget.entries;
  const now = budget.now ?? Date.now;
  const reader = budget.readdir ?? readdir;
  const deadline = now() + (budget.timeMs ?? defaultScanBudget.timeMs);
  const files: string[] = [];
  const unreadableSamples: ScanUnreadableSample[] = [];
  const queue: string[] = [root];
  let cursor = 0;
  let directoriesVisited = 0;
  let entriesExamined = 0;
  let unreadableCount = 0;
  const finish = (truncated?: ScanTruncation): ScanResult => ({
    files,
    ...(truncated === undefined ? {} : { truncated }),
    incomplete: truncated !== undefined || unreadableCount > 0,
    unreadable: { count: unreadableCount, samples: unreadableSamples },
    directoriesVisited,
    entriesExamined,
  });
  while (cursor < queue.length) {
    if (budget.signal?.aborted === true) return finish('aborted');
    if (files.length >= maxFiles) return finish('files');
    if (directoriesVisited >= maxDirectories) return finish('directories');
    if (entriesExamined >= maxEntries) return finish('entries');
    if (now() >= deadline) return finish('time');
    const directory = queue[cursor];
    queue[cursor] = ''; // release the string; the slot is never revisited
    cursor += 1;
    if (directory === undefined) break;
    directoriesVisited += 1;
    const outcome = await readDirectory(reader, directory, budget.signal, deadline, now);
    if (outcome.kind === 'aborted') return finish('aborted');
    if (outcome.kind === 'time') return finish('time');
    if (outcome.kind === 'error') {
      unreadableCount += 1;
      if (unreadableSamples.length < unreadableSampleLimit) {
        unreadableSamples.push({
          path: relative(root, directory).replaceAll('\\', '/') || '.',
          code: errorCode(outcome.error),
        });
      }
      continue;
    }
    // A read that finished after the deadline is not used, even when the timer lost the race.
    if (now() >= deadline) return finish('time');
    for (const entry of outcome.entries) {
      entriesExamined += 1;
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
      if (files.length >= maxFiles) return finish('files');
      if (entriesExamined >= maxEntries) return finish('entries');
    }
  }
  return finish();
}

/** Compatibility wrapper: the file list alone, under the default bounds. */
export async function listProjectFiles(
  root: string,
  limit: number = defaultScanBudget.files,
): Promise<string[]> {
  return (await scanProjectFiles(root, { files: limit })).files;
}
