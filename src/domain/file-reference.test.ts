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
  test('plain prose and earlier-line mentions never scan the whole draft (#291)', () => {
    const prose = 'lorem ipsum '.repeat(5000);
    expect(activeMention(prose, prose.length)).toBeUndefined();
    expect(activeMention(`${prose}\nnext line`, prose.length + 5)).toBeUndefined();
    expect(activeMention(`@old\n${prose}`, prose.length + 5)).toBeUndefined();
    expect(activeMention(`${prose}\nnow @ne`, prose.length + 8)).toEqual({
      path: 'ne',
      start: prose.length + 5,
      end: prose.length + 8,
      text: '@ne',
    });
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

describe('sentence punctuation around mentions (#164)', () => {
  test('agent mentions followed by comma, period or parenthesis keep the bare name and span', () => {
    for (const text of [
      'Please ask @reviewer, then summarize',
      'Ask @reviewer. Done',
      'Ask (@reviewer) now',
      'Ask @reviewer; then continue',
    ]) {
      const mentions = findFileMentions(text);
      expect(mentions).toHaveLength(1);
      const mention = mentions[0]!;
      expect(mention.path).toBe('reviewer');
      expect(mention.text).toBe('@reviewer');
      expect(mention.start).toBe(text.indexOf('@'));
      expect(mention.end).toBe(text.indexOf('@') + '@reviewer'.length);
      expect(agentMentions(mentions, new Set(['reviewer']))).toEqual([mention]);
    }
  });

  test('file mentions drop trailing prose but keep line ranges and extensions', () => {
    const ranged = 'See @src/a.ts#20-45, please';
    const [mention] = findFileMentions(ranged);
    expect(mention?.path).toBe('src/a.ts');
    expect(mention?.range).toEqual({ start: 20, end: 45 });
    expect(mention?.text).toBe('@src/a.ts#20-45');
    expect(mention?.end).toBe(ranged.indexOf('@') + '@src/a.ts#20-45'.length);
    expect(findFileMentions('Read @src/main.ts, please')[0]?.path).toBe('src/main.ts');
    expect(findFileMentions('See @src/a.ts.')[0]?.path).toBe('src/a.ts');
  });

  test('quoted or backticked mentions keep intentional internal punctuation', () => {
    expect(findFileMentions('See `@src/a,b.ts` now')[0]?.path).toBe('src/a,b.ts');
    expect(findFileMentions('Open "@docs/a(b).md"')[0]?.path).toBe('docs/a(b).md');
  });

  test('emails and ordinary code snippets still produce no mentions', () => {
    expect(findFileMentions('mail me@x.com or a@b.com')).toEqual([]);
    expect(findFileMentions('use user@host for ssh')).toEqual([]);
    expect(findFileMentions('see a@b and c@d')).toEqual([]);
  });

  test('adjacent and mixed references preserve exact UTF-16 spans', () => {
    const text = '@reviewer, @src/a.ts; (@other)';
    const mentions = findFileMentions(text);
    expect(mentions.map((mention) => mention.path)).toEqual(['reviewer', 'src/a.ts', 'other']);
    for (const mention of mentions) {
      expect(text.slice(mention.start, mention.end)).toBe(mention.text);
    }
    expect(agentMentions(mentions, new Set(['reviewer', 'other'])).map((m) => m.path)).toEqual([
      'reviewer',
      'other',
    ]);
  });

  test('comma-adjacent references have independent spans and completion', () => {
    for (const text of [
      '@reviewer,@other',
      '(@reviewer,@other)',
      '😀 @reviewer,@src/a.ts#2-4,@C:\\work\\b.ts',
    ]) {
      const mentions = findFileMentions(text);
      const expected = text.includes('src/')
        ? ['reviewer', 'src/a.ts', 'C:\\work\\b.ts']
        : ['reviewer', 'other'];
      expect(mentions.map((mention) => mention.path)).toEqual(expected);
      for (const mention of mentions) {
        expect(text.slice(mention.start, mention.end)).toBe(mention.text);
      }
      if (text.includes('src/')) {
        expect(mentions[1]?.range).toEqual({ start: 2, end: 4 });
        expect(
          agentMentions(mentions, new Set(['reviewer', 'src/a.ts'])).map((m) => m.path),
        ).toEqual(['reviewer']);
      }
    }
    expect(activeMention('@reviewer,@oth', '@reviewer,@oth'.length)).toEqual({
      path: 'oth',
      start: 10,
      end: 14,
      text: '@oth',
    });
  });

  test('quoted commas and following punctuation remain separate from adjacent mentions', () => {
    const text = '😀 "@docs/a,b.md",@reviewer and `@src/x,y.ts`,@other';
    const mentions = findFileMentions(text);
    expect(mentions.map((mention) => mention.path)).toEqual([
      'docs/a,b.md',
      'reviewer',
      'src/x,y.ts',
      'other',
    ]);
    for (const mention of mentions) {
      expect(text.slice(mention.start, mention.end)).toBe(mention.text);
    }
    expect(findFileMentions('mail a@b.com,@reviewer')).toEqual([
      { path: 'reviewer', start: 13, end: 22, text: '@reviewer' },
    ]);
    expect(findFileMentions('punctuation @, and @.')).toEqual([]);
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

function expectSpan(text: string, path: string, count = 1) {
  const mentions = findFileMentions(text);
  expect(mentions).toHaveLength(count);
  const [mention] = mentions;
  expect(mention?.path).toBe(path);
  if (mention !== undefined) expect(text.slice(mention.start, mention.end)).toBe(mention.text);
  return mention;
}

describe('quoted mentions with spaces (#203)', () => {
  test('a quote before the @ may contain spaces, punctuation and Unicode', () => {
    expectSpan('read "@docs/design notes.md" please', 'docs/design notes.md');
    expectSpan('read `@docs/a (draft), v2.md`.', 'docs/a (draft), v2.md');
    expectSpan("open '@src/café menu.ts'", 'src/café menu.ts');
    expectSpan('😀 "@C:\\work\\my docs\\a b.md"', 'C:\\work\\my docs\\a b.md');
  });

  test('a quote after the @ delimits the path and an outside range suffix applies', () => {
    expectSpan('see @"docs/design notes.md" now', 'docs/design notes.md');
    const ranged = expectSpan('see @"docs/design notes.md"#2-4, ok', 'docs/design notes.md');
    expect(ranged?.range).toEqual({ start: 2, end: 4 });
    expect(ranged?.text).toBe('@"docs/design notes.md"#2-4');
    const inside = expectSpan('see "@docs/a b.md#10-12"', 'docs/a b.md');
    expect(inside?.range).toEqual({ start: 10, end: 12 });
  });

  test('adjacent agent and file mentions keep independent exact spans', () => {
    const text = '@reviewer,"@docs/design notes.md",@other';
    const mentions = findFileMentions(text);
    expect(mentions.map((mention) => mention.path)).toEqual([
      'reviewer',
      'docs/design notes.md',
      'other',
    ]);
    for (const mention of mentions) {
      expect(text.slice(mention.start, mention.end)).toBe(mention.text);
    }
  });

  test('unmatched or unbounded quotes never swallow the rest of the prompt', () => {
    expectSpan('say "@a.md and keep going', 'a.md');
    expect(findFileMentions('say "@a.md and "quoted" text')[0]?.path).toBe('a.md');
    expect(findFileMentions('say @"a.md and more')[0]?.path).toBe('"a.md');
    expect(findFileMentions('mail "me@x.com and you" ok')).toEqual([]);
  });

  test('completion follows the same grammar while typing', () => {
    const open = activeMention('open "@docs/design no', 'open "@docs/design no'.length);
    expect(open).toMatchObject({ path: 'docs/design no', start: 6 });
    const after = activeMention('open @"docs/design no', 'open @"docs/design no'.length);
    expect(after).toMatchObject({ path: 'docs/design no', start: 5 });
    expect(activeMention('line one\n"@a b', 'line one\n"@a b'.length)).toMatchObject({
      path: 'a b',
      start: 10,
    });
    // A bare partial still behaves as before.
    expect(activeMention('see @src/ap', 'see @src/ap'.length)?.path).toBe('src/ap');
  });
});
