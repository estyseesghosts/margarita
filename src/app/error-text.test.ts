import { describe, expect, test } from 'bun:test';

import { errorText as errorTextViaController } from './controller.ts';
import { errorText, refreshOutcome } from './error-text.ts';

describe('error text and refresh outcomes (#316)', () => {
  test('formats Errors and thrown values, with a stable controller re-export', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('plain');
    expect(errorText(42)).toBe('42');
    expect(errorTextViaController).toBe(errorText);
  });

  test('a successful request yields its confirmed jobs', async () => {
    expect(await refreshOutcome(async () => [1, 2])).toEqual({ ok: true, jobs: [1, 2] });
  });

  test('a failure yields a bounded, paint-safe detail without escaping text', async () => {
    const outcome = await refreshOutcome(async () => {
      throw new Error('\u001b[31mred\u001b[0m   spaced');
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).not.toContain('\u001b');
      expect(outcome.detail).toContain('red');
    }
    const empty = await refreshOutcome(async () => {
      throw new Error('   ');
    });
    expect(empty).toEqual({ ok: false, detail: 'job refresh failed' });
  });
});
