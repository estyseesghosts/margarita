/**
 * Helper process for the cross-process persistence test: appends `count` history entries for
 * one project key through the real save path, or (mode `hold`) takes the state lock and sits.
 * Usage: bun state-writer.ts <state-file> <project-key> <count> [hold]
 */
import { acquireFileLock } from '../../src/config/file-lock.ts';
import { emptyState, saveState } from '../../src/config/local-state.ts';

const [path, key, countText, mode] = process.argv.slice(2);
if (path === undefined || key === undefined || countText === undefined) process.exit(2);

if (mode === 'hold') {
  await acquireFileLock(`${path}.lock`);
  await Bun.sleep(60_000);
} else {
  const entries: string[] = [];
  for (let index = 0; index < Number(countText); index += 1) {
    entries.push(`${key}-${index}`);
    await saveState(path, { ...emptyState, history: { [key]: [...entries] } });
  }
}
