import { describe, expect, test } from 'bun:test';

import { nodeViewFromArray, type TranscriptNode, windowNodeViewByRows } from './transcript.ts';

function text(key: string, value: string): TranscriptNode {
  return { kind: 'text', key, text: value };
}

describe('physical transcript window (#355)', () => {
  test('a single oversized node is mounted whole and the newest node is kept', () => {
    const nodes = [text('small', 'one'), text('huge', 'x'.repeat(10_000))];
    const windowed = windowNodeViewByRows(nodeViewFromArray(nodes), {
      nodeLimit: 200,
      rowBudget: 10,
      width: 80,
    });
    expect(windowed.visible).toHaveLength(1);
    expect(windowed.visible[0]?.key).toBe('huge');
    expect(windowed.estimatedRows).toBeGreaterThan(10);
    expect(windowed.hidden).toBe(1);
  });

  test('narrow terminals mount fewer nodes for the same physical budget', () => {
    const nodes = Array.from({ length: 30 }, (_, index) => text(`t${index}`, 'word '.repeat(40)));
    const wide = windowNodeViewByRows(nodeViewFromArray(nodes), {
      nodeLimit: 200,
      rowBudget: 40,
      width: 120,
    });
    const narrow = windowNodeViewByRows(nodeViewFromArray(nodes), {
      nodeLimit: 200,
      rowBudget: 40,
      width: 20,
    });
    expect(narrow.visible.length).toBeLessThan(wide.visible.length);
    expect(wide.estimatedRows).toBeLessThanOrEqual(40);
    expect(narrow.estimatedRows).toBeLessThanOrEqual(40);
    expect(wide.visible.at(-1)?.key).toBe('t29');
    expect(narrow.visible.at(-1)?.key).toBe('t29');
  });

  test('the newest live turn stays visible under the smallest budgets', () => {
    const nodes: TranscriptNode[] = [
      text('old', 'x'.repeat(1_000)),
      {
        kind: 'execution',
        key: 'run',
        segment: { id: 'u', afterMessageId: 'u', phase: 'running', startedAt: 0 },
      },
    ];
    const windowed = windowNodeViewByRows(nodeViewFromArray(nodes), {
      nodeLimit: 1,
      rowBudget: 1,
      width: 80,
    });
    expect(windowed.visible).toHaveLength(1);
    expect(windowed.visible[0]?.key).toBe('run');
    expect(windowed.hidden).toBe(1);
  });
});
