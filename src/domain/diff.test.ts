import { describe, expect, test } from 'bun:test';

import {
  diffBodyRows,
  diffFrameHeight,
  diffSummary,
  diffWindowRows,
  type FileDiff,
  patchLines,
  patchLinesFor,
  turnStart,
} from './diff.ts';

const file = (additions: number, deletions: number): FileDiff => ({
  file: 'a.ts',
  patch: '',
  additions,
  deletions,
  status: 'modified',
  truncated: false,
});

describe('diff', () => {
  test('classifies unified diff lines and strips escape sequences', () => {
    const lines = patchLines(
      '--- a/x\r\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new \u001b[31mred\n\\ No newline\n',
    );
    expect(lines.map((line) => line.kind)).toEqual([
      'meta',
      'meta',
      'hunk',
      'context',
      'del',
      'add',
      'meta',
    ]);
    expect(lines[5]?.text).not.toContain('\u001b');
  });

  test('summaries count files and lines', () => {
    expect(diffSummary([])).toBe('No changes');
    expect(diffSummary([file(3, 1)])).toBe('1 file · +3 −1');
    expect(diffSummary([file(3, 1), file(2, 0)])).toBe('2 files · +5 −1');
  });

  test('formatted patch lines are cached per file identity (#276)', () => {
    const first = { ...file(1, 1), patch: '@@ -1 +1 @@\n-old\n+new' };
    const second = { ...file(1, 1), patch: '@@ -1 +1 @@\n-old\n+new' };
    expect(patchLinesFor(first)).toBe(patchLinesFor(first));
    expect(patchLinesFor(first)).not.toBe(patchLinesFor(second));
    expect(patchLinesFor(first).map((line) => line.kind)).toEqual(['hunk', 'del', 'add']);
  });

  test('viewport rows reserve the frame, title and position footer (#276)', () => {
    expect(diffFrameHeight(40)).toBe(35);
    expect(diffBodyRows(40)).toBe(33);
    expect(diffWindowRows(40)).toBe(32);
    // Short terminals keep at least one paint row instead of a negative window.
    expect(diffFrameHeight(12)).toBe(7);
    expect(diffBodyRows(12)).toBe(5);
    expect(diffWindowRows(12)).toBe(4);
    // The shared frame floors at six rows, so even a degenerate terminal gets paint rows.
    expect(diffWindowRows(1)).toBe(3);
  });

  test('a turn starts at the latest user message', () => {
    expect(
      turnStart([
        { kind: 'user', id: 'm1' },
        { kind: 'assistant', id: 'm2' },
        { kind: 'user', id: 'm3' },
        { kind: 'assistant', id: 'm4' },
      ]),
    ).toBe('m3');
    expect(turnStart([{ kind: 'assistant', id: 'm1' }])).toBeUndefined();
  });
});
