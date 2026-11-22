import { describe, expect, test } from 'bun:test';

import { boundedToolChildren } from './tool-children.ts';
import type { ToolCallChild } from './transcript.ts';

function child(index: number, status: ToolCallChild['status'] = 'completed'): ToolCallChild {
  return {
    id: `exec:${index}`,
    parentID: 'exec',
    index,
    name: `lotus.op${index}`,
    status,
  };
}

describe('bounded nested child view (#260)', () => {
  test('keeps a short list intact and summarizes every status', () => {
    const children = [child(0), child(1, 'running'), child(2, 'error')];
    const view = boundedToolChildren(children, 5);
    expect(view.visible).toBe(children);
    expect(view.hidden).toBe(0);
    expect(view.summary).toEqual({ total: 3, failed: 1, running: 1, completed: 1 });
  });

  test('reserves slots for failures and preserves source order', () => {
    const children = Array.from({ length: 30 }, (_, index) =>
      child(index, index === 25 ? 'error' : 'completed'),
    );
    const view = boundedToolChildren(children, 5);
    expect(view.visible.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 25]);
    expect(view.hidden).toBe(25);
    expect(view.summary.failed).toBe(1);
  });

  test('keeps the first failures when failures alone exceed the budget', () => {
    const children = Array.from({ length: 10 }, (_, index) =>
      child(index, index >= 5 ? 'error' : 'completed'),
    );
    const view = boundedToolChildren(children, 3);
    expect(view.visible.map((entry) => entry.index)).toEqual([5, 6, 7]);
    expect(view.hidden).toBe(7);
  });

  test('zero and negative limits render no rows without losing the total', () => {
    const children = [child(0), child(1)];
    expect(boundedToolChildren(children, 0)).toMatchObject({
      visible: [],
      hidden: 2,
      page: 0,
      pages: 1,
    });
    expect(boundedToolChildren(children, -4)).toMatchObject({
      visible: [],
      hidden: 2,
      page: 0,
      pages: 1,
    });
  });

  test('later pages reach every remaining child exactly once (#260)', () => {
    const children = Array.from({ length: 12 }, (_, index) =>
      child(index, index === 9 ? 'error' : 'completed'),
    );
    const pages = Array.from({ length: 3 }, (_, page) => boundedToolChildren(children, 5, page));
    expect(pages.map((view) => view.page)).toEqual([0, 1, 2]);
    expect(pages.every((view) => view.pages === 3)).toBe(true);
    // Page zero keeps failure priority; later pages use source order and never repeat it.
    expect(pages[0]?.visible.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 9]);
    expect(pages[1]?.visible.map((entry) => entry.index)).toEqual([4, 5, 6, 7, 8]);
    expect(pages[2]?.visible.map((entry) => entry.index)).toEqual([10, 11]);
    const all = pages.flatMap((view) => view.visible.map((entry) => entry.index));
    expect(all.toSorted((a, b) => a - b)).toEqual(children.map((entry) => entry.index));
    expect(new Set(all).size).toBe(children.length);
  });

  test('page numbers clamp when a live list shrinks', () => {
    const children = Array.from({ length: 12 }, (_, index) => child(index));
    expect(boundedToolChildren(children, 5, 99).page).toBe(2);
    expect(boundedToolChildren(children, 5, 99).visible.map((entry) => entry.index)).toEqual([
      10, 11,
    ]);
    expect(boundedToolChildren(children.slice(0, 2), 5, 99)).toMatchObject({
      page: 0,
      pages: 1,
    });
  });
});
