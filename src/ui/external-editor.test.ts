import { describe, expect, test } from 'bun:test';

import { normalizeEditedText } from './external-editor.ts';

describe('external editor text fidelity (#158)', () => {
  test('a no-op round trip preserves trailing newlines exactly', () => {
    for (const text of ['line 1\n', 'line 1\n\n', 'line 1\n  \n']) {
      expect(normalizeEditedText(text)).toBe(text);
    }
  });

  test('leading indentation and blank lines survive unchanged', () => {
    const draft = '    fenced code\n\n  trailing spaces  \n';
    expect(normalizeEditedText(draft)).toBe(draft);
  });

  test('CRLF is deliberately converted to LF without losing a trailing newline', () => {
    expect(normalizeEditedText('one\r\ntwo\r\n')).toBe('one\ntwo\n');
    expect(normalizeEditedText('one\r\n\r\n')).toBe('one\n\n');
  });
});
