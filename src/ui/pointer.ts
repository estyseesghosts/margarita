import type { MouseEvent } from '@opentui/core';
import { createContext, useContext } from 'solid-js';

/**
 * One pointer gesture's non-persistent facts. A press begins a gesture; any movement with
 * the primary button held makes it a drag. Controls activate only on a click, so dragging
 * to select text never also toggles a disclosure row, opens a session or answers a question.
 */
export type PointerGesture = Readonly<{
  begin: () => void;
  drag: () => void;
  moved: () => boolean;
}>;

export function createPointerGesture(): PointerGesture {
  let dragged = false;
  return {
    begin() {
      dragged = false;
    },
    drag() {
      dragged = true;
    },
    moved() {
      return dragged;
    },
  };
}

/** The fallback keeps isolated component renders (stories, tests) safe without a provider. */
const fallback = createPointerGesture();
export const PointerGestureContext = createContext<PointerGesture>(fallback);

/**
 * Returns a factory for primary-button click handlers. The handler ignores non-left buttons
 * and gestures that turned into a selection drag.
 */
export function useActivate(): (activate: () => void) => (event: MouseEvent) => void {
  const gesture = useContext(PointerGestureContext);
  return (activate) => (event) => {
    if (event.button !== 0) return;
    if (gesture.moved()) return;
    activate();
  };
}
