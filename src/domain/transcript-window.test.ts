import { describe, expect, test } from 'bun:test';

import {
  boundedPreview,
  nodeViewFromArray,
  previewBudget,
  tailViewport,
  type TranscriptNode,
  viewportNodeView,
  windowNodeView,
} from './transcript.ts';

function text(key: string, value: string): TranscriptNode {
  return { kind: 'text', key, text: value };
}

function windowNodes(count: number): readonly TranscriptNode[] {
  return Array.from({ length: count }, (_unused, index) => text(`t${index}`, 'word'));
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

/**
 * The grow-only scalar mounted the newest N nodes and PageUp raised N forever. A viewport
 * instead says *where* the reader is and has a fixed capacity, so 50k history can be
 * traversed without ever mounting 50k rows (slow.txt task 2).
 */
describe('bounded sliding transcript viewport', () => {
  test('tail mode mounts a bounded newest window', () => {
    const view = nodeViewFromArray(windowNodes(1000));
    const windowed = viewportNodeView(view, tailViewport(200));
    expect(windowed.visible).toHaveLength(200);
    expect(windowed.visible.at(-1)?.key).toBe('t999');
    expect(windowed.hidden).toBe(800);
    expect(windowed.hiddenAfter).toBe(0);
  });

  test('repeated PageUp moves the same-size window backward, never growing it', () => {
    const view = nodeViewFromArray(windowNodes(5000));
    let viewport = { mode: 'history' as const, anchorKey: 't4800', start: 4800, capacity: 200 };
    for (let step = 0; step < 30; step += 1) {
      const windowed = viewportNodeView(view, viewport);
      expect(windowed.visible).toHaveLength(200);
      expect(windowed.visible[0]?.key).toBe(viewport.anchorKey);
      viewport = {
        mode: 'history',
        anchorKey: viewport.start === 0 ? 't0' : `t${viewport.start - 200}`,
        start: Math.max(0, viewport.start - 200),
        capacity: 200,
      };
    }
    expect(viewport.start).toBe(0);
  });

  test('history rows and identities survive streaming tail activity', () => {
    const view = nodeViewFromArray(windowNodes(300));
    const viewport = { mode: 'history' as const, anchorKey: 't100', start: 100, capacity: 200 };
    const before = viewportNodeView(view, viewport);
    const grown = view.append(windowNodes(8));
    const after = viewportNodeView(grown, viewport);
    expect(after.visible.map((node) => node.key)).toEqual(before.visible.map((node) => node.key));
    expect(after.visible).toEqual(before.visible);
    expect(after.hidden).toBe(100);
    expect(after.hiddenAfter).toBe(8);
  });

  test('a semantic anchor is re-resolved after an older page prepend', () => {
    const view = nodeViewFromArray(windowNodes(300));
    const anchored = viewportNodeView(view, tailViewport(200));
    const first = anchored.visible[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const viewport = {
      mode: 'history' as const,
      anchorKey: first.key,
      start: anchored.start,
      capacity: 200,
    };
    const prepended = nodeViewFromArray([
      ...Array.from({ length: 120 }, (_unused, index) => text(`p${index}`, 'older')),
      ...view.toArray(),
    ]);
    const after = viewportNodeView(prepended, viewport);
    expect(after.visible[0]?.key).toBe(first.key);
    expect(after.start).toBe(viewport.start + 120);
  });

  test('overlapping rows keep node identity when the window shifts (slow.txt task 3)', () => {
    const view = nodeViewFromArray(windowNodes(100));
    const first = viewportNodeView(view, {
      mode: 'history',
      anchorKey: 't50',
      start: 50,
      capacity: 30,
    });
    const shifted = viewportNodeView(view, {
      mode: 'history',
      anchorKey: 't30',
      start: 30,
      capacity: 30,
    });
    const overlap = first.visible.slice(0, 10);
    expect(overlap.map((node) => node.key)).toEqual(
      shifted.visible.slice(20, 30).map((node) => node.key),
    );
    for (let index = 0; index < overlap.length; index += 1) {
      expect(shifted.visible[20 + index]).toBe(overlap[index]);
    }
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
