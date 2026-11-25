import { describe, expect, test } from 'bun:test';

import { strings } from '../i18n/index.ts';
import { liveToolLine, type ToolCall } from './transcript.ts';
import { resolveVariation, variationPeriodMs } from './variations.ts';

const runningTool = (name: string): ToolCall[] => [
  { id: 't', name, status: 'running', input: {}, startedAt: 0 },
];

describe('resolveVariation', () => {
  test('a single wording is always returned verbatim', () => {
    expect(resolveVariation('editing', 0)).toBe('editing');
    expect(resolveVariation('editing', variationPeriodMs * 10, 42)).toBe('editing');
  });

  test('an empty pool resolves to undefined so callers can fall back', () => {
    expect(resolveVariation([], 1234)).toBeUndefined();
    expect(resolveVariation(undefined, 1234)).toBeUndefined();
  });

  test('a pool does not flicker: every call inside one period picks the same wording', () => {
    const pool = ['running', 'executing', 'shelling', 'crunching'];
    const seen = new Set(
      [0, 1_000, 30_000, 90_000, variationPeriodMs - 1].map((now) => resolveVariation(pool, now)),
    );
    expect(seen.size).toBe(1);
  });

  test('a pool advances one step per period, in order', () => {
    const pool = ['running', 'executing', 'shelling', 'crunching'];
    const picked = [0, 1, 2, 3, 4].map((step) => resolveVariation(pool, step * variationPeriodMs));
    expect(picked).toEqual([...pool, pool[0]]);
  });

  test('a different pool for a different state switches wording immediately', () => {
    const edit = ['vim-ing', 'editing', 'patching'];
    const shell = ['running', 'executing', 'shelling'];
    const now = 7 * variationPeriodMs;
    expect(resolveVariation(edit, now)).not.toBe(resolveVariation(shell, now));
    expect(edit).toContain(resolveVariation(edit, now) ?? '');
    expect(shell).toContain(resolveVariation(shell, now) ?? '');
  });

  test('a seed spreads turns across a pool without changing a given turn mid-period', () => {
    const pool = ['reading', 'perusing', 'scanning', 'looking through'];
    const first = resolveVariation(pool, 0, 1);
    const second = resolveVariation(pool, 0, 2);
    expect(first).not.toBe(second);
    expect(resolveVariation(pool, variationPeriodMs - 1, 1)).toBe(first);
  });

  test('a clock before the epoch is clamped instead of producing a negative index', () => {
    const pool = ['one', 'two', 'three'];
    expect(resolveVariation(pool, -variationPeriodMs)).toBe(pool[0]);
  });
});

describe('transcript live labels use the same slow variety', () => {
  test('the wording comes from the pool for the currently running tool', () => {
    const now = 3 * variationPeriodMs;
    const read = liveToolLine(runningTool('read'), [], now)?.text;
    const edit = liveToolLine(runningTool('edit'), [], now)?.text;
    expect(strings.transcript.live.read).toContain(read ?? '');
    expect(strings.transcript.live.edit).toContain(edit ?? '');
    expect(read).not.toBe(edit);
  });

  test('a live label holds for minutes instead of changing between frames', () => {
    const tools = runningTool('edit');
    const first = liveToolLine(tools, [], 1_000)?.text;
    expect(liveToolLine(tools, [], variationPeriodMs - 1)?.text).toBe(first);
    expect(liveToolLine(tools, [], variationPeriodMs)?.text).not.toBe(first);
  });
});
