import { describe, expect, test } from 'bun:test';

import { markerText } from './marker-text.ts';

describe('markerText (issue #41)', () => {
  test('never carries a status glyph; the view adds exactly one', () => {
    for (const phase of ['completed', 'failed', 'interrupted'] as const) {
      expect(markerText({ phase, durationMs: 59_000, completedAt: 1_700_000_000_000 })).not.toMatch(
        /◌/,
      );
    }
  });

  test('wording per phase, with and without time data', () => {
    expect(markerText({ phase: 'completed', durationMs: 59_000 })).toBe('Completed in 59s');
    expect(markerText({ phase: 'failed', durationMs: 59_000 })).toBe('Failed after 59s');
    expect(markerText({ phase: 'interrupted' })).toBe('Interrupted');
    expect(markerText({ phase: 'completed', durationMs: 59_000, completedAt: 0 })).toMatch(
      /^Completed in 59s · done .+/,
    );
  });
});
