import { describe, expect, test } from 'bun:test';

import { activeMention, findFileMentions, rankPaths } from './file-reference.ts';

describe('file references', () => {
  test('finds mentions with ranges and ignores emails', () => {
    expect(findFileMentions('look at @src/a.ts and mail me@x.com @b')).toEqual([
      { path: 'src/a.ts', start: 8, end: 17, text: '@src/a.ts' },
      { path: 'b', start: 36, end: 38, text: '@b' },
    ]);
  });
  test('detects the mention being typed at the cursor', () => {
    expect(activeMention('see @sr', 7)).toEqual({ path: 'sr', start: 4, end: 7, text: '@sr' });
    expect(activeMention('see @src done', 13)).toBeUndefined();
    expect(activeMention('a@b', 3)).toBeUndefined();
  });
  test('ranks prefix, basename, then substring matches', () => {
    const paths = ['docs/app.md', 'src/app.ts', 'app.ts', 'src/main.ts'];
    expect(rankPaths(paths, 'app', 10)).toEqual(['app.ts', 'src/app.ts', 'docs/app.md']);
    expect(rankPaths(paths, 'src/', 1)).toEqual(['src/app.ts']);
  });
});
