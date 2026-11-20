import { describe, expect, test } from 'bun:test';

import { greetingPeriod } from './greeting-time.ts';

/** Local dates are constructed explicitly so the runner's timezone cannot shift them. */
const at = (hour: number, minute = 0) => new Date(2026, 5, 15, hour, minute);

describe('greetingPeriod', () => {
  test('classifies each suggested period', () => {
    expect(greetingPeriod(at(5))).toBe('morning');
    expect(greetingPeriod(at(8))).toBe('morning');
    expect(greetingPeriod(at(12))).toBe('afternoon');
    expect(greetingPeriod(at(15))).toBe('afternoon');
    expect(greetingPeriod(at(17))).toBe('evening');
    expect(greetingPeriod(at(20))).toBe('evening');
    expect(greetingPeriod(at(22))).toBe('night');
    expect(greetingPeriod(at(2))).toBe('night');
  });

  test('exact boundary minutes', () => {
    expect(greetingPeriod(at(4, 59))).toBe('night');
    expect(greetingPeriod(at(5, 0))).toBe('morning');
    expect(greetingPeriod(at(11, 59))).toBe('morning');
    expect(greetingPeriod(at(12, 0))).toBe('afternoon');
    expect(greetingPeriod(at(16, 59))).toBe('afternoon');
    expect(greetingPeriod(at(17, 0))).toBe('evening');
    expect(greetingPeriod(at(21, 59))).toBe('evening');
    expect(greetingPeriod(at(22, 0))).toBe('night');
    expect(greetingPeriod(at(23, 59))).toBe('night');
    expect(greetingPeriod(at(0, 0))).toBe('night');
  });
});
