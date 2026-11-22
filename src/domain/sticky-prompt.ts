import { clipLineToCells } from './text-width.ts';

/** A user prompt's vertical span in the scrolled content, in rows from the viewport top. */
export type PromptPosition = Readonly<{ key: string; text: string; top: number; bottom: number }>;

/** Physical rows from the end that still count as following the live tail (#280). */
export const stickyTailToleranceRows = 2;

/**
 * Whether the scrollbox is tail-locked. A small row tolerance absorbs the final layout
 * row while keeping a reader who deliberately scrolled back in history. This is the only
 * place the header's visibility policy reads scroll mode; prompt identity stays in
 * {@link stickyPrompt}.
 */
export function followsLiveTail(
  scrollTop: number,
  scrollHeight: number,
  viewportHeight: number,
): boolean {
  const maxOffset = Math.max(0, scrollHeight - Math.max(0, viewportHeight));
  return scrollTop >= maxOffset - stickyTailToleranceRows;
}

/**
 * The prompt shown as the sticky header: the latest one whose rows have all
 * scrolled above the viewport. A prompt that is visible (even partly) or below
 * is never duplicated. `positions` must be in conversation order.
 */
export function stickyPrompt(positions: readonly PromptPosition[]): PromptPosition | undefined {
  let found: PromptPosition | undefined;
  for (const position of positions) {
    if (position.bottom <= 0) found = position;
    else break;
  }
  return found;
}

/** One line: first line of the prompt, clipped to `width` terminal cells. */
export function truncatePrompt(text: string, width: number): string {
  const first = (text.split('\n')[0] ?? '').trim();
  const full = text.trim().includes('\n') ? `${first} …` : first;
  return clipLineToCells(full, Math.max(1, width)).text;
}
