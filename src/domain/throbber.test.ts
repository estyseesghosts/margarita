import { describe, expect, test } from 'bun:test';

import { strings } from '../i18n/index.ts';
import {
  describeThrobber,
  formatElapsed,
  frameAt,
  shimmerWeights,
  throbberTickMs,
  tipFor,
} from './throbber.ts';
import { variationPeriodMs } from './variations.ts';

const clock = (at: number): string => `t${at}`;

describe('throbber timer cadence (#290)', () => {
  test('only running turns own a timer, and disabled animation ticks once per second', () => {
    expect(throbberTickMs(false, false)).toBeUndefined();
    expect(throbberTickMs(false, true)).toBeUndefined();
    expect(throbberTickMs(true, true)).toBe(150);
    expect(throbberTickMs(true, false)).toBe(1000);
  });
});

describe('throbber', () => {
  test('cycles four single-cell frames every 150ms', () => {
    expect([0, 150, 300, 450, 600].map((ms) => frameAt(ms, false))).toEqual([
      '◜',
      '◝',
      '◞',
      '◟',
      '◜',
    ]);
    expect(frameAt(150, true)).toBe('\\');
  });
  test('formats elapsed time compactly', () => {
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(192_000)).toBe('3m 12s');
    expect(formatElapsed(3_840_000)).toBe('1h 4m');
  });
  test('running line shows elapsed and reported tokens only', () => {
    const facts = { phase: 'running' as const, startedAt: 0, activity: 'Reading' };
    expect(describeThrobber(facts, 783_000, 80, clock)).toEqual({
      label: 'Reading…',
      meta: '(13m 3s)',
      animated: true,
    });
    const withTokens = { ...facts, outputTokens: 63_600 };
    expect(describeThrobber(withTokens, 783_000, 80, clock).meta).toBe('(13m 3s · ↓ 63.6k tokens)');
    expect(describeThrobber(withTokens, 783_000, 20, clock).meta).toBe('(13m 3s)');
    expect(describeThrobber(withTokens, 783_000, 10, clock).meta).toBe('');
  });
  test('finished turns are static and use completion time', () => {
    const line = describeThrobber(
      { phase: 'completed', startedAt: 0, completedAt: 5, outputTokens: 1200 },
      99,
      80,
      clock,
    );
    expect(line).toEqual({
      label: '',
      meta: `${strings.throbber.finishedAt('t5')} · ${strings.throbber.tokens('1.2k')}`,
      animated: false,
    });
    expect(describeThrobber({ phase: 'interrupted', startedAt: 0 }, 9, 80, clock).meta).toBe(
      strings.throbber.interrupted,
    );
  });
  test('shimmer peaks travel across the word', () => {
    const early = shimmerWeights(8, 300);
    const late = shimmerWeights(8, 1200);
    expect(early.indexOf(Math.max(...early))).toBeLessThan(late.indexOf(Math.max(...late)));
    expect(early.every((weight) => weight >= 0 && weight <= 1)).toBe(true);
  });
  test('tips only on some long turns', () => {
    expect(tipFor(3, 1000)).toBeUndefined();
    expect(tipFor(1, 60_000)).toBeUndefined();
    expect(tipFor(3, 60_000)).toBeDefined();
  });
});

describe('throbber activity variation pools', () => {
  const running = { phase: 'running' as const, startedAt: 0 };
  const edit = ['vim-ing', 'editing', 'patching'];
  const shell = ['running', 'executing', 'shelling'];

  test('the current state pool is shown immediately, not a stale wording', () => {
    const now = 3 * variationPeriodMs;
    const editLabel = describeThrobber({ ...running, activity: edit }, now, 80, clock).label;
    const shellLabel = describeThrobber({ ...running, activity: shell }, now, 80, clock).label;
    expect(edit).toContain(editLabel.replace(/…$/, ''));
    expect(shell).toContain(shellLabel.replace(/…$/, ''));
    expect(editLabel).not.toBe(shellLabel);
  });

  test('a wording holds for minutes instead of flickering between frames', () => {
    const facts = { ...running, activity: edit };
    const first = describeThrobber(facts, 1_000, 80, clock).label;
    expect(describeThrobber(facts, variationPeriodMs - 1, 80, clock).label).toBe(first);
    expect(describeThrobber(facts, variationPeriodMs, 80, clock).label).not.toBe(first);
  });
});
