import { clipLineToCells } from './text-width.ts';

/** A user prompt's vertical span in the scrolled content, in rows from the viewport top. */
export type PromptPosition = Readonly<{ key: string; text: string; top: number; bottom: number }>;

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
