import { graphemes } from './composer.ts';

/**
 * Terminal cell measurement shared by transcript previews and the inspector. Rendering
 * costs cells, not UTF-16 units: wide CJK and emoji take two, combining marks and joiners
 * take none. A tab is counted at the worst-case eight cells so a clipped row can never
 * exceed its budget, whatever column the tab lands on (#228).
 */

/** Combining marks, joiners, variation selectors and other zero-advance code points. */
function isZeroWidth(codePoint: number): boolean {
  return (
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0xfeff ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

/** East Asian Wide/Fullwidth and emoji-presentation ranges. */
function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

/** Cells one grapheme cluster occupies; a cluster is never split by clipping. */
export function graphemeCells(grapheme: string): number {
  if (grapheme === '\t') return 8;
  let visible = false;
  let wide = false;
  for (const character of grapheme) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isZeroWidth(codePoint)) continue;
    visible = true;
    if (isWide(codePoint)) wide = true;
  }
  return visible ? (wide ? 2 : 1) : 0;
}

const printableAscii = /^[\x20-\x7e]*$/;

/** Cells a whole line occupies. Printable ASCII is the fast path for minified payloads. */
export function cellWidth(text: string): number {
  if (printableAscii.test(text)) return text.length;
  let cells = 0;
  for (const grapheme of graphemes(text)) cells += graphemeCells(grapheme);
  return cells;
}

/** Rendered rows for one logical line; an empty line still occupies one row. */
export function lineRows(line: string, width: number): number {
  const safeWidth = Math.max(1, width);
  return Math.max(1, Math.ceil(cellWidth(line) / safeWidth));
}

/**
 * Head of a line clipped to at most `maxCells`, ending in `…` when content is omitted.
 * The ellipsis is part of the budget so callers can trust the returned width.
 */
export function clipLineToCells(
  text: string,
  maxCells: number,
): { text: string; clipped: boolean } {
  const limit = Math.max(0, maxCells);
  if (cellWidth(text) <= limit) return { text, clipped: false };
  if (limit === 0) return { text: '', clipped: true };
  const budget = limit - 1;
  if (printableAscii.test(text)) return { text: `${text.slice(0, budget)}…`, clipped: true };
  let shown = '';
  let cells = 0;
  for (const grapheme of graphemes(text)) {
    const width = graphemeCells(grapheme);
    if (cells + width > budget) break;
    shown += grapheme;
    cells += width;
  }
  return { text: `${shown}…`, clipped: true };
}

/**
 * Tail of a line clipped to at most `maxCells`, starting with `…` when content is omitted.
 * Used for errors, where the end of the last physical row is the diagnosis.
 */
export function clipLineTailToCells(
  text: string,
  maxCells: number,
): { text: string; clipped: boolean } {
  const limit = Math.max(0, maxCells);
  if (cellWidth(text) <= limit) return { text, clipped: false };
  if (limit === 0) return { text: '', clipped: true };
  const budget = limit - 1;
  if (printableAscii.test(text)) {
    return { text: `…${text.slice(text.length - budget)}`, clipped: true };
  }
  const parts = graphemes(text);
  let start = parts.length;
  let cells = 0;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const width = graphemeCells(parts[index] ?? '');
    if (cells + width > budget) break;
    cells += width;
    start = index;
  }
  return { text: `…${parts.slice(start).join('')}`, clipped: true };
}

/**
 * One horizontal window of a line: `startCell` columns skipped, then up to `maxCells`
 * columns shown. Leading/trailing `…` marks what is off-screen. Inspector rows never wrap.
 */
export function sliceCells(
  text: string,
  startCell: number,
  maxCells: number,
): { text: string; clippedLeft: boolean; clippedRight: boolean } {
  const limit = Math.max(1, maxCells);
  const start = Math.max(0, startCell);
  if (printableAscii.test(text)) {
    const clippedLeft = start > 0 && text.length > 0;
    const leftMarker = clippedLeft ? 1 : 0;
    const room = Math.max(0, limit - leftMarker);
    const end = Math.min(text.length, start + room);
    const clippedRight = end < text.length;
    const chars = Math.max(0, room - (clippedRight ? 1 : 0));
    const finalEnd = Math.min(text.length, start + chars);
    const stillRight = finalEnd < text.length;
    return {
      text: `${clippedLeft ? '…' : ''}${text.slice(start, finalEnd)}${stillRight ? '…' : ''}`,
      clippedLeft,
      clippedRight: stillRight,
    };
  }
  const clippedLeft = start > 0 && text.length > 0;
  const take = (budget: number): { shown: string; ended: boolean } => {
    let cell = 0;
    let used = 0;
    let started = false;
    let shown = '';
    for (const grapheme of graphemes(text)) {
      const width = graphemeCells(grapheme);
      if (!started) {
        if (cell + width <= start) {
          cell += width;
          continue;
        }
        started = true;
        if (cell < start) {
          cell += width;
          continue;
        }
      }
      if (used + width > budget) return { shown, ended: false };
      shown += grapheme;
      used += width;
      cell += width;
    }
    return { shown, ended: true };
  };
  const probe = take(Math.max(0, limit - (clippedLeft ? 1 : 0)));
  const budget = Math.max(0, limit - (clippedLeft ? 1 : 0) - (probe.ended ? 0 : 1));
  const final = take(budget);
  return {
    text: `${clippedLeft ? '…' : ''}${final.shown}${final.ended ? '' : '…'}`,
    clippedLeft,
    clippedRight: !final.ended,
  };
}
