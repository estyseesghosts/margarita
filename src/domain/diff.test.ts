import { describe, expect, test } from 'bun:test';

import { diffSummary, type FileDiff, patchLines, turnStart } from './diff.ts';

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
