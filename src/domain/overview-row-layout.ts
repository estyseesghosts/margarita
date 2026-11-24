/**
 * Fixed-column layout for overview session rows (#344). Session titles and status labels are
 * clipped and padded to precomputed cell budgets so the activity dot, title and status columns
 * line up on every row — including narrow terminals — instead of wrapping and shifting the
 * next row's indicator. Pure and renderer-independent so the budgets can be unit-tested.
 */
import { cellWidth, clipLineToCells } from './text-width.ts';

/** Cells reserved for the selection marker (`  ❯ ` / `    `) and the activity dot (`● `). */
export const overviewMarkerCells = 4;
export const overviewDotCells = 2;
/** Cell between the title and status columns. */
export const overviewGapCells = 1;
const fixedCells = overviewMarkerCells + overviewDotCells + overviewGapCells;

export interface OverviewRowColumns {
  readonly marker: string;
  readonly dot: string;
  readonly title: string;
  readonly status: string;
  readonly titleCells: number;
  readonly statusCells: number;
}

/** Right-pads to exactly `cells` cells; never emits more, even for wide graphemes. */
export function padCells(text: string, cells: number): string {
  return `${text}${' '.repeat(Math.max(0, cells - cellWidth(text)))}`;
}

/**
 * Splits a row's available content width into a stable title/status budget. Status never takes
 * more than ~40% of the flexible space (capped at 22 cells), so the title keeps the majority
 * and both columns shrink together as the terminal narrows.
 */
export function overviewColumnBudgets(contentWidth: number): {
  titleCells: number;
  statusCells: number;
} {
  const flexible = Math.max(1, contentWidth - fixedCells);
  const statusCells = Math.min(22, Math.max(6, Math.floor(flexible * 0.4)));
  return { titleCells: Math.max(1, flexible - statusCells), statusCells };
}

/** Produces four equal-width columns that always total `contentWidth` cells. */
export function layoutOverviewRow(input: {
  readonly selected: boolean;
  readonly dot: string;
  readonly title: string;
  readonly status: string;
  readonly contentWidth: number;
}): OverviewRowColumns {
  const { titleCells, statusCells } = overviewColumnBudgets(input.contentWidth);
  const dot = input.dot.length === 1 ? `${input.dot} ` : input.dot;
  return {
    marker: input.selected ? '  ❯ ' : '    ',
    dot: padCells(dot, overviewDotCells),
    title: padCells(clipLineToCells(input.title, titleCells).text, titleCells),
    status: padCells(clipLineToCells(input.status, statusCells).text, statusCells),
    titleCells,
    statusCells,
  };
}

/**
 * Gives every overview tab an equal fixed width so the filter row stays on one line and the
 * counts never wrap under their labels, even on narrow terminals (#344).
 */
export function layoutOverviewTabs(labels: readonly string[], contentWidth: number): string[] {
  if (labels.length === 0) return [];
  const cells = Math.max(4, Math.floor(contentWidth / labels.length));
  return labels.map((label) => padCells(clipLineToCells(label, cells).text, cells));
}
