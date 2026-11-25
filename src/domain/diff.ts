import { strings } from '../i18n/index.ts';
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

// The dialog re-renders on every scroll key, but a file's patch text never changes. Keep
// the formatted lines with the `FileDiff` identity so paging slices instead of re-splitting
// and re-sanitizing thousands of lines (#276). A WeakMap follows overlay snapshots without
// retaining old sessions.
const patchLineCache = new WeakMap<FileDiff, readonly PatchLine[]>();

/** Cached form of {@link patchLines} for one server-reported file. */
export function patchLinesFor(file: FileDiff): readonly PatchLine[] {
  const cached = patchLineCache.get(file);
  if (cached !== undefined) return cached;
  const lines = patchLines(file.patch);
  patchLineCache.set(file, lines);
  return lines;
}

/**
 * Outer height budget for the diff dialog. This mirrors the shared overlay frame
 * (`height - 5`, floor 6) so key paging and the rendered window never disagree (#276).
 */
export function diffFrameHeight(terminalHeight: number): number {
  return Math.max(6, Math.floor(terminalHeight) - 5);
}

/** Inner rows after the rounded border/title. */
export function diffBodyRows(terminalHeight: number): number {
  return Math.max(1, diffFrameHeight(terminalHeight) - 2);
}

/**
 * Rows available to one file-list page or patch page. One inner row is reserved for the
 * position/count footer, keeping totals and server truncation visible on short terminals.
 */
export function diffWindowRows(terminalHeight: number): number {
  return Math.max(1, diffBodyRows(terminalHeight) - 1);
}

/** `3 files · +12 −4`, or `No changes`. */
export function diffSummary(files: readonly FileDiff[]): string {
  if (files.length === 0) return strings.overlays.diff.noChanges;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return strings.overlays.diff.summary(files.length, additions, deletions);
}

/** The message ID a `turn` diff starts from: the latest user message. */
export function turnStart(messages: readonly { kind: string; id: string }[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === 'user') return message.id;
  }
  return undefined;
}
