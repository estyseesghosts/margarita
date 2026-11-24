/**
 * One selected visual line: the row it occupies on screen and the cell column its first
 * character starts at. Row/column values are viewport facts, never persistent state.
 */
export type SelectedLine = Readonly<{ y: number; x: number; text: string }>;

/**
 * Joins the selected text of several rendered elements in visual reading order. Cells on
 * the same row join left to right with no separator; rows join with one newline. OpenTUI's
 * own selection projection uses the same rule; it is reproduced here so an overlay can
 * discard elements that are painted behind it without changing the joined result.
 */
export function joinSelectedLines(lines: readonly SelectedLine[]): string {
  const byRow = new Map<number, { x: number; text: string }[]>();
  for (const line of lines) {
    const row = byRow.get(line.y) ?? [];
    row.push({ x: line.x, text: line.text });
    byRow.set(line.y, row);
  }
  return [...byRow.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, segments]) =>
      segments
        .toSorted((left, right) => left.x - right.x)
        .map((segment) => segment.text)
        .join(''),
    )
    .join('\n');
}

/**
 * Whether a completed selection gesture covers more than one cell. A plain click also
 * selects the cell under the pointer; that must never be mistaken for a drag and copied.
 */
export function isDragSelection(bounds: Readonly<{ width: number; height: number }>): boolean {
  return bounds.width > 1 || bounds.height > 1;
}
