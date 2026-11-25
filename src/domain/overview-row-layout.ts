/**
 * Width-adaptive layout for overview session rows (#344). Titles and status labels are clipped
 * and padded to precomputed cell budgets so the activity dot, title and status columns line up
 * on every row. As the terminal narrows the secondary column degrades in steps — full
 * `state · age`, then age only, then nothing — so the title keeps the room, mirroring how
 * Claude Code's agent view drops its preview column before anything else. Pure and
 * renderer-independent so the budgets can be unit-tested.
 */
import { cellWidth, clipLineTailToCells, clipLineToCells } from './text-width.ts';

/** Cells the scrollbox reserves for its horizontal padding (one per side). */
const scrollboxPaddingCells = 2;
/**
 * Cells the vertical scrollbar occupies. Always reserved, even when the list fits and no bar is
 * drawn, so rows never reflow (or wrap their last cells) when the bar appears.
 */
export const overviewScrollbarCells = 1;

/** Width rows may occupy inside the overview scrollbox for a given terminal width. */
export function overviewContentWidth(terminalWidth: number): number {
  return Math.max(8, terminalWidth - scrollboxPaddingCells - overviewScrollbarCells);
}

/** Selection marker widths: `  ❯ ` / `    ` normally, `❯ ` / `  ` when the terminal is narrow. */
const wideMarkerCells = 4;
const narrowMarkerCells = 2;
/** Below this content width the marker shrinks so the title keeps its cells. */
const narrowMarkerBelowCells = 40;
export const overviewDotCells = 2;
/** Cell between the title and status columns. */
const gapCells = 1;
/** Longest status the full tier must show unclipped (`interrupted · 13m`, `needs input · 5d`). */
const minFullStatusCells = 17;
const maxFullStatusCells = 22;
/** Widest age label `formatAge` produces for realistic values (`now`, `59m`, `47h`, `999d`). */
const ageCells = 4;
/** Smallest title column worth keeping a status column for. */
const minTitleCellsWithStatus = 16;

/** Marker text for a row, shared by session, Show more and Load more rows so they align. */
export function overviewMarker(selected: boolean, contentWidth: number): string {
  const cells = contentWidth < narrowMarkerBelowCells ? narrowMarkerCells : wideMarkerCells;
  if (!selected) return ' '.repeat(cells);
  return cells === wideMarkerCells ? '  ❯ ' : '❯ ';
}

export type OverviewStatusMode = 'full' | 'age' | 'none';

export interface OverviewColumnBudgets {
  readonly markerCells: number;
  readonly statusMode: OverviewStatusMode;
  readonly titleCells: number;
  readonly statusCells: number;
  readonly gapCells: number;
}

export interface OverviewRowColumns {
  readonly marker: string;
  readonly dot: string;
  /** One or two display-cell-padded title lines; never a third, never ellipsis-only. */
  readonly titleLines: readonly string[];
  readonly title: string;
  /** Empty when the status column is dropped. */
  readonly status: string;
  /** Spacer between title and status; empty when the status column is dropped. */
  readonly gap: string;
  /** Cells to indent a wrapped title line so it lines up under the first. */
  readonly indentCells: number;
  readonly titleCells: number;
  readonly statusCells: number;
  readonly statusMode: OverviewStatusMode;
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
  if (cellWidth(first) > limit) first = clipWithEllipsis(first, limit);
  if (index >= words.length) return [first];
  const rest = words.slice(index).join(' ');
  return [first, cellWidth(rest) <= limit ? rest : clipWithEllipsis(rest, limit)];
}

/** Clips to `cells` and tucks the ellipsis against the last word (`read…`, not `read …`). */
function clipWithEllipsis(text: string, cells: number): string {
  return clipLineToCells(text, cells).text.replace(/\s+…$/, '…');
}

/** Right-pads to exactly `cells` cells; never emits more, even for wide graphemes. */
export function padCells(text: string, cells: number): string {
  return `${text}${' '.repeat(Math.max(0, cells - cellWidth(text)))}`;
}

/** Left-pads so short values (ages) line up on their trailing edge. */
function padCellsStart(text: string, cells: number): string {
  return `${' '.repeat(Math.max(0, cells - cellWidth(text)))}${text}`;
}

/**
 * Splits a row's available content width into marker/title/status budgets. The status column
 * is only kept while the title stays readable beside it: full `state · age` when it fits
 * unclipped, else age alone (the dot colour already carries the state), else dropped.
 */
export function overviewColumnBudgets(contentWidth: number): OverviewColumnBudgets {
  const markerCells = contentWidth < narrowMarkerBelowCells ? narrowMarkerCells : wideMarkerCells;
  const flexible = Math.max(1, contentWidth - markerCells - overviewDotCells - gapCells);
  const fullStatusCells = Math.min(maxFullStatusCells, Math.floor(flexible * 0.4));
  if (fullStatusCells >= minFullStatusCells) {
    return {
      markerCells,
      statusMode: 'full',
      titleCells: flexible - fullStatusCells,
      statusCells: fullStatusCells,
      gapCells,
    };
  }
  if (flexible - ageCells >= minTitleCellsWithStatus) {
    return {
      markerCells,
      statusMode: 'age',
      titleCells: flexible - ageCells,
      statusCells: ageCells,
      gapCells,
    };
  }
  return {
    markerCells,
    statusMode: 'none',
    titleCells: Math.max(1, contentWidth - markerCells - overviewDotCells),
    statusCells: 0,
    gapCells: 0,
  };
}

function padStatus(text: string, budgets: OverviewColumnBudgets): string {
  return budgets.statusMode === 'age'
    ? padCellsStart(text, budgets.statusCells)
    : padCells(text, budgets.statusCells);
}

/** Produces columns that always total `contentWidth` cells (or fewer, never more). */
export function layoutOverviewRow(input: {
  readonly selected: boolean;
  readonly dot: string;
  readonly title: string;
  /** Full `state · age` label, used while it fits. */
  readonly status: string;
  /** Age alone, used on narrower terminals. */
  readonly age: string;
  readonly contentWidth: number;
}): OverviewRowColumns {
  const budgets = overviewColumnBudgets(input.contentWidth);
  const dot = input.dot.length === 1 ? `${input.dot} ` : input.dot;
  const titleLines = wrapOverviewTitle(input.title, budgets.titleCells).map((line) =>
    padCells(line, budgets.titleCells),
  );
  const statusText =
    budgets.statusMode === 'full' ? input.status : budgets.statusMode === 'age' ? input.age : '';
  return {
    marker: overviewMarker(input.selected, input.contentWidth),
    dot: padCells(dot, overviewDotCells),
    titleLines,
    title: titleLines[0] ?? '',
    status: padStatus(clipLineToCells(statusText, budgets.statusCells).text, budgets),
    gap: ' '.repeat(budgets.gapCells),
    indentCells: budgets.markerCells + overviewDotCells,
    titleCells: budgets.titleCells,
    statusCells: budgets.statusCells,
    statusMode: budgets.statusMode,
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
 * labels, then the selected tab named in full with the rest as letter+count, then letter+count
 * for all, and only as a last resort clipping the label while preserving every count (#344).
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
  // Narrow terminals: keep the active filter readable, abbreviate the others.
  const focused = tabs.map((tab) =>
    tab.selected ? `[${tab.compactLabel} ${tab.count}] ` : `${tab.tinyLabel}${tab.count} `,
  );
  if (cellWidth(focused.join('')) <= contentWidth) return focused;
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

export interface OverviewProjectHeader {
  readonly name: string;
  /** Empty when no room is left; otherwise starts with `…` when the tail was kept. */
  readonly directory: string;
}

/**
 * Fits a project header (` name `, optional `extras` such as the remote label, then the path)
 * on one line. The name is clipped last; the path keeps its tail — the directory that matters —
 * and is dropped entirely rather than wrapping once fewer than `minPathCells` remain.
 */
export function layoutProjectHeader(input: {
  readonly name: string;
  /** Pre-rendered text between the name and the path (remote/offline markers). */
  readonly extras: string;
  readonly directory: string;
  readonly contentWidth: number;
}): OverviewProjectHeader {
  const minPathCells = 6;
  const chipPaddingCells = 2;
  const pathGapCells = 2;
  const name = clipLineToCells(input.name, Math.max(1, input.contentWidth - chipPaddingCells)).text;
  const used = cellWidth(name) + chipPaddingCells + cellWidth(input.extras) + pathGapCells;
  const available = input.contentWidth - used;
  if (available < minPathCells) return { name, directory: '' };
  return { name, directory: clipLineTailToCells(input.directory, available).text };
}
