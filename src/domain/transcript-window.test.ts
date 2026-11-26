import { describe, expect, test } from 'bun:test';

import {
  boundedPreview,
  nodeViewFromArray,
  previewBudget,
  type TranscriptNode,
  windowNodeView,
} from './transcript.ts';

function text(key: string, value: string): TranscriptNode {
  return { kind: 'text', key, text: value };
}

/**
 * The old "physical transcript window" contract asserted that the newest node is always kept
 * and that a narrower terminal mounts fewer historical nodes. That tail-relative row cap made
 * loaded history unreachable and is retired. These tests pin the replacement semantics: the
 * window is a logical folded-node count, and physical cost is bounded locally per item only.
 */
describe('logical transcript window (replaces the retired physical row window)', () => {
  test('hidden means exactly the loaded nodes outside the node window', () => {
    const nodes = Array.from({ length: 300 }, (_unused, index) => text(`t${index}`, 'word'));
    const windowed = windowNodeView(nodeViewFromArray(nodes), 200);
    expect(windowed.visible).toHaveLength(200);
    expect(windowed.visible.at(-1)?.key).toBe('t299');
    expect(windowed.hidden).toBe(100);
    expect(windowed.total).toBe(300);
  });

  test('physical height alone never hides a loaded node', () => {
    const nodes = [text('huge', 'x'.repeat(10_000)), text('tail', 'last')];
    const windowed = windowNodeView(nodeViewFromArray(nodes), 200);
    expect(windowed.visible.map((node) => node.key)).toEqual(['huge', 'tail']);
    expect(windowed.hidden).toBe(0);
  });

  test('growing the allowance by the hidden count exposes every loaded node', () => {
    const nodes = Array.from({ length: 300 }, (_unused, index) => text(`t${index}`, 'word'));
    const first = windowNodeView(nodeViewFromArray(nodes), 200);
    const grown = windowNodeView(nodeViewFromArray(nodes), 200 + first.hidden);
    expect(grown.visible).toHaveLength(300);
    expect(grown.visible[0]?.key).toBe('t0');
    expect(grown.hidden).toBe(0);
  });
});

describe('local rendering bounds never redefine scroll history', () => {
  test('one oversized payload is clipped to its own row budget, with an offset notice', () => {
    const huge = Array.from({ length: 5_000 }, (_unused, line) => `payload ${line}`).join('\n');
    const bounded = boundedPreview(huge, 12, 80);
    expect(bounded.text.split('\n').length).toBeLessThanOrEqual(12);
    expect(bounded.hiddenRows).toBeGreaterThan(0);
  });

  test('detailed and expanded budgets grow one item but stay capped', () => {
    expect(previewBudget('output', true)).toBeGreaterThan(previewBudget('output', false));
    expect(previewBudget('output', true, true)).toBeLessThanOrEqual(100);
  });
});
