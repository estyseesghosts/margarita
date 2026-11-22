import { describe, expect, test } from 'bun:test';

import { stickyPrompt, truncatePrompt } from './sticky-prompt.ts';

const at = (key: string, top: number, bottom = top + 1) => ({ key, text: key, top, bottom });

describe('stickyPrompt', () => {
  test('is the latest prompt that has scrolled fully above the viewport', () => {
    expect(stickyPrompt([at('a', -9), at('b', -3), at('c', 4)])?.key).toBe('b');
  });

  test('is absent when the newest prompt is visible or none has scrolled off', () => {
    expect(stickyPrompt([at('a', 0), at('b', 5)])).toBeUndefined();
    expect(stickyPrompt([])).toBeUndefined();
  });

  test('a prompt partly in view is not duplicated', () => {
    expect(stickyPrompt([at('a', -9), at('b', -1, 1)])?.key).toBe('a');
  });
});

describe('truncatePrompt', () => {
  test('keeps short single-line prompts', () => {
    expect(truncatePrompt('hello', 20)).toBe('hello');
  });

  test('cuts long prompts with an ellipsis', () => {
    expect(truncatePrompt('abcdefghij', 6)).toBe('abcde…');
  });

  test('marks multi-line prompts', () => {
    expect(truncatePrompt('first\nsecond', 20)).toBe('first …');
  });

  test('measures terminal cells and never splits a grapheme (#248)', () => {
    expect(truncatePrompt('日本語', 6)).toBe('日本語');
    expect(truncatePrompt('日本語', 4)).toBe('日…');
    // One family emoji is a single two-cell grapheme; a one-cell budget keeps only an ellipsis.
    expect(truncatePrompt('👨‍👩‍👧‍👦', 1)).toBe('…');
    expect(truncatePrompt('e\u0301e\u0301e\u0301', 2)).toBe('e\u0301…');
  });
});
