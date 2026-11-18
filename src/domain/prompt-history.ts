/**
 * Prompt history navigation. Entries are oldest-first. While browsing, the draft that
 * was in the composer before the first Up is kept and restored past the newest entry.
 */
export type PromptHistory = Readonly<{
  entries: readonly string[];
  /** `undefined` when not browsing; otherwise an index into `entries`. */
  index?: number | undefined;
  savedDraft: string;
}>;

export function createHistory(entries: readonly string[]): PromptHistory {
  return { entries, savedDraft: '' };
}

export function recordEntry(history: PromptHistory, text: string, limit: number): PromptHistory {
  const trimmed = text.trim();
  if (trimmed === '') return { entries: history.entries, savedDraft: '' };
  const withoutDuplicate = history.entries.filter((entry) => entry !== text);
  return { entries: [...withoutDuplicate, text].slice(-limit), savedDraft: '' };
}

export type HistoryStep = Readonly<{ history: PromptHistory; text: string }>;

/** Older entry; `undefined` when there is nothing older. */
export function historyBack(history: PromptHistory, currentText: string): HistoryStep | undefined {
  if (history.entries.length === 0) return undefined;
  const index = history.index === undefined ? history.entries.length - 1 : history.index - 1;
  if (index < 0) return undefined;
  const text = history.entries[index];
  if (text === undefined) return undefined;
  const savedDraft = history.index === undefined ? currentText : history.savedDraft;
  return { history: { entries: history.entries, index, savedDraft }, text };
}

/** Newer entry, or the saved draft after the newest; `undefined` when not browsing. */
export function historyForward(history: PromptHistory): HistoryStep | undefined {
  if (history.index === undefined) return undefined;
  const index = history.index + 1;
  if (index >= history.entries.length) {
    return { history: { entries: history.entries, savedDraft: '' }, text: history.savedDraft };
  }
  const text = history.entries[index];
  if (text === undefined) return undefined;
  return { history: { ...history, index }, text };
}

/** Most recent entry containing `query`, searching older than `before` (exclusive). */
export function searchHistory(
  history: PromptHistory,
  query: string,
  before = history.entries.length,
): { index: number; text: string } | undefined {
  const needle = query.toLowerCase();
  for (let index = Math.min(before, history.entries.length) - 1; index >= 0; index -= 1) {
    const entry = history.entries[index];
    if (entry !== undefined && entry.toLowerCase().includes(needle)) return { index, text: entry };
  }
  return undefined;
}
