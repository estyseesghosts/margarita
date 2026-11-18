import { type PatchLine, patchLines } from './diff.ts';
import type { ToolCall } from './transcript.ts';

export type EditDiff = Readonly<{ diff: string; filetype: string | undefined }>;

const extensionTypes: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  zig: 'zig',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  html: 'html',
  css: 'css',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'bash',
};

/** Language name for syntax highlighting, from the file extension. */
export function filetypeOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? undefined : extensionTypes[path.slice(dot + 1).toLowerCase()];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The file path an edit-like call claims to have touched, from input or server metadata. */
export function toolPath(tool: ToolCall): string | undefined {
  for (const key of ['filePath', 'path', 'file', 'fileName']) {
    const value = text(tool.input[key]);
    if (value !== undefined && value !== '') return value;
  }
  return tool.diffFile;
}

/** Edit-like tools (a successful call mutates the worktree) come from the tool names map. */
export function isEditLike(tool: ToolCall): boolean {
  const name = tool.name.toLowerCase();
  return (
    name === 'edit' ||
    name === 'write' ||
    name === 'patch' ||
    name === 'apply_patch' ||
    name === 'multiedit' ||
    name === 'replace'
  );
}

function lines(value: string): string[] {
  const split = value.replace(/\r\n?/g, '\n').split('\n');
  if (split.at(-1) === '') split.pop();
  return split;
}

/**
 * A unified diff for an edit-like tool call. Prefers the server's own diff (real
 * file line numbers); otherwise synthesises one from the old and new text, where
 * numbering starts at 1 because the file's position is unknown.
 */
export function editDiff(tool: ToolCall): EditDiff | undefined {
  const path = toolPath(tool);
  const filetype = filetypeOf(path ?? '');
  if (tool.diff !== undefined && tool.diff.trim() !== '') return { diff: tool.diff, filetype };
  // The OpenCode patch tool carries the patch text as input.patchText (it is the unified
  // diff the server applies, or already applied).
  const patchText = text(tool.input['patchText']);
  if (patchText !== undefined && patchText.trim() !== '') {
    return { diff: patchText, filetype };
  }
  if (path === undefined) return undefined;
  const oldText = text(tool.input['oldString']);
  const newText = text(tool.input['newString']);
  if (oldText !== undefined && newText !== undefined) {
    return { diff: unified(path, lines(oldText), lines(newText)), filetype };
  }
  const content = text(tool.input['content']);
  if (tool.name === 'write' && content !== undefined) {
    return { diff: unified(path, [], lines(content)), filetype };
  }
  return undefined;
}

function unified(path: string, removed: readonly string[], added: readonly string[]): string {
  const head = `--- a/${path}\n+++ b/${path}\n@@ -${removed.length === 0 ? 0 : 1},${removed.length} +${added.length === 0 ? 0 : 1},${added.length} @@`;
  return [head, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join(
    '\n',
  );
}

/** `+18 −7` counts for a unified diff. */
export function diffCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

/** Display-line budget for an inline patch in compact mode (fits small terminals). */
export const diffPreviewBudget = 16;

export type DiffPreview = Readonly<{
  /** The first `budget` display lines, unparsed for safe clipping. */
  shown: readonly PatchLine[];
  /** How many display lines are hidden behind the expand control. */
  hidden: number;
}>;

/**
 * Explicit display-line clipping of a patch for compact rendering. Never feeds a
 * truncated patch back into a unified-diff parser; callers render `shown` verbatim.
 */
export function clampDiffPatch(patch: string, budget: number = diffPreviewBudget): DiffPreview {
  const clipped = patchLines(patch);
  if (clipped.length <= budget) return { shown: clipped, hidden: 0 };
  return { shown: clipped.slice(0, budget), hidden: clipped.length - budget };
}

/** True when an edit-like tool's patch exceeds the compact-mode preview budget. */
export function hasOversizedDiff(tool: ToolCall, budget: number = diffPreviewBudget): boolean {
  const edit = editDiff(tool);
  if (edit === undefined) return false;
  return patchLines(edit.diff).length > budget;
}
