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

/** How many physical rows one child page may occupy in each transcript mode (#268). */
export type ToolChildBudget = Readonly<{
  /** Physical rows for the whole page: child labels/detail plus summary/page hints. */
  rowBudget: number;
  maxChildren: number;
  /** Maximum error-preview rows reserved for a failed child. */
  errorRows: number;
  /** Maximum output-preview rows reserved per child; zero when the mode never prints it. */
  outputRows: number;
  /** Detailed mode names a failed child that supplied no separate reason. */
  missingReasonRow: boolean;
}>;

export type ToolChildMode = Readonly<{
  detailed: boolean;
  /** The user explicitly grew this item beyond its mode default. */
  userExpanded: boolean;
}>;

/**
 * Mode budgets are physical-row ceilings, not option counts. A page of 40 children with
 * four-row errors and outputs easily exceeded a screen even though each preview was
 * bounded (#268); these budgets bound the whole nested page instead.
 */
export function toolChildBudget(mode: ToolChildMode): ToolChildBudget {
  if (mode.userExpanded) {
    return {
      rowBudget: 60,
      maxChildren: 40,
      errorRows: 6,
      outputRows: mode.detailed ? 4 : 0,
      missingReasonRow: mode.detailed,
    };
  }
  if (mode.detailed) {
    return { rowBudget: 40, maxChildren: 20, errorRows: 4, outputRows: 4, missingReasonRow: true };
  }
  return { rowBudget: 22, maxChildren: 10, errorRows: 3, outputRows: 0, missingReasonRow: false };
}

/** One child plus the detail rows actually allocated to it on this page. */
export type ToolChildRow = Readonly<{
  child: ToolCallChild;
  errorRows: number;
  outputRows: number;
  missingReason: boolean;
}>;

export type ToolChildPage = Readonly<{
  visible: readonly ToolChildRow[];
  hidden: number;
  summary: ToolChildrenSummary;
  page: number;
  pages: number;
  /** Physical rows this page uses, including its summary/page hint reservation. */
  rowCount: number;
}>;

type ChildDetail = Readonly<{ errorRows: number; outputRows: number; missingReason: boolean }>;

function desiredDetail(child: ToolCallChild, budget: ToolChildBudget): ChildDetail {
  return {
    errorRows: child.error === undefined ? 0 : budget.errorRows,
    outputRows: child.output === undefined ? 0 : budget.outputRows,
    missingReason: budget.missingReasonRow && child.status === 'error' && child.error === undefined,
  };
}

function detailCost(detail: ChildDetail): number {
  return 1 + detail.errorRows + detail.outputRows + (detail.missingReason ? 1 : 0);
}

function clampDetail(detail: ChildDetail, room: number): ChildDetail {
  const errorRows = Math.min(detail.errorRows, Math.max(0, room));
  const afterError = Math.max(0, room - errorRows);
  const outputRows = Math.min(detail.outputRows, afterError);
  const afterOutput = Math.max(0, afterError - outputRows);
  return {
    errorRows,
    outputRows,
    missingReason: detail.missingReason && afterOutput > 0,
  };
}

/**
 * Bounds the *aggregate* physical rows of a nested Code Mode child page (#268). The page
 * size is dynamic: as many children as fit the mode's row budget, with each child's error
 * and output detail clamped to the remaining allocation. Failures get the first page's
 * slots, every page is in source order, and paging reaches every child exactly once.
 */
export function pagedToolChildren(
  children: readonly ToolCallChild[],
  budget: ToolChildBudget,
  page = 0,
): ToolChildPage {
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
  if (children.length === 0) {
    return { visible: [], hidden: 0, summary, page: 0, pages: 1, rowCount: 0 };
  }

  // Reserve the summary line and the page-hint line, so the child rows plus chrome stay
  // inside the mode's total inline-row budget (#268).
  const pageChromeRows = 2;
  const rowBudget = Math.max(1, Math.floor(budget.rowBudget) - pageChromeRows);
  const limit = Math.max(1, Math.floor(budget.maxChildren));
  // Failures are prioritized once, on the first page. Later pages use source order.
  const ordering = [
    ...children.flatMap((child, index) => (child.status === 'error' ? [index] : [])),
    ...children.flatMap((child, index) => (child.status === 'error' ? [] : [index])),
  ];
  const pages: ToolChildRow[][] = [];
  let cursor = 0;
  while (cursor < ordering.length) {
    const rows: ToolChildRow[] = [];
    let used = 0;
    while (cursor < ordering.length && rows.length < limit) {
      const orderIndex = ordering[cursor];
      if (orderIndex === undefined) break;
      const child = children[orderIndex];
      if (child === undefined) break;
      const desired = desiredDetail(child, budget);
      const fullCost = detailCost(desired);
      let detail = desired;
      if (used + fullCost > rowBudget) {
        // Not enough room for the full detail; keep the label and as much diagnosis as fits.
        detail = clampDetail(desired, Math.max(0, rowBudget - used - 1));
      }
      const cost = detailCost(detail);
      if (used + cost > rowBudget) break;
      rows.push({ child, ...detail });
      used += cost;
      cursor += 1;
    }
    if (rows.length === 0) {
      // A pathological budget smaller than one label must still make progress.
      const orderIndex = ordering[cursor];
      if (orderIndex === undefined) break;
      const child = children[orderIndex];
      if (child === undefined) break;
      rows.push({ child, errorRows: 0, outputRows: 0, missingReason: false });
      cursor += 1;
    }
    rows.sort((a, b) => a.child.index - b.child.index);
    pages.push(rows);
  }
  if (pages.length === 0) pages.push([]);
  const current = Math.max(0, Math.min(pages.length - 1, Math.floor(page)));
  const visible = pages[current] ?? [];
  const rowCount =
    pageChromeRows +
    visible.reduce(
      (total, row) => total + 1 + row.errorRows + row.outputRows + (row.missingReason ? 1 : 0),
      0,
    );
  return {
    visible,
    hidden: children.length - visible.length,
    summary,
    page: current,
    pages: pages.length,
    rowCount,
  };
}

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
