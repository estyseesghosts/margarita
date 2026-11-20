import { describe, expect, test } from 'bun:test';

import { caretCell, graphemeWidth } from './caret-position.ts';

describe('caretCell', () => {
  test('tracks plain text and multiline cursors', () => {
    expect(caretCell('hello world', 0, 80)).toEqual({ row: 0, col: 0 });
    expect(caretCell('hello world', 5, 80)).toEqual({ row: 0, col: 5 });
    expect(caretCell('one\ntwo', 6, 80)).toEqual({ row: 1, col: 2 });
  });

  test('counts wide glyphs as two cells and combining marks as zero', () => {
    expect(graphemeWidth('a')).toBe(1);
    expect(graphemeWidth('中')).toBe(2);
    expect(graphemeWidth('🧑🏽‍💻')).toBe(2);
    expect(graphemeWidth('\u0301')).toBe(0);
    expect(caretCell('e\u0301中x', 'e\u0301中'.length, 80)).toEqual({ row: 0, col: 3 });
  });

  test('wraps at the available width without moving past the last column', () => {
    expect(caretCell('abcdef', 3, 4)).toEqual({ row: 0, col: 3 });
    expect(caretCell('abcdef', 4, 4)).toEqual({ row: 1, col: 0 });
    expect(caretCell('abcdef', 6, 4)).toEqual({ row: 1, col: 2 });
  });

  test('wide glyphs advance display cells, not UTF-16 offsets', () => {
    // '中' is one UTF-16 unit but two display cells: cursor 2 sits after 'a中' at cell 3,
    // and cursor 3 is past the whole string at cell 4.
    const text = 'a中b';
    expect(caretCell(text, 1, 80)).toEqual({ row: 0, col: 1 });
    expect(caretCell(text, 2, 80)).toEqual({ row: 0, col: 3 });
    expect(caretCell(text, 3, 80)).toEqual({ row: 0, col: 4 });
  });
});
