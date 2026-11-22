import { describe, expect, test } from 'bun:test';

import {
  inspectorDocument,
  inspectorIndex,
  inspectorText,
  inspectorWindow,
  nextMatch,
  searchLines,
} from './inspector.ts';
import type { ToolResultPayload } from './transcript.ts';

const payload = (overrides: Partial<ToolResultPayload> = {}): ToolResultPayload => ({
  files: [],
  completeness: 'complete',
  ...overrides,
});

describe('inspector document and search (#221, #222)', () => {
  test('uses text first and never concatenates a diff into it', () => {
    expect(inspectorDocument(payload({ text: 'a\nb' }))).toEqual({
      lines: ['a', 'b'],
      kind: 'text',
    });
    expect(inspectorDocument(payload({ diff: '-a\n+b' }))).toEqual({
      lines: ['-a', '+b'],
      kind: 'diff',
    });
    expect(inspectorDocument(payload()).lines).toEqual([]);
  });

  test('copy text is the exact source payload, not the display window', () => {
    expect(inspectorText(payload({ text: 'one\ntwo' }))).toBe('one\ntwo');
    expect(inspectorText(payload({ diff: '-a' }))).toBe('-a');
    expect(inspectorText(payload())).toBe('');
  });

  test('a bounded inline row never hides the script error or file metadata (#277)', () => {
    const files = Array.from({ length: 1000 }, (_, index) => ({
      name: `f${index}.ts`,
      size: index,
    }));
    const full = payload({
      text: 'result',
      executionError: 'script failed\nat line 2',
      files,
    });
    const document = inspectorDocument(full);
    expect(document.kind).toBe('text');
    expect(document.lines.slice(0, 5)).toEqual([
      'result',
      '',
      'script failed:',
      'script failed',
      'at line 2',
    ]);
    expect(document.lines).toContain('files (1000):');
    expect(document.lines).toContain('  f999.ts · 999 B');
    const copied = inspectorText(full);
    expect(copied).toContain('at line 2');
    expect(copied).toContain('f999.ts · 999 B');
    expect(inspectorIndex(full).matches('f999.ts')).toEqual([1006]);
  });

  test('windows are clamped and materialize only the requested row count', () => {
    const lines = Array.from({ length: 10_000 }, (_, index) => `line${index}`);
    const middle = inspectorWindow(lines, 5000, 40);
    expect(middle.lines).toHaveLength(40);
    expect(middle.offset).toBe(5000);
    expect(middle.lines[0]).toBe('line5000');
    expect(middle.total).toBe(10_000);

    const pastEnd = inspectorWindow(lines, 99_999, 40);
    expect(pastEnd.offset).toBe(9960);
    expect(inspectorWindow([], 4, 40)).toEqual({ lines: [], offset: 0, total: 0 });
  });

  test('an index materializes once and memoizes matches per query (#234)', () => {
    const index = inspectorIndex(payload({ text: 'one\ntwo\none' }));
    const lines = index.lines;
    expect(index.lines).toBe(lines);
    const first = index.matches('one');
    expect(index.matches('one')).toBe(first);
    expect([...first]).toEqual([0, 2]);
    expect([...index.matchSet('one')]).toEqual([0, 2]);
    expect(index.matches('two')).not.toBe(first);
    expect([...index.matches('two')]).toEqual([1]);
  });

  test('search is literal, case-insensitive and wraps in both directions', () => {
    const lines = ['Alpha', 'beta', 'ALPHA', 'gamma'];
    const matches = searchLines(lines, 'alpha');
    expect(matches).toEqual([0, 2]);
    expect(searchLines(lines, '')).toEqual([]);
    expect(searchLines(lines, 'zed')).toEqual([]);

    expect(nextMatch(matches, 0, 1)).toBe(0);
    expect(nextMatch(matches, 1, 1)).toBe(2);
    expect(nextMatch(matches, 3, 1)).toBe(0);
    expect(nextMatch(matches, 2, -1)).toBe(0);
    expect(nextMatch(matches, 0, -1)).toBe(2);
    expect(nextMatch([], 7, 1)).toBe(7);
  });
});
