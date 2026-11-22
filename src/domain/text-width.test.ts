import { describe, expect, test } from 'bun:test';

import {
  cellWidth,
  clipLineTailToCells,
  clipLineToCells,
  graphemeCells,
  lineRows,
  sliceCells,
} from './text-width.ts';

describe('terminal cell measurement (#228)', () => {
  test('ASCII, wide CJK, combining marks and emoji count as rendered cells', () => {
    expect(cellWidth('plain')).toBe(5);
    expect(cellWidth('日本語')).toBe(6);
    expect(cellWidth('e\u0301')).toBe(1);
    expect(cellWidth('👩‍💻')).toBe(2);
    expect(cellWidth('\t')).toBe(8);
    expect(graphemeCells('a')).toBe(1);
  });

  test('rows are cell-based, never UTF-16 based', () => {
    expect(lineRows('x'.repeat(80), 40)).toBe(2);
    expect(lineRows('日'.repeat(20), 40)).toBe(1);
    expect(lineRows('日'.repeat(21), 40)).toBe(2);
    expect(lineRows('', 40)).toBe(1);
  });

  test('head clipping stays within budget and never splits a grapheme', () => {
    const wide = clipLineToCells('日'.repeat(100), 20);
    expect(cellWidth(wide.text)).toBeLessThanOrEqual(20);
    expect(wide.text.endsWith('…')).toBe(true);
    expect(wide.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);

    const ascii = clipLineToCells('x'.repeat(100), 10);
    expect(ascii.text).toBe(`${'x'.repeat(9)}…`);
    expect(clipLineToCells('short', 10)).toEqual({ text: 'short', clipped: false });
    expect(clipLineToCells('anything', 0)).toEqual({ text: '', clipped: true });
  });

  test('tabs are bounded at the worst-case cell width', () => {
    const clipped = clipLineToCells('\t'.repeat(100), 20);
    expect(cellWidth(clipped.text)).toBeLessThanOrEqual(20);
    expect(clipped.text.endsWith('…')).toBe(true);
  });

  test('tail clipping keeps the diagnosis and stays within budget', () => {
    const text = `${'x'.repeat(5000)}error: cannot find module`;
    const clipped = clipLineTailToCells(text, 40);
    expect(clipped.text.endsWith('error: cannot find module')).toBe(true);
    expect(clipped.text.startsWith('…')).toBe(true);
    expect(cellWidth(clipped.text)).toBeLessThanOrEqual(40);
  });

  test('horizontal slices mark both hidden sides within the width', () => {
    const text = 'abcdefghij';
    expect(sliceCells(text, 0, 4)).toEqual({
      text: 'abc…',
      clippedLeft: false,
      clippedRight: true,
    });
    expect(sliceCells(text, 4, 4).text).toBe('…ef…');
    expect(sliceCells(text, 8, 4)).toEqual({
      text: '…ij',
      clippedLeft: true,
      clippedRight: false,
    });

    const wide = sliceCells('日本語テキスト', 2, 7);
    expect(cellWidth(wide.text)).toBeLessThanOrEqual(7);
    expect(wide.text.startsWith('…')).toBe(true);
  });
});
