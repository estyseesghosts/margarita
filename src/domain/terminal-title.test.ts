import { describe, expect, test } from 'bun:test';

import { deriveTerminalTitle } from './terminal-title.ts';

describe('terminal title derivation (#329)', () => {
  test('prefers a usable session title', () => {
    expect(deriveTerminalTitle({ title: 'Auditing Margarita...', directory: '/work' })).toBe(
      'MARG - Auditing Margarita...',
    );
  });

  test('falls back to the selected session directory, not the launcher directory', () => {
    expect(
      deriveTerminalTitle({ title: '', directory: '/srv/remote/project' }, '/work/workdir'),
    ).toBe('MARG - project');
    expect(deriveTerminalTitle(undefined, '/work/workdir')).toBe('MARG - workdir');
  });

  test('uses the bare prefix when neither title nor directory is usable', () => {
    expect(deriveTerminalTitle(undefined)).toBe('MARG');
    expect(deriveTerminalTitle({ title: '   ', directory: '/   ' })).toBe('MARG');
    expect(deriveTerminalTitle({ title: '   ', directory: '/' }, '')).toBe('MARG');
  });

  test('normalizes both path styles and never exposes a full private path', () => {
    expect(deriveTerminalTitle({ directory: 'C:\\Work\\Project' })).toBe('MARG - Project');
    expect(deriveTerminalTitle({ directory: '/work/project/' })).toBe('MARG - project');
    expect(deriveTerminalTitle({ directory: '/work/./project' })).toBe('MARG - project');
  });

  test('strips control, ANSI, OSC and newline bytes before publishing', () => {
    const hostile = 'Audit\u001b]0;pwned\u0007\n\u001b[31mred\u001b[0m\r\t status';
    expect(deriveTerminalTitle({ title: hostile })).toBe('MARG - Audit red status');
    expect(deriveTerminalTitle({ title: 'x\u202eevil' })).toBe('MARG - xevil');
  });

  test('preserves Unicode and truncates on a code-point boundary', () => {
    const unicode = '日本語のセッション';
    expect(deriveTerminalTitle({ title: unicode })).toBe(`MARG - ${unicode}`);
    const long = '界'.repeat(200);
    const published = deriveTerminalTitle({ title: long });
    expect(published.startsWith(`MARG - ${'界'.repeat(119)}…`)).toBe(true);
    expect(published.endsWith('\uD800')).toBe(false);
  });

  test('a whitespace-only title falls through to a usable directory', () => {
    expect(deriveTerminalTitle({ title: ' \t\n ', directory: '/work/ok' })).toBe('MARG - ok');
  });
});
