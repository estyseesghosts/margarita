import { sanitizeTerminalText } from './sanitize-text.ts';

/** One file's change as reported by `session.diff` (structured, never re-derived). */
export type FileDiff = Readonly<{
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: 'added' | 'deleted' | 'modified';
  /** The server truncated this patch. */
  truncated: boolean;
}>;

/** `session` covers the whole session; `turn` starts at the latest user message. */
export type DiffScope = 'session' | 'turn';

export type PatchLine = Readonly<{
  kind: 'add' | 'del' | 'hunk' | 'meta' | 'context';
  text: string;
}>;

/** Classifies unified-diff lines for colouring; text is sanitized for the terminal. */
export function patchLines(patch: string): PatchLine[] {
  const lines = patch.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => {
    const text = sanitizeTerminalText(line);
    if (line.startsWith('@@')) return { kind: 'hunk', text };
    if (
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('\\')
    ) {
      return { kind: 'meta', text };
    }
    if (line.startsWith('+')) return { kind: 'add', text };
    if (line.startsWith('-')) return { kind: 'del', text };
    return { kind: 'context', text };
  });
}

/** `3 files · +12 −4`, or `No changes`. */
export function diffSummary(files: readonly FileDiff[]): string {
  if (files.length === 0) return 'No changes';
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return `${files.length} file${files.length === 1 ? '' : 's'} · +${additions} −${deletions}`;
}

/** The message ID a `turn` diff starts from: the latest user message. */
export function turnStart(messages: readonly { kind: string; id: string }[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === 'user') return message.id;
  }
  return undefined;
}
