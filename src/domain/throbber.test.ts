import { describe, expect, test } from 'bun:test';

import {
  describeThrobber,
  formatElapsed,
  frameAt,
  latestTurn,
  shimmerWeights,
  tipFor,
} from './throbber.ts';

const clock = (at: number): string => `t${at}`;

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
    expect(line).toEqual({ label: '', meta: 'Finished at t5 · 1.2k tokens', animated: false });
    expect(describeThrobber({ phase: 'interrupted', startedAt: 0 }, 9, 80, clock).meta).toBe(
      'Interrupted',
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

describe('latestTurn', () => {
  const model = { providerID: 'p', modelID: 'm' };
  test('running turn starts at the user message and names the running tool', () => {
    const facts = latestTurn(
      [
        { kind: 'user', id: 'u', createdAt: 10, text: 'hi', attachments: [] },
        {
          kind: 'assistant',
          id: 'a',
          createdAt: 11,
          agent: 'build',
          model,
          parts: [
            {
              kind: 'tool',
              tool: { id: 't', name: 'grep', status: 'running', input: {}, startedAt: 12 },
            },
          ],
        },
      ],
      true,
    );
    expect(facts).toEqual({ phase: 'running', startedAt: 10, activity: 'Searching' });
  });
  test('idle marker decides interrupted and completion time', () => {
    const facts = latestTurn(
      [
        { kind: 'user', id: 'u', createdAt: 10, text: 'hi', attachments: [] },
        { kind: 'idle', id: 'i', createdAt: 50, outcome: 'interrupted' },
      ],
      false,
    );
    expect(facts).toEqual({ phase: 'interrupted', startedAt: 10, completedAt: 50 });
    expect(latestTurn([], false)).toBeUndefined();
  });
  test('a running compaction replaces the activity verb, keeping turn identity', () => {
    const facts = latestTurn(
      [
        { kind: 'user', id: 'u', createdAt: 10, text: 'hi', attachments: [] },
        {
          kind: 'assistant',
          id: 'a',
          createdAt: 11,
          agent: 'build',
          model,
          parts: [
            {
              kind: 'tool',
              tool: { id: 't', name: 'edit', status: 'running', input: {}, startedAt: 12 },
            },
          ],
        },
        { kind: 'compaction', id: 'c', createdAt: 20, state: 'running' },
      ],
      true,
    );
    expect(facts).toEqual({
      phase: 'running',
      startedAt: 10,
      activity: 'Compacting conversation',
    });
    if (facts === undefined) throw new Error('expected facts');
    // describeThrobber appends the ellipsis to the verb.
    const line = describeThrobber(facts, 10 + 42_000, 80, clock);
    expect(line.label).toBe('Compacting conversation…');
    expect(line.animated).toBe(true);
  });
  test('compaction applies even before any assistant part exists', () => {
    const facts = latestTurn(
      [
        { kind: 'user', id: 'u', createdAt: 10, text: 'hi', attachments: [] },
        { kind: 'compaction', id: 'c', createdAt: 12, state: 'running' },
      ],
      true,
    );
    expect(facts?.activity).toBe('Compacting conversation');
  });
  test('a completed compaction falls back to the underlying agent activity', () => {
    const messages = [
      { kind: 'user' as const, id: 'u', createdAt: 10, text: 'hi', attachments: [] },
      {
        kind: 'assistant' as const,
        id: 'a',
        createdAt: 11,
        agent: 'build',
        model,
        parts: [
          {
            kind: 'reasoning' as const,
            text: 'consider',
            done: false,
          },
        ],
      },
      { kind: 'compaction' as const, id: 'c', createdAt: 20, state: 'completed' as const },
    ];
    const facts = latestTurn(messages, true);
    expect(facts?.activity).toBe('Thinking');
    if (facts === undefined) throw new Error('expected facts');
    expect(describeThrobber(facts, 10 + 1000, 80, clock).label).not.toContain('Compacting');
  });
});
