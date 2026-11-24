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
  /** One or two display-cell-padded title lines; never a third, never ellipsis-only. */
  readonly titleLines: readonly string[];
  readonly title: string;
  readonly status: string;
  readonly titleCells: number;
  readonly statusCells: number;
}

/** Packs whole words into at most two lines, clipping the second only when content is omitted. */
export function wrapOverviewTitle(title: string, cells: number): string[] {
  const words = title.split(/\s+/).filter((word) => word !== '');
  const limit = Math.max(1, cells);
  if (words.length === 0) return [''];
  let first = '';
  let index = 0;
  while (index < words.length) {
    const candidate = first === '' ? words[index]! : `${first} ${words[index]!}`;
    if (cellWidth(candidate) > limit && first !== '') break;
    first = candidate;
    index += 1;
  }
  // A single token wider than the column is clipped safely rather than overrunning the row.
  if (cellWidth(first) > limit) first = clipLineToCells(first, limit).text;
  if (index >= words.length) return [first];
  const rest = words.slice(index).join(' ');
  return [first, cellWidth(rest) <= limit ? rest : clipLineToCells(rest, limit).text];
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
  const titleLines = wrapOverviewTitle(input.title, titleCells).map((line) =>
    padCells(line, titleCells),
  );
  return {
    marker: input.selected ? '  ❯ ' : '    ',
    dot: padCells(dot, overviewDotCells),
    titleLines,
    title: titleLines[0] ?? '',
    status: padCells(clipLineToCells(input.status, statusCells).text, statusCells),
    titleCells,
    statusCells,
  };
}

/** One overview filter tab; compact labels are used before any count is clipped (#344). */
export interface OverviewTabInput {
  readonly label: string;
  readonly compactLabel: string;
  /** Single-character label used only when even compact labels cannot fit (#344). */
  readonly tinyLabel: string;
  readonly count: number;
  readonly selected: boolean;
}

/**
 * Keeps the filter row on one line without ever hiding a count: full labels first, then compact
 * labels, and only as a last resort clipping the label while preserving every count (#344).
 */
export function layoutOverviewTabs(
  tabs: readonly OverviewTabInput[],
  contentWidth: number,
): string[] {
  if (tabs.length === 0) return [];
  const render = (labels: readonly string[]) =>
    tabs.map(
      (tab, index) =>
        `${tab.selected ? '[' : ' '}${labels[index] ?? tab.compactLabel} ${tab.count}${tab.selected ? ']' : ' '} `,
    );
  const full = render(tabs.map((tab) => tab.label));
  if (cellWidth(full.join('')) <= contentWidth) return full;
  const compact = render(tabs.map((tab) => tab.compactLabel));
  if (cellWidth(compact.join('')) <= contentWidth) return compact;
  // Tiny terminals: single-letter labels with counts still identify every filter.
  const tiny = tabs.map((tab) => `${tab.tinyLabel}${tab.count} `);
  if (cellWidth(tiny.join('')) <= contentWidth) return tiny;
  const cells = Math.max(4, Math.floor(contentWidth / tabs.length));
  return tabs.map((tab) => {
    const count = String(tab.count);
    const overhead = 4 + cellWidth(count); // surrounding spaces/brackets and the count itself
    const label = clipLineToCells(tab.compactLabel, Math.max(1, cells - overhead)).text;
    return padCells(
      `${tab.selected ? '[' : ' '}${label} ${count}${tab.selected ? ']' : ' '} `,
      cells,
    );
  });
}
