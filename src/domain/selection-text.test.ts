import { describe, expect, test } from 'bun:test';

import { isDragSelection, joinSelectedLines } from './selection-text.ts';

describe('visual selection projection (#issue 3)', () => {
  test('joins rows top to bottom and cells left to right regardless of input order', () => {
    const text = joinSelectedLines([
      { y: 3, x: 10, text: 'right' },
      { y: 1, x: 2, text: ' row one' },
      { y: 3, x: 2, text: 'left ' },
      { y: 2, x: 0, text: 'middle' },
    ]);
    expect(text).toBe(' row one\nmiddle\nleft right');
  });

  test('keeps wide characters, emoji and blank lines exactly as selected', () => {
    const text = joinSelectedLines([
      { y: 0, x: 0, text: '🔑 漢字' },
      { y: 1, x: 0, text: '' },
      { y: 2, x: 0, text: 'e\u0301nd' },
    ]);
    expect(text).toBe('🔑 漢字\n\ne\u0301nd');
  });

  test('a single-cell click is not a drag; any larger gesture is', () => {
    expect(isDragSelection({ width: 1, height: 1 })).toBe(false);
    expect(isDragSelection({ width: 2, height: 1 })).toBe(true);
    expect(isDragSelection({ width: 1, height: 2 })).toBe(true);
  });
});
