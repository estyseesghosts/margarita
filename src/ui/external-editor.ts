import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliRenderer } from '@opentui/core';

import { strings } from '../i18n/index.ts';

/**
 * Line-ending policy for editor round trips (#158): CRLF is deliberately converted to LF, but
 * no content is removed — notably a trailing newline the user saved (or never touched).
 */
export function normalizeEditedText(edited: string): string {
  return edited.replace(/\r\n/g, '\n');
}

/**
 * Edits `text` in `$VISUAL`/`$EDITOR` with the renderer suspended. Resolves to the new
 * text, or `undefined` when the editor failed or no editor is configured.
 */
export async function editExternally(
  renderer: CliRenderer,
  text: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const editor = env['VISUAL'] ?? env['EDITOR'];
  if (editor === undefined || editor.trim() === '') {
    return { ok: false, message: strings.chrome.composer.externalEditorMissing };
  }
  const directory = await mkdtemp(join(tmpdir(), 'margarita-'));
  const file = join(directory, 'prompt.md');
  await writeFile(file, text, 'utf8');
  await renderer.suspend();
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(`${editor} "${file}"`, { stdio: 'inherit', shell: true });
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (code !== 0)
      return { ok: false, message: strings.chrome.composer.editorExited(String(code ?? 'signal')) };
    const edited = await readFile(file, 'utf8');
    return { ok: true, text: normalizeEditedText(edited) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await renderer.resume();
    await rm(directory, { recursive: true, force: true });
  }
}
