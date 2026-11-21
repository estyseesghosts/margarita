import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { osc52Clipboard } from '../domain/osc52.ts';

export type CopyOutcome = Readonly<{ method: 'clipboard' | 'file'; path?: string }>;

export type CopyEnvironment = Readonly<{
  term: string | undefined;
  isTTY: boolean;
  /** Receives the escape sequence; only called when a real terminal can take it. */
  write: (sequence: string) => void;
  stateDir: string;
  pid: number;
}>;

/**
 * Copies via one OSC 52 set sequence when a terminal can receive it and the payload fits the
 * explicit limit; otherwise writes the exact text to a client-local file and reports its path.
 * An emitted sequence is not an acknowledgement (terminals may filter OSC 52), which is why the
 * caller words the notice accordingly. The fallback file is created owner-only from the start,
 * so private text is never briefly readable by others, and never printed as raw escape data.
 */
export async function copyToClipboard(text: string, env: CopyEnvironment): Promise<CopyOutcome> {
  const sequence = env.term !== 'dumb' && env.isTTY ? osc52Clipboard(text) : undefined;
  if (sequence !== undefined) {
    env.write(sequence);
    return { method: 'clipboard' };
  }
  await mkdir(env.stateDir, { recursive: true });
  const path = join(env.stateDir, `marg-copy-${env.pid}-${randomUUID()}.txt`);
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Filesystems without POSIX permission bits still keep the exact bytes; report the path.
  }
  return { method: 'file', path };
}
