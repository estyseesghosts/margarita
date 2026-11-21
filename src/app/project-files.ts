import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

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

/** Work bounds for one scan. Every limit is deterministic except `timeMs`. */
export type ScanBudget = Readonly<{
  /** Maximum files returned. */
  files?: number;
  /** Maximum directories opened, so trees of empty folders terminate quickly. */
  directories?: number;
  /** Maximum directory entries examined across the whole scan. */
  entries?: number;
  /** Wall-clock budget in milliseconds. */
  timeMs?: number;
  /** Cancels the scan; a cancelled scan reports `aborted`. */
  signal?: AbortSignal;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}>;

export type ScanTruncation = 'files' | 'directories' | 'entries' | 'time' | 'aborted';

export type ScanResult = Readonly<{
  files: string[];
  /** Why the listing is incomplete; absent when the whole tree was covered. */
  truncated?: ScanTruncation;
  directoriesVisited: number;
  entriesExamined: number;
}>;

export const defaultScanBudget = {
  files: 5000,
  directories: 4000,
  entries: 100_000,
  timeMs: 2000,
} as const;

/**
 * Bounded breadth-first listing of project files for `@` completion. It stops on the first
 * exhausted bound (files, directories opened, entries examined, time) or on cancellation and
 * says which one, so a wide tree of empty folders cannot stall the composer and the caller can
 * tell the user the candidates are incomplete. The queue is walked with a cursor, never
 * `Array.shift`, so a large frontier costs O(1) per directory.
 */
export async function scanProjectFiles(root: string, budget: ScanBudget = {}): Promise<ScanResult> {
  const maxFiles = budget.files ?? defaultScanBudget.files;
  const maxDirectories = budget.directories ?? defaultScanBudget.directories;
  const maxEntries = budget.entries ?? defaultScanBudget.entries;
  const now = budget.now ?? Date.now;
  const deadline = now() + (budget.timeMs ?? defaultScanBudget.timeMs);
  const files: string[] = [];
  const queue: string[] = [root];
  let cursor = 0;
  let directoriesVisited = 0;
  let entriesExamined = 0;
  const finish = (truncated?: ScanTruncation): ScanResult => ({
    files,
    ...(truncated === undefined ? {} : { truncated }),
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
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue; // unreadable directories are skipped; this is best-effort completion
    }
    for (const entry of entries) {
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
