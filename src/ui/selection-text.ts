import { joinSelectedLines, type SelectedLine } from '../domain/selection-text.ts';

/** Stable id for the full-screen inspector, whose box paints over the transcript. */
export const overlaySelectionRootID = 'overlay:selection-root';

/**
 * The part of OpenTUI's `Selection` and `Renderable` this projection needs; a live selection
 * and its renderables satisfy it structurally.
 */
export type SelectionNode = Readonly<{
  id: string;
  parent: SelectionNode | null;
  x: number;
  y: number;
  isDestroyed: boolean;
  getSelectedText: () => string;
}>;

export type SelectionSnapshot = Readonly<{
  selectedRenderables: readonly SelectionNode[];
  getSelectedText: () => string;
}>;

/**
 * The selection's text, restricted to the inspector subtree while the inspector paints over
 * the conversation. Text renderables behind an opaque overlay are still mounted and would
 * otherwise be selected by a drag that sweeps over the area they occupy.
 */
export function selectionText(selection: SelectionSnapshot | null, overlayOpen: boolean): string {
  if (selection === null) return '';
  if (!overlayOpen) return selection.getSelectedText();
  const all = selection.selectedRenderables;
  const live = all.filter((renderable) => !renderable.isDestroyed);
  const inside = live.filter(isWithinOverlay);
  if (inside.length === 0) return '';
  // The renderer projection already orders live text rows correctly; use it unless a
  // destroyed row or text behind the overlay must be excluded.
  if (live.length === all.length && inside.length === all.length)
    return selection.getSelectedText();
  return joinSelectedLines(renderableLines(inside));
}

function isWithinOverlay(renderable: SelectionNode): boolean {
  let current: SelectionNode | null = renderable;
  while (current !== null) {
    if (current.id === overlaySelectionRootID) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Rebuilds the visual rows of the selected renderables. Each renderable reports the text
 * selected within itself; a wrapped line contributes one row per physical line.
 */
function renderableLines(renderables: readonly SelectionNode[]): SelectedLine[] {
  const lines: SelectedLine[] = [];
  const ordered = renderables.toSorted((left, right) =>
    left.y === right.y ? left.x - right.x : left.y - right.y,
  );
  for (const renderable of ordered) {
    const text = renderable.getSelectedText();
    if (text === '') continue;
    text.split('\n').forEach((line, index) => {
      lines.push({ x: renderable.x, y: renderable.y + index, text: line });
    });
  }
  return lines;
}
