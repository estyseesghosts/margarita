import { describe, expect, test } from 'bun:test';

import { osc52Clipboard } from './osc52.ts';

describe('OSC 52 clipboard payloads (#105)', () => {
  test('encodes exact UTF-8 bytes and terminates every chunk', () => {
    const text = 'café\nsecond line';
    const sequence = osc52Clipboard(text);
    expect(sequence.startsWith('\u001b]52;c;')).toBe(true);
    expect(sequence.endsWith('\u001b\\')).toBe(true);
    const encoded = Buffer.from(text, 'utf8').toString('base64');
    expect(sequence).toBe(`\u001b]52;c;${encoded}\u001b\\`);
  });

  test('splits large payloads into whole base64 quartets that concatenate exactly', () => {
    const text = 'x'.repeat(20_000) + '\n尾';
    const sequence = osc52Clipboard(text, 1000);
    const chunks = sequence
      .split('\u001b\\')
      .filter((part) => part !== '')
      .map((part) => part.slice('\u001b]52;c;'.length));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length % 4 === 0)).toBe(true);
    expect(Buffer.from(chunks.join(''), 'base64').toString('utf8')).toBe(text);
  });
});
