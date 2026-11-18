import { describe, expect, test } from 'bun:test';

import { diffCounts, editDiff, filetypeOf } from './edit-diff.ts';
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

test('filetypeOf maps extensions', () => {
  expect(filetypeOf('src/x.tsx')).toBe('typescript');
  expect(filetypeOf('Makefile')).toBeUndefined();
});
