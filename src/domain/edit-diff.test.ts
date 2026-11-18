import { describe, expect, test } from 'bun:test';

import {
  clampDiffPatch,
  diffCounts,
  diffPreviewBudget,
  editDiff,
  filetypeOf,
  hasOversizedDiff,
} from './edit-diff.ts';
import type { ToolCall } from './transcript.ts';

const call = (name: string, input: Record<string, unknown>, diff?: string): ToolCall => ({
  id: 't',
  name,
  status: 'completed',
  input,
  startedAt: 0,
  ...(diff === undefined ? {} : { diff }),
});

describe('editDiff', () => {
  test('prefers the server diff', () => {
    const result = editDiff(call('edit', { filePath: 'a.ts' }, '@@ -40,1 +40,1 @@\n-x\n+y'));
    expect(result?.diff).toContain('@@ -40,1');
    expect(result?.filetype).toBe('typescript');
  });

  test('synthesises a diff from old and new text', () => {
    const result = editDiff(call('edit', { filePath: 'a.py', oldString: 'a\nb', newString: 'c' }));
    expect(result?.diff).toBe('--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,1 @@\n-a\n-b\n+c');
    expect(diffCounts(result?.diff ?? '')).toEqual({ additions: 1, deletions: 2 });
  });

  test('shows a write as all additions', () => {
    const result = editDiff(call('write', { filePath: 'n.md', content: 'x\ny\n' }));
    expect(diffCounts(result?.diff ?? '')).toEqual({ additions: 2, deletions: 0 });
  });

  test('ignores other tools', () => {
    expect(editDiff(call('read', { filePath: 'a.ts' }))).toBeUndefined();
  });
});

function diffPatch(displayLines: number): string {
  return [
    '--- a/f.ts',
    '+++ b/f.ts',
    '@@ -1,1 +1,' + String(displayLines) + ' @@',
    ...Array.from({ length: displayLines }, (_, index) => `+row${index}`),
  ].join('\n');
}

describe('clampDiffPatch', () => {
  test('a three-line diff is shown completely', () => {
    const result = clampDiffPatch('@@ -1 +1 @@\n-old\n+new');
    expect(result.hidden).toBe(0);
    expect(result.shown).toHaveLength(3);
  });

  test('twenty-, one-hundred-forty- and one-thousand-line diffs clamp with counts', () => {
    for (const count of [20, 140, 1000]) {
      const result = clampDiffPatch(diffPatch(count));
      expect(result.shown).toHaveLength(diffPreviewBudget);
      expect(result.hidden).toBe(count + 3 - diffPreviewBudget);
    }
  });

  test('clipping never produces a malformed hunk; every shown line is intact', () => {
    const result = clampDiffPatch(diffPatch(100));
    for (const line of result.shown) expect(line.text).not.toContain('\n');
    expect(result.shown[0]?.text).toBe('--- a/f.ts');
  });

  test('hasOversizedDiff only for edit-like patches past the budget', () => {
    const big = call('write', { filePath: 'f.ts', content: 'x\n'.repeat(100) });
    const small = call('write', { filePath: 'f.ts', content: 'x' });
    expect(hasOversizedDiff(big)).toBe(true);
    expect(hasOversizedDiff(small)).toBe(false);
    expect(hasOversizedDiff(call('read', { filePath: 'f.ts' }))).toBe(false);
  });
});

test('filetypeOf maps extensions', () => {
  expect(filetypeOf('src/x.tsx')).toBe('typescript');
  expect(filetypeOf('Makefile')).toBeUndefined();
});
