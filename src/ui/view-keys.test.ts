import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Presentation code must not rebuild session identity from a bare `session.id`: every
 * per-session map is keyed by `sessionKey({serverID, sessionID})`, and two hosts can both
 * own `ses_same` (issue #78). This scans the UI and key-router sources so a later change
 * cannot quietly reintroduce an unqualified lookup.
 *
 * Allowed, because they are not lookups: the map is being *written* through a qualified key
 * built in the same expression (`[this.keyFor(...)]`, or a `key`/`...Key` variable).
 */
const uiRoot = join(import.meta.dir, '..', 'ui');
const keyRouter = join(import.meta.dir, '..', 'app', 'key-router.ts');

/** `state.<map>[session.id]` / `controller.state.<map>[session.id]` with a bare id. */
const bareLookup = /\bstate\.\w+\[\s*(?:session|current|view)\.id\s*\]/;
/** The same, through a locally destructured `sessionID`. */
const bareLocalLookup = /\b(?:state|\.state)\.\w+\[\s*sessionID\s*\]/;

async function sources(root: string): Promise<{ path: string; text: string }[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return sources(path);
      if (!entry.name.endsWith('.tsx') && !entry.name.endsWith('.ts')) return [];
      return [{ path, text: await readFile(path, 'utf8') }];
    }),
  );
  return files.flat();
}

function offenders(text: string): string[] {
  return text.split('\n').flatMap((line, index) => {
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return [];
    const flagged = bareLookup.test(line) || bareLocalLookup.test(line);
    return flagged ? [`${index + 1}: ${line.trim()}`] : [];
  });
}

describe('no unqualified session lookups in presentation code (issue #78)', () => {
  test('UI sources read per-session state through server-qualified keys', async () => {
    const all = [
      ...(await sources(uiRoot)),
      { path: keyRouter, text: await readFile(keyRouter, 'utf8') },
    ];
    const found = all.flatMap((file) => {
      // Tests are allowed to poke raw state directly; they are asserting storage.
      if (file.path.includes('.test.')) return [];
      return offenders(file.text).map((line) => `${file.path}: ${line}`);
    });
    expect(found).toEqual([]);
  });

  test('the scanner detects a deliberate bare lookup', () => {
    expect(offenders('const inbox = state.inbox[session.id] ?? [];')).toHaveLength(1);
    expect(offenders('const queued = controller.state.inbox[view.id];')).toHaveLength(1);
    // Qualified spellings are not flagged.
    expect(offenders('const inbox = state.inbox[view.key] ?? [];')).toEqual([]);
    expect(offenders('const inbox = state.inbox[key] ?? [];')).toEqual([]);
    expect(offenders('const key = this.keyFor(serverID, sessionID);')).toEqual([]);
  });
});
