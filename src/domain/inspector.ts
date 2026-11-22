import type { ToolResultPayload } from './transcript.ts';

/** Text and diff are inspected independently; a diff is never concatenated into copy bytes. */
export type InspectorKind = 'text' | 'diff';

/**
 * Lines of one inspectable document. The full retained payload stays in memory as one
 * string; the view only materializes `windowRows` at a time, so a multi-MB result never
 * becomes one enormous rendered node (#222).
 */
export function inspectorDocument(payload: ToolResultPayload): {
  lines: readonly string[];
  kind: InspectorKind;
} {
  if (payload.text !== undefined && payload.text !== '') {
    return { lines: payload.text.replace(/\r\n?/g, '\n').split('\n'), kind: 'text' };
  }
  if (payload.diff !== undefined) {
    return { lines: payload.diff.replace(/\r\n?/g, '\n').split('\n'), kind: 'diff' };
  }
  return { lines: [], kind: 'text' };
}

/** Case-insensitive, literal substring search; empty query has no matches. */
export function searchLines(lines: readonly string[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  return lines.flatMap((line, index) => (line.toLowerCase().includes(needle) ? [index] : []));
}

/** Next match at or after `offset`; wraps. Returns the current offset when none exist. */
export function nextMatch(
  matches: readonly number[],
  offset: number,
  direction: 1 | -1 = 1,
): number {
  if (matches.length === 0) return offset;
  if (direction === 1) return matches.find((line) => line >= offset) ?? matches[0]!;
  const before = matches.filter((line) => line < offset);
  return before.at(-1) ?? matches.at(-1)!;
}

/** One bounded window of lines plus the clamped first line and the total. */
export function inspectorWindow(
  lines: readonly string[],
  offset: number,
  rows: number,
): { lines: readonly string[]; offset: number; total: number } {
  const total = lines.length;
  const size = Math.max(1, rows);
  const maxOffset = Math.max(0, total - size);
  const first = Math.min(Math.max(0, offset), maxOffset);
  return { lines: lines.slice(first, first + size), offset: first, total };
}

/** Copy/save bytes for one relied-on source: never the display window. */
export function inspectorText(payload: ToolResultPayload): string {
  if (payload.text !== undefined && payload.text !== '') return payload.text;
  return payload.diff ?? '';
}
