/**
 * Maps a grapheme-safe UTF-16 composer cursor to a display cell for the terminal's real
 * caret. Wide glyphs occupy two cells, combining marks zero, and a line wraps at `width`.
 * This is presentation math only; editing still uses the composer's UTF-16 offset.
 */
export type CaretCell = Readonly<{ row: number; col: number }>;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const wide =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}\u{1F900}-\u{1F9FF}]/u;

/** Display cells used by one grapheme cluster. */
export function graphemeWidth(grapheme: string): number {
  if (grapheme === '\n' || grapheme === '\r') return 0;
  if (/\p{M}/u.test(grapheme) && grapheme.length === 1 && !wide.test(grapheme)) return 0;
  return wide.test(grapheme) ? 2 : 1;
}

export function caretCell(text: string, cursor: number, width: number): CaretCell {
  const limit = Math.max(1, width);
  let row = 0;
  let col = 0;
  let offset = 0;
  for (const part of segmenter.segment(text)) {
    if (offset >= cursor) break;
    const grapheme = part.segment;
    if (grapheme === '\n') {
      row += 1;
      col = 0;
    } else {
      const cells = graphemeWidth(grapheme);
      if (col + cells > limit && col > 0) {
        row += 1;
        col = 0;
      }
      col += cells;
    }
    offset += grapheme.length;
  }
  // A caret sitting at `width` is the wrap boundary: the next row's first cell. A terminal
  // may defer that wrap until it prints another glyph, but a cursor position must be valid.
  while (col >= limit) {
    row += 1;
    col -= limit;
  }
  return { row, col };
}
