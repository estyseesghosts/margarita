import type { ToolCallChild } from './transcript.ts';

/** Aggregate child status counts for one execute call, independent of the render cap. */
export type ToolChildrenSummary = Readonly<{
  total: number;
  failed: number;
  running: number;
  completed: number;
}>;

export type BoundedToolChildren = Readonly<{
  visible: readonly ToolCallChild[];
  hidden: number;
  summary: ToolChildrenSummary;
  /** Zero-based page currently shown. */
  page: number;
  /** Total pages needed to reach every child; always at least one. */
  pages: number;
}>;

/**
 * Bounds how many nested Code Mode child rows one execute call renders (#260).
 * Failures get the first page's slots, and the chosen rows stay in source order so a
 * streaming append does not reshuffle existing rows. Later pages contain the remaining
 * children in source order, exactly once. The source array is never copied or dropped;
 * this is a paint budget, not a retention budget. Page numbers are clamped to the last
 * page when a live update shrinks the list.
 */
export function boundedToolChildren(
  children: readonly ToolCallChild[],
  limit: number,
  page = 0,
): BoundedToolChildren {
  let failed = 0;
  let running = 0;
  let completed = 0;
  for (const child of children) {
    if (child.status === 'error') failed += 1;
    else if (child.status === 'completed') completed += 1;
    else running += 1;
  }
  const summary: ToolChildrenSummary = {
    total: children.length,
    failed,
    running,
    completed,
  };
  const cap = Math.min(children.length, Math.max(0, Math.floor(limit)));
  if (cap === 0) {
    return { visible: [], hidden: children.length, summary, page: 0, pages: 1 };
  }
  if (cap === children.length) {
    return { visible: children, hidden: 0, summary, page: 0, pages: 1 };
  }

  const priority = new Set<number>();
  for (let index = 0; index < children.length && priority.size < cap; index += 1) {
    if (children[index]?.status === 'error') priority.add(index);
  }
  for (let index = 0; index < children.length && priority.size < cap; index += 1) {
    if (!priority.has(index)) priority.add(index);
  }
  const remaining = children.flatMap((_, index) => (priority.has(index) ? [] : [index]));
  const pages = 1 + Math.ceil(remaining.length / cap);
  const current = Math.max(0, Math.min(pages - 1, Math.floor(page)));
  if (current === 0) {
    const visible = children.filter((_, index) => priority.has(index));
    return { visible, hidden: children.length - visible.length, summary, page: 0, pages };
  }
  const start = (current - 1) * cap;
  const visible = remaining
    .slice(start, start + cap)
    .map((index) => children[index])
    .filter((child): child is ToolCallChild => child !== undefined);
  return {
    visible,
    hidden: children.length - visible.length,
    summary,
    page: current,
    pages,
  };
}
