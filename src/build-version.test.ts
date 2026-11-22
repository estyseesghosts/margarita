import { describe, expect, test } from 'bun:test';

import { formatBuildVersion } from './build-version.ts';

describe('build version', () => {
  test('stamps the two-digit year, month and short commit', () => {
    expect(formatBuildVersion({ year: 2026, month: 11, commit: 'c7fd21', dirty: false })).toBe(
      '26-11-c7fd21',
    );
  });

  test('pads a single-digit year and month', () => {
    expect(formatBuildVersion({ year: 2005, month: 3, commit: 'abcdef', dirty: false })).toBe(
      '05-03-abcdef',
    );
  });

  test('marks a build from a dirty tree', () => {
    expect(formatBuildVersion({ year: 2026, month: 11, commit: 'c7fd21', dirty: true })).toBe(
      '26-11-c7fd21-dirty',
    );
  });
});
