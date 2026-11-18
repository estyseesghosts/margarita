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

/**
 * Bounded breadth-first listing of project files for `@` completion. Stops after
 * `limit` entries so huge repositories cannot stall the composer.
 */
export async function listProjectFiles(root: string, limit = 5000): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0 && files.length < limit) {
    const directory = queue.shift();
    if (directory === undefined) break;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue; // unreadable directories are skipped; this is best-effort completion
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
      if (files.length >= limit) break;
    }
  }
  return files;
}
