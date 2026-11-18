import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliRenderer } from '@opentui/core';

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
    return { ok: false, message: 'Set $VISUAL or $EDITOR to edit prompts externally.' };
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
    if (code !== 0) return { ok: false, message: `Editor exited with code ${code ?? 'signal'}.` };
    const edited = await readFile(file, 'utf8');
    return { ok: true, text: edited.replace(/\r\n/g, '\n').replace(/\n$/, '') };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await renderer.resume();
    await rm(directory, { recursive: true, force: true });
  }
}
