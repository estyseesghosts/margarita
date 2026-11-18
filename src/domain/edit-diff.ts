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
  const path = text(tool.input['filePath']) ?? text(tool.input['path']);
  if (path === undefined) return undefined;
  const filetype = filetypeOf(path);
  if (tool.diff !== undefined && tool.diff.trim() !== '') return { diff: tool.diff, filetype };
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
