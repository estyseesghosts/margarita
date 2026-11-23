/**
 * Route-scoped composer undo/redo history (#311).
 *
 * Consecutive single-grapheme typing collapses into one step, so a long typed
 * run is a single undo. Stacks are per route key, bounded, and never cross drafts;
 * restoring a snapshot only touches composer text, never attachments.
 */
import type { Composer } from '../domain/composer.ts';

const undoLimit = 100;
const typingCoalesceMs = 750;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A point an edit can be undone/redone back to. Attachments are kept, never duplicated. */
export interface UndoSnapshot {
  readonly composer: Composer;
}

/** True when two texts differ by exactly one grapheme cluster (an insertion or deletion). */
export function isSingleGraphemeStep(before: string, after: string): boolean {
  if (before === after) return false;
  const a = [...graphemes.segment(before)].map((part) => part.segment);
  const b = [...graphemes.segment(after)].map((part) => part.segment);
  if (Math.abs(a.length - b.length) !== 1) return false;
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return b.length > a.length
    ? a.slice(index).join('') === b.slice(index + 1).join('')
    : a.slice(index + 1).join('') === b.slice(index).join('');
}

/** Owns bounded per-route undo/redo stacks and typing coalescence. */
export class EditHistory {
  private readonly undoStacks = new Map<string, UndoSnapshot[]>();
  private readonly redoStacks = new Map<string, UndoSnapshot[]>();
  private lastEditAt = 0;
  private lastEditRoute = '';

  /** Records an edit; consecutive typing within the coalesce window collapses into one step. */
  record(key: string, before: Composer, next: Composer, now: number): void {
    if (before.text === next.text) return;
    const coalesce =
      this.lastEditRoute === key &&
      now - this.lastEditAt <= typingCoalesceMs &&
      isSingleGraphemeStep(before.text, next.text);
    if (!coalesce) {
      const stack = this.undoStacks.get(key) ?? [];
      stack.push({ composer: { ...before } });
      if (stack.length > undoLimit) stack.shift();
      this.undoStacks.set(key, stack);
      this.redoStacks.set(key, []);
    }
    this.lastEditAt = now;
    this.lastEditRoute = key;
  }

  /** Pops the previous composer for `key`, pushing `current` onto the redo stack. */
  undo(key: string, current: Composer): Composer | undefined {
    const stack = this.undoStacks.get(key) ?? [];
    const previous = stack.pop();
    if (previous === undefined) return undefined;
    const redo = this.redoStacks.get(key) ?? [];
    redo.push({ composer: { ...current } });
    this.undoStacks.set(key, stack);
    this.redoStacks.set(key, redo);
    this.lastEditRoute = '';
    return previous.composer;
  }

  /** Pops the next composer for `key`, pushing `current` back onto the undo stack. */
  redo(key: string, current: Composer): Composer | undefined {
    const stack = this.redoStacks.get(key) ?? [];
    const next = stack.pop();
    if (next === undefined) return undefined;
    const undo = this.undoStacks.get(key) ?? [];
    undo.push({ composer: { ...current } });
    this.redoStacks.set(key, stack);
    this.undoStacks.set(key, undo);
    this.lastEditRoute = '';
    return next.composer;
  }

  /** Checkpoints the draft: no undo across sent turns. */
  clear(key: string): void {
    this.undoStacks.delete(key);
    this.redoStacks.delete(key);
    this.lastEditRoute = '';
  }
}
