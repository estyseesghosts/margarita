/**
 * Opt-in formatting counters (#286). Domain transforms and native Markdown/diff rendering
 * are only observable from the UI layer, so this records how often the expensive client-side
 * derivations run. It never records transcript content, and it is a no-op unless enabled.
 *
 * Native OpenTUI parse/layout/cell counters are not exposed by the pinned renderer; those
 * remain unavailable rather than approximated (see docs/27-performance.md).
 */

export type FormatKind = 'markdown-content' | 'diff-normalize' | 'diff-clamp' | 'tool-preview';

const counts = new Map<FormatKind, number>();
let enabled = false;

/** Tests and diagnostic runs enable this explicitly; ordinary sessions leave it off. */
export function setFormatCounters(on: boolean): void {
  enabled = on;
}

export function countFormat(kind: FormatKind): void {
  if (!enabled) return;
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
}

export function resetFormatCounts(): void {
  counts.clear();
}

export function formatCounts(): Readonly<Record<FormatKind, number>> {
  return {
    'markdown-content': counts.get('markdown-content') ?? 0,
    'diff-normalize': counts.get('diff-normalize') ?? 0,
    'diff-clamp': counts.get('diff-clamp') ?? 0,
    'tool-preview': counts.get('tool-preview') ?? 0,
  };
}
