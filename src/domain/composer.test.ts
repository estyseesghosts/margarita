import { describe, expect, test } from 'bun:test';

import {
  caretPaint,
  composerFrom,
  cursorPosition,
  deleteBackward,
  deleteForward,
  deletePreviousWhitespaceUnit,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBackward,
  deleteWordForward,
  emptyComposer,
  insertText,
  leftOpensOverview,
  moveLeft,
  moveLineStart,
  moveVertical,
  moveWordLeft,
  moveWordRight,
} from './composer.ts';
import { actionFor, buildKeymap, parseBinding } from './keymap.ts';
import {
  createHistory,
  historyBack,
  historyForward,
  recordEntry,
  searchHistory,
} from './prompt-history.ts';
import { completeCommand, parseInput } from './slash-command.ts';

const noBlockers = { modalOpen: false, completionOpen: false, shellMode: false };

describe('composer editing', () => {
  test('backspace removes a whole emoji / combining sequence', () => {
    expect(deleteBackward(composerFrom('a👨‍👩‍👧')).text).toBe('a');
    expect(deleteBackward(composerFrom('éé')).text).toBe('é');
  });
  test('left moves over a whole grapheme', () => {
    expect(moveLeft(composerFrom('x🐱')).cursor).toBe(1);
  });
  test('insert normalizes CRLF', () => {
    expect(insertText(emptyComposer, 'a\r\nb').text).toBe('a\nb');
  });
  test('delete forward at end is a no-op', () => {
    expect(deleteForward(composerFrom('ab'))).toEqual(composerFrom('ab'));
  });
  test('vertical moves keep the column and report boundaries', () => {
    const start = composerFrom('hello\nhi');
    const up = moveVertical(start, -1);
    expect(up?.cursor).toBe(2);
    expect(moveVertical(start, 1)).toBeUndefined();
    expect(moveVertical({ text: 'one', cursor: 1 }, -1)).toBeUndefined();
  });
  test('word motions and kills', () => {
    expect(moveWordLeft(composerFrom('fix the bug')).cursor).toBe(8);
    expect(deleteWordBackward(composerFrom('fix the bug')).text).toBe('fix the ');
    expect(deleteToLineStart(composerFrom('a\nbc')).text).toBe('a\n');
    expect(deleteToLineEnd(moveLineStart(composerFrom('ab\ncd'))).text).toBe('ab\n');
  });
  test('word operations stay on grapheme boundaries across scripts and emoji', () => {
    const text = 'e\u0301 🧑🏽‍💻 𐐀中 العربية/src';
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const points = [
      0,
      ...Array.from(segmenter.segment(text), (part) => part.index + part.segment.length),
    ];
    for (const cursor of points) {
      const composer = { text, cursor };
      expect(points).toContain(moveWordLeft(composer).cursor);
      expect(points).toContain(moveWordRight(composer).cursor);
      const deleted = deleteWordBackward(composer);
      expect(points).toContain(deleted.cursor);
      expect(deleted.text.isWellFormed()).toBe(true);
      const forward = deleteWordForward(composer);
      expect(points).toContain(forward.cursor);
      expect(forward.text.isWellFormed()).toBe(true);
    }
  });
  test('whitespace deletion and word deletion use distinct boundaries', () => {
    expect(deletePreviousWhitespaceUnit(composerFrom('run src/utils/file.ts')).text).toBe('run ');
    expect(deleteWordBackward(composerFrom('run src/utils/file.ts')).text).toBe(
      'run src/utils/file.',
    );
    expect(deletePreviousWhitespaceUnit(composerFrom('run --flag=value  ')).text).toBe('run ');
    expect(deletePreviousWhitespaceUnit(composerFrom('one\ntwo')).text).toBe('one\n');
    expect(deletePreviousWhitespaceUnit({ text: 'one\ntwo', cursor: 4 }).text).toBe('two');
    expect(deletePreviousWhitespaceUnit({ text: 'abc', cursor: 0 }).text).toBe('abc');
  });
  test('cursor position reports line and column', () => {
    expect(cursorPosition(composerFrom('ab\ncde'))).toEqual({ line: 1, column: 3 });
  });
});

describe('guarded Left', () => {
  test('only an empty, unblocked composer opens the overview', () => {
    expect(leftOpensOverview(emptyComposer, noBlockers)).toBe(true);
  });
  test('cursor at start of a non-empty draft does not navigate', () => {
    expect(leftOpensOverview({ text: 'draft', cursor: 0 }, noBlockers)).toBe(false);
  });
  test('modal, completion and shell mode block navigation', () => {
    expect(leftOpensOverview(emptyComposer, { ...noBlockers, modalOpen: true })).toBe(false);
    expect(leftOpensOverview(emptyComposer, { ...noBlockers, completionOpen: true })).toBe(false);
    expect(leftOpensOverview(emptyComposer, { ...noBlockers, shellMode: true })).toBe(false);
  });
});

describe('prompt history', () => {
  test('browsing back and forward restores the in-progress draft', () => {
    let history = recordEntry(recordEntry(createHistory([]), 'first', 10), 'second', 10);
    const back1 = historyBack(history, 'draft');
    expect(back1?.text).toBe('second');
    history = back1?.history ?? history;
    const back2 = historyBack(history, 'ignored');
    expect(back2?.text).toBe('first');
    history = back2?.history ?? history;
    expect(historyBack(history, '')).toBeUndefined();
    const forward1 = historyForward(history);
    expect(forward1?.text).toBe('second');
    const forward2 = historyForward(forward1?.history ?? history);
    expect(forward2?.text).toBe('draft');
  });
  test('duplicates move to the end and the limit applies', () => {
    const history = ['a', 'b', 'a', 'c'].reduce(
      (acc, entry) => recordEntry(acc, entry, 2),
      createHistory([]),
    );
    expect(history.entries).toEqual(['a', 'c']);
  });
  test('reverse search finds the most recent match', () => {
    const history = createHistory(['git status', 'bun test', 'bun test --watch']);
    expect(searchHistory(history, 'bun')?.text).toBe('bun test --watch');
    expect(searchHistory(history, 'bun', 2)?.text).toBe('bun test');
    expect(searchHistory(history, 'zzz')).toBeUndefined();
  });
});

describe('keymap', () => {
  test('parses single bindings and rejects chords', () => {
    expect(parseBinding('Ctrl+O')).toEqual({
      ok: true,
      binding: { key: 'o', ctrl: true, alt: false, shift: false },
    });
    expect(parseBinding('ctrl+x a').ok).toBe(false);
    expect(parseBinding('hyper+a').ok).toBe(false);
  });
  test('defaults map shift+tab to agent cycling, and f6/alt+enter/ctrl+enter all steer', () => {
    const { keymap } = buildKeymap({});
    expect(actionFor(keymap, { name: 'tab', ctrl: false, alt: false, shift: true })).toBe(
      'agent.cycle',
    );
    expect(actionFor(keymap, { name: 'o', ctrl: true, alt: false, shift: false })).toBe(
      'transcript.details',
    );
    expect(actionFor(keymap, { name: 'return', ctrl: true, alt: false, shift: false })).toBe(
      'composer.steer',
    );
    // F6 is the always-works fallback for terminals that cannot report modified Enter.
    expect(actionFor(keymap, { name: 'f6', ctrl: false, alt: false, shift: false })).toBe(
      'composer.steer',
    );
    expect(actionFor(keymap, { name: 'return', ctrl: false, alt: true, shift: false })).toBe(
      'composer.steer',
    );
  });
  test('a steering override replaces the whole list', () => {
    const { keymap, errors } = buildKeymap({ 'composer.steer': 'f4' });
    expect(errors).toEqual([]);
    expect(actionFor(keymap, { name: 'f4', ctrl: false, alt: false, shift: false })).toBe(
      'composer.steer',
    );
    expect(
      actionFor(keymap, { name: 'f6', ctrl: false, alt: false, shift: false }),
    ).toBeUndefined();
    expect(
      actionFor(keymap, { name: 'return', ctrl: true, alt: false, shift: false }),
    ).toBeUndefined();
  });
  test('duplicate and unknown overrides are reported and defaults kept', () => {
    const { keymap, errors } = buildKeymap({ 'model.pick': 'ctrl+o', bogus: 'f9' });
    expect(errors).toHaveLength(2);
    expect(actionFor(keymap, { name: 'p', ctrl: false, alt: true, shift: false })).toBe(
      'model.pick',
    );
  });
});

describe('slash commands', () => {
  const server = new Set(['review', 'init']);
  test('local commands win and are never prompts', () => {
    expect(parseInput('/model openai/x', server)).toEqual({
      kind: 'local',
      name: 'model',
      args: 'openai/x',
    });
  });
  test('server commands and explicit /server routing', () => {
    expect(parseInput('/review the diff', server)).toEqual({
      kind: 'server',
      name: 'review',
      args: 'the diff',
    });
    expect(parseInput('/server help me', server)).toEqual({
      kind: 'server',
      name: 'help',
      args: 'me',
    });
  });
  test('unknown commands are reported, plain text and shell are classified', () => {
    expect(parseInput('/nope', server)).toEqual({ kind: 'unknown-command', name: 'nope' });
    expect(parseInput('hello /model', server)).toEqual({ kind: 'prompt', text: 'hello /model' });
    expect(parseInput('!git status', server)).toEqual({ kind: 'shell', command: 'git status' });
  });
  test('completion lists matching local then server commands', () => {
    expect(completeCommand('/re', [{ name: 'review' }]).map((entry) => entry.name)).toEqual([
      'resume',
      'rename',
      'revert',
      'rewind',
      'review',
    ]);
    expect(completeCommand('/re x', [])).toEqual([]);
  });
});

describe('layout-preserving caret paint (#137)', () => {
  const texts = [
    'abcdef',
    'ab😀cd',
    'e\u0301x', // combining mark
    '日本語ab', // double-width
    'a👨‍👩‍👧b', // ZWJ family emoji
    '',
  ];

  test('the three pieces always concatenate back to the original text', () => {
    for (const text of texts) {
      for (let cursor = 0; cursor <= text.length; cursor += 1) {
        for (const show of [true, false]) {
          const parts = caretPaint({ text, cursor }, show);
          expect(parts.before + parts.marked + parts.after).toBe(text);
        }
      }
    }
  });

  test('mid-line caret marks the grapheme at the insertion boundary', () => {
    const parts = caretPaint({ text: 'abcdef', cursor: 3 }, true);
    expect(parts).toEqual({ before: 'abc', marked: 'd', after: 'ef' });
    expect(caretPaint({ text: 'abcdef', cursor: 3 }, false)).toEqual({
      before: 'abcd',
      marked: '',
      after: 'ef',
    });
  });

  test('emoji, combining marks and double-width glyphs are never split', () => {
    const emoji = caretPaint({ text: 'ab😀cd', cursor: 2 }, true);
    expect(emoji).toEqual({ before: 'ab', marked: '😀', after: 'cd' });
    const combining = caretPaint({ text: 'e\u0301x', cursor: 0 }, true);
    expect(combining).toEqual({ before: '', marked: 'e\u0301', after: 'x' });
    const wide = caretPaint({ text: '日本語', cursor: 1 }, true);
    expect(wide).toEqual({ before: '日', marked: '本', after: '語' });
  });

  test('end of text marks the last grapheme; an empty buffer marks nothing', () => {
    expect(caretPaint(composerFrom('abc'), true)).toEqual({
      before: 'ab',
      marked: 'c',
      after: '',
    });
    const empty = caretPaint(emptyComposer, true);
    expect(empty).toEqual({ before: '', marked: '', after: '' });
  });

  test('blink off removes only the style, never a display cell', () => {
    for (const text of texts) {
      const on = caretPaint(composerFrom(text), true);
      const off = caretPaint(composerFrom(text), false);
      expect(on.before.length + on.marked.length + on.after.length).toBe(text.length);
      expect(off.before.length + off.marked.length + off.after.length).toBe(text.length);
    }
  });

  test('cached boundaries stay exact across edits, blink and large drafts (#291)', () => {
    let composer = composerFrom('start ');
    for (let index = 0; index < 2000; index += 1) {
      composer = insertText(composer, index % 11 === 0 ? '👨‍👩‍👧' : index % 7 === 0 ? 'e\u0301' : 'a');
    }
    const text = composer.text;
    const reference = Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
      (segment) => segment.index,
    );
    reference.push(text.length);

    // Repeated blink and navigation must never drift or split a grapheme.
    for (let phase = 0; phase < 20; phase += 1) {
      const paint = caretPaint(composer, phase % 2 === 0);
      expect(paint.before + paint.marked + paint.after).toBe(text);
    }
    let cursor = text.length;
    for (let step = 0; step < 200; step += 1) {
      composer = moveLeft(composer);
      cursor = reference[reference.indexOf(cursor) - 1] ?? 0;
      expect(composer.cursor).toBe(cursor);
    }
    expect(composer.cursor).toBeGreaterThan(0);
  });

  test('an edit produces a new segmentation; cached drafts stay independent', () => {
    const first = composerFrom('ab😀');
    const second = composerFrom('x🐱y');
    for (let round = 0; round < 3; round += 1) {
      expect(moveLeft(first).cursor).toBe(2);
      expect(moveLeft(second).cursor).toBe(3);
      expect(caretPaint(first, true).marked).toBe('😀');
      expect(caretPaint(second, true).marked).toBe('y');
    }
    const edited = insertText(first, 'z');
    expect(caretPaint(edited, true)).toEqual({ before: 'ab😀', marked: 'z', after: '' });
    expect(moveLeft(edited).cursor).toBe(4);
  });
});
