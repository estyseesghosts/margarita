import { expect, test } from 'bun:test';

import { actionFor, buildKeymap } from './keymap.ts';

test('accepts two-way and three-way swaps regardless of override order', () => {
  const overrides = {
    'model.pick': 'f2',
    'model.recentNext': 'ctrl+o',
    'transcript.details': 'alt+p',
  };
  const reversed = Object.fromEntries(Object.entries(overrides).toReversed());
  for (const input of [overrides, reversed]) {
    const { keymap, errors } = buildKeymap(input);
    expect(errors).toEqual([]);
    expect(actionFor(keymap, { name: 'f2', ctrl: false, alt: false, shift: false })).toBe(
      'model.pick',
    );
    expect(actionFor(keymap, { name: 'o', ctrl: true, alt: false, shift: false })).toBe(
      'model.recentNext',
    );
    expect(actionFor(keymap, { name: 'p', ctrl: false, alt: true, shift: false })).toBe(
      'transcript.details',
    );
  }
  expect(buildKeymap({ 'model.pick': 'f2', 'model.recentNext': 'alt+p' }).errors).toEqual([]);
});

test('requests.retry is bound to Alt+R by default', () => {
  const { keymap, errors } = buildKeymap({});
  expect(errors).toEqual([]);
  expect(actionFor(keymap, { name: 'r', ctrl: false, alt: true, shift: false })).toBe(
    'requests.retry',
  );
});

test('rejects final conflicts while retaining unrelated overrides', () => {
  const { keymap, errors } = buildKeymap({
    'model.pick': 'ctrl+o',
    'tasks.toggle': 'alt+t',
  });
  expect(errors.join(' ')).toContain('model.pick');
  expect(errors.join(' ')).toContain('transcript.details');
  expect(actionFor(keymap, { name: 'p', ctrl: false, alt: true, shift: false })).toBe('model.pick');
  expect(actionFor(keymap, { name: 't', ctrl: false, alt: true, shift: false })).toBe(
    'tasks.toggle',
  );
});
