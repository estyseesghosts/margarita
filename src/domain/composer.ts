/**
 * Pure multiline text buffer with a grapheme-safe cursor. The cursor is a UTF-16 index
 * that always sits on a grapheme boundary, so emoji and combining marks move and delete
 * as one unit.
 */
export type Composer = Readonly<{ text: string; cursor: number }>;

export const emptyComposer: Composer = { text: '', cursor: 0 };

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Splits text into user-perceived characters. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (segment) => segment.segment);
}

/** The cursor's grapheme and the text after it, for drawing an inverse-cell cursor. */
export function splitAtCursor(composer: Composer): { before: string; at: string; after: string } {
  const before = composer.text.slice(0, composer.cursor);
  const end = nextBoundary(composer.text, composer.cursor);
  return { before, at: composer.text.slice(composer.cursor, end), after: composer.text.slice(end) };
}

function boundaries(text: string): number[] {
  const points = [0];
  for (const segment of segmenter.segment(text)) {
    points.push(segment.index + segment.segment.length);
  }
  return points;
}

function previousBoundary(text: string, cursor: number): number {
  let previous = 0;
  for (const point of boundaries(text)) {
    if (point >= cursor) return previous;
    previous = point;
  }
  return previous;
}

function nextBoundary(text: string, cursor: number): number {
  for (const point of boundaries(text)) {
    if (point > cursor) return point;
  }
  return text.length;
}

export function composerFrom(text: string): Composer {
  return { text, cursor: text.length };
}

/** Restore a saved cursor within the text and on a grapheme boundary. */
export function restoreComposer(composer: Composer): Composer {
  const cursor = Math.max(0, Math.min(composer.text.length, composer.cursor));
  return { text: composer.text, cursor: snap(composer.text, cursor) };
}

export function isBlank(composer: Composer): boolean {
  return composer.text.length === 0;
}

export function insertText(composer: Composer, value: string): Composer {
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const text =
    composer.text.slice(0, composer.cursor) + normalized + composer.text.slice(composer.cursor);
  return { text, cursor: composer.cursor + normalized.length };
}

export function deleteBackward(composer: Composer): Composer {
  if (composer.cursor === 0) return composer;
  const start = previousBoundary(composer.text, composer.cursor);
  return {
    text: composer.text.slice(0, start) + composer.text.slice(composer.cursor),
    cursor: start,
  };
}

export function deleteForward(composer: Composer): Composer {
  if (composer.cursor >= composer.text.length) return composer;
  const end = nextBoundary(composer.text, composer.cursor);
  return {
    text: composer.text.slice(0, composer.cursor) + composer.text.slice(end),
    cursor: composer.cursor,
  };
}

export function moveLeft(composer: Composer): Composer {
  return { ...composer, cursor: previousBoundary(composer.text, composer.cursor) };
}

export function moveRight(composer: Composer): Composer {
  return { ...composer, cursor: nextBoundary(composer.text, composer.cursor) };
}

function lineStart(text: string, cursor: number): number {
  return text.lastIndexOf('\n', cursor - 1) + 1;
}

function lineEnd(text: string, cursor: number): number {
  const index = text.indexOf('\n', cursor);
  return index === -1 ? text.length : index;
}

export function moveLineStart(composer: Composer): Composer {
  return { ...composer, cursor: lineStart(composer.text, composer.cursor) };
}

export function moveLineEnd(composer: Composer): Composer {
  return { ...composer, cursor: lineEnd(composer.text, composer.cursor) };
}

/** Vertical move; `undefined` means the cursor is already on the first/last line. */
export function moveVertical(composer: Composer, direction: -1 | 1): Composer | undefined {
  const { text, cursor } = composer;
  const start = lineStart(text, cursor);
  const column = cursor - start;
  if (direction === -1) {
    if (start === 0) return undefined;
    const previousStart = lineStart(text, start - 1);
    const previousLength = start - 1 - previousStart;
    return { text, cursor: snap(text, previousStart + Math.min(column, previousLength)) };
  }
  const end = lineEnd(text, cursor);
  if (end === text.length) return undefined;
  const nextStart = end + 1;
  const nextLength = lineEnd(text, nextStart) - nextStart;
  return { text, cursor: snap(text, nextStart + Math.min(column, nextLength)) };
}

/** Moves `index` back onto a grapheme boundary if it landed inside a cluster. */
function snap(text: string, index: number): number {
  return boundaries(text).includes(index) ? index : previousBoundary(text, index);
}

const wordCharacter = /[\p{L}\p{N}_]/u;

export function moveWordLeft(composer: Composer): Composer {
  const { text } = composer;
  const points = boundaries(text);
  let position = points.indexOf(composer.cursor);
  while (position > 0 && !wordCharacter.test(text.slice(points[position - 1], points[position]))) {
    position -= 1;
  }
  while (position > 0 && wordCharacter.test(text.slice(points[position - 1], points[position]))) {
    position -= 1;
  }
  return { text, cursor: points[position] ?? 0 };
}

export function moveWordRight(composer: Composer): Composer {
  const { text } = composer;
  const points = boundaries(text);
  let position = points.indexOf(composer.cursor);
  while (
    position >= 0 &&
    position < points.length - 1 &&
    !wordCharacter.test(text.slice(points[position], points[position + 1]))
  ) {
    position += 1;
  }
  while (
    position >= 0 &&
    position < points.length - 1 &&
    wordCharacter.test(text.slice(points[position], points[position + 1]))
  ) {
    position += 1;
  }
  return { text, cursor: points[position] ?? text.length };
}

/** Delete the preceding whitespace-delimited unit, including preceding whitespace. */
export function deletePreviousWhitespaceUnit(composer: Composer): Composer {
  const { text, cursor } = composer;
  const points = boundaries(text);
  let position = points.indexOf(cursor);
  while (position > 0 && /^\s+$/u.test(text.slice(points[position - 1], points[position]))) {
    position -= 1;
  }
  while (position > 0 && !/^\s+$/u.test(text.slice(points[position - 1], points[position]))) {
    position -= 1;
  }
  const start = points[position] ?? 0;
  return { text: text.slice(0, start) + text.slice(cursor), cursor: start };
}

export function deleteWordBackward(composer: Composer): Composer {
  const target = moveWordLeft(composer).cursor;
  return {
    text: composer.text.slice(0, target) + composer.text.slice(composer.cursor),
    cursor: target,
  };
}

/** Alt+D: delete one word forward at the cursor, grapheme-safely. */
export function deleteWordForward(composer: Composer): Composer {
  const target = moveWordRight(composer).cursor;
  return {
    text: composer.text.slice(0, composer.cursor) + composer.text.slice(target),
    cursor: composer.cursor,
  };
}

/** Ctrl+U: delete to start of line. */
export function deleteToLineStart(composer: Composer): Composer {
  const start = lineStart(composer.text, composer.cursor);
  const from = start === composer.cursor && start > 0 ? start - 1 : start;
  return {
    text: composer.text.slice(0, from) + composer.text.slice(composer.cursor),
    cursor: from,
  };
}

/** Ctrl+K: delete to end of line. */
export function deleteToLineEnd(composer: Composer): Composer {
  const end = lineEnd(composer.text, composer.cursor);
  const to = end === composer.cursor && end < composer.text.length ? end + 1 : end;
  return {
    text: composer.text.slice(0, composer.cursor) + composer.text.slice(to),
    cursor: composer.cursor,
  };
}

/** Lines with the cursor's (line, column) for rendering. */
export function cursorPosition(composer: Composer): { line: number; column: number } {
  const before = composer.text.slice(0, composer.cursor);
  const lines = before.split('\n');
  return { line: lines.length - 1, column: (lines.at(-1) ?? '').length };
}

/**
 * Guarded Left (docs/04): only a truly empty composer with nothing else claiming the
 * key navigates to the overview. Left at column 0 of a non-empty draft never does.
 */
export function leftOpensOverview(
  composer: Composer,
  blockers: Readonly<{ modalOpen: boolean; completionOpen: boolean; shellMode: boolean }>,
): boolean {
  return (
    composer.text.length === 0 &&
    !blockers.modalOpen &&
    !blockers.completionOpen &&
    !blockers.shellMode
  );
}
