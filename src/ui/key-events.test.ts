import { describe, expect, test } from 'bun:test';

import { parseKeypress } from '@opentui/core';

import { actionFor, buildKeymap } from '../domain/keymap.ts';
import { toKeyInput } from './app.tsx';

/**
 * The key-chain Windows Terminal drives end to end: bytes → terminal parser →
 * `toKeyInput` → keymap. These pin the byte sequences the app relies on, so a terminal
 * sending kitty CSI-u or legacy F6 works, and a bare CR (legacy modified-Enter collapse)
 * provably stays a plain Enter.
 */
function steeredBy(bytes: string, useKittyKeyboard: boolean): string | undefined {
  const parsed = parseKeypress(Buffer.from(bytes), { useKittyKeyboard });
  if (parsed === null) throw new Error(`unparsed key bytes: ${JSON.stringify(bytes)}`);
  return actionFor(
    buildKeymap({}).keymap,
    toKeyInput({
      name: parsed.name,
      ctrl: parsed.ctrl,
      meta: parsed.meta,
      option: parsed.option,
      shift: parsed.shift,
      sequence: parsed.sequence,
    }),
  );
}

describe('Windows Terminal key chains (issue #73)', () => {
  test('kitty-encoded Ctrl+Enter and Alt+Enter steer', () => {
    expect(steeredBy('\u001b[13;5u', true)).toBe('composer.steer');
    expect(steeredBy('\u001b[13;3u', true)).toBe('composer.steer');
    // Same bytes without the negotiation flag: the parser still understands CSI-u.
    expect(steeredBy('\u001b[13;5u', false)).toBe('composer.steer');
  });

  test('legacy Shift+Enter is a newline, plain CR is plain Enter — never steer', () => {
    expect(steeredBy('\u001b[13;2u', true)).toBeUndefined();
    expect(steeredBy('\r', true)).toBeUndefined();
    expect(steeredBy('\r', false)).toBeUndefined();
  });

  test('F6 steers with or without the kitty protocol', () => {
    expect(steeredBy('\u001b[17~', true)).toBe('composer.steer');
    expect(steeredBy('\u001b[17~', false)).toBe('composer.steer');
  });
});
