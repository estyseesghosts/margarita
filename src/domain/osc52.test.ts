import { describe, expect, test } from 'bun:test';

import { osc52Clipboard } from './osc52.ts';

describe('OSC 52 clipboard payloads (#105, #131)', () => {
  test('emits exactly one complete set operation with the exact UTF-8 bytes', () => {
    const text = 'café\nsecond line';
    const sequence = osc52Clipboard(text);
    const encoded = Buffer.from(text, 'utf8').toString('base64');
    expect(sequence).toBe(`\u001b]52;c;${encoded}\u001b\\`);
    // One opener and one terminator: never independent fragment sets (#131).
    expect(sequence?.split('\u001b]52;c;')).toHaveLength(2);
  });

  test('oversized encoded payloads are refused instead of split into several sets', () => {
    const text = 'x'.repeat(20_000) + '\n尾';
    expect(osc52Clipboard(text, 1000)).toBeUndefined();
    expect(osc52Clipboard(text, 40_000)).toContain('\u001b]52;c;');
  });

  test('the limit is based on encoded bytes, not characters', () => {
    const unicode = '尾'.repeat(10); // 30 UTF-8 bytes, 40 base64 chars
    expect(osc52Clipboard(unicode, 39)).toBeUndefined();
    expect(osc52Clipboard(unicode, 40)).toBeDefined();
  });
});
