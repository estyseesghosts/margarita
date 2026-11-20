import { describe, expect, test } from 'bun:test';

import {
  activeMention,
  agentMentions,
  findFileMentions,
  parseMentionPath,
  rankPaths,
  withLineRange,
} from './file-reference.ts';

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

describe('line-range mention syntax (issue #98)', () => {
  test('parses a valid one-based range and preserves the original span', () => {
    expect(parseMentionPath('src/app.ts#20-45')).toEqual({
      path: 'src/app.ts',
      range: { start: 20, end: 45 },
    });
    const [mention] = findFileMentions('see @src/app.ts#20-45 now');
    expect(mention?.path).toBe('src/app.ts');
    expect(mention?.text).toBe('@src/app.ts#20-45');
    expect(mention?.range).toEqual({ start: 20, end: 45 });
    expect(mention?.end).toBe('see @src/app.ts#20-45'.length);
  });

  test('rejects invalid ranges without mangling the token', () => {
    for (const raw of ['a.ts#0-5', 'a.ts#10-5', 'a.ts#x-y']) {
      expect(parseMentionPath(raw).range).toBeUndefined();
    }
    expect(parseMentionPath('a.ts#0-5')).toMatchObject({
      path: 'a.ts#0-5',
      rangeError: expect.any(String),
    });
    // A non-range `#` suffix stays part of the filename, as on POSIX.
    expect(parseMentionPath('a.ts#heading')).toEqual({ path: 'a.ts#heading' });
  });

  test('appends start/end query parameters without a fragment in the path', () => {
    expect(withLineRange('file:///work/a.ts', { start: 20, end: 45 })).toBe(
      'file:///work/a.ts?start=20&end=45',
    );
    expect(withLineRange('file:///work/a.ts?x=1', { start: 2, end: 3 })).toBe(
      'file:///work/a.ts?x=1&start=2&end=3',
    );
    expect(withLineRange('file:///work/a.ts', undefined)).toBe('file:///work/a.ts');
  });
});

describe('agent mention classification (issue #99)', () => {
  test('only bare names present in the scoped catalog are agents', () => {
    const mentions = findFileMentions('@reviewer @src/a.ts @unknown review@x.com');
    const agents = agentMentions(mentions, new Set(['reviewer', 'unknown']));
    expect(agents.map((mention) => mention.path)).toEqual(['reviewer', 'unknown']);
  });

  test('paths, scoped ranges and file-like names are never agents', () => {
    const mentions = findFileMentions('@src/a.ts @./local @a.ts#2-4');
    expect(agentMentions(mentions, new Set(['src/a.ts', 'a.ts', './local']))).toEqual([]);
  });
});
