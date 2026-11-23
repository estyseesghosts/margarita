import { describe, expect, test } from 'bun:test';

import type { Composer } from '../domain/composer.ts';
import { EditHistory, isSingleGraphemeStep } from './edit-history.ts';

function composer(text: string): Composer {
  return { text, cursor: text.length };
}

describe('edit history (#311)', () => {
  test('single-grapheme steps collapse within the coalesce window', () => {
    const history = new EditHistory();
    history.record('local:a', composer(''), composer('a'), 1000);
    history.record('local:a', composer('a'), composer('ab'), 1100);
    // Two typing steps collapse into one undo back to the empty composer.
    expect(history.undo('local:a', composer('ab'))).toEqual(composer(''));
    expect(history.undo('local:a', composer(''))).toBeUndefined();
  });

  test('an edit outside the window or not a single grapheme starts a new step', () => {
    const history = new EditHistory();
    history.record('local:a', composer(''), composer('a'), 1000);
    history.record('local:a', composer('a'), composer('ab'), 3000);
    expect(history.undo('local:a', composer('ab'))).toEqual(composer('a'));
  });

  test('undo then redo returns the newer composer', () => {
    const history = new EditHistory();
    history.record('local:a', composer(''), composer('hello'), 1000);
    expect(history.undo('local:a', composer('hello'))).toEqual(composer(''));
    expect(history.redo('local:a', composer(''))).toEqual(composer('hello'));
  });

  test('stacks are per route and clear checkpoints one route', () => {
    const history = new EditHistory();
    history.record('local:a', composer(''), composer('a'), 1000);
    history.record('remote:a', composer(''), composer('x'), 1000);
    history.clear('local:a');
    expect(history.undo('local:a', composer('a'))).toBeUndefined();
    expect(history.undo('remote:a', composer('x'))).toEqual(composer(''));
  });

  test('grapheme helper recognizes insertions and deletions safely', () => {
    expect(isSingleGraphemeStep('', 'a')).toBe(true);
    expect(isSingleGraphemeStep('ab', 'a')).toBe(true);
    expect(isSingleGraphemeStep('a', 'ab')).toBe(true);
    expect(isSingleGraphemeStep('a', 'a')).toBe(false);
    expect(isSingleGraphemeStep('a', 'abc')).toBe(false);
  });
});
