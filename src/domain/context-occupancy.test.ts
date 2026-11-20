import { describe, expect, test } from 'bun:test';

import { contextSeverity } from './context-occupancy.ts';

describe('contextSeverity', () => {
  test('thresholds', () => {
    expect(contextSeverity(0)).toBe('normal');
    expect(contextSeverity(69)).toBe('normal');
    expect(contextSeverity(70)).toBe('warning');
    expect(contextSeverity(89)).toBe('warning');
    expect(contextSeverity(90)).toBe('critical');
    expect(contextSeverity(100)).toBe('critical');
  });

  test('unavailable or invalid occupancy is unknown, never a fabricated warning', () => {
    expect(contextSeverity(undefined)).toBe('unknown');
    expect(contextSeverity(Number.NaN)).toBe('unknown');
    expect(contextSeverity(-1)).toBe('unknown');
    expect(contextSeverity(101)).toBe('unknown');
    expect(contextSeverity(Number.POSITIVE_INFINITY)).toBe('unknown');
  });
});
