export type FileMention = Readonly<{ path: string; start: number; end: number; text: string }>;

const mentionPattern = /(^|\s)@([^\s@]+)/g;

/** `@path` tokens at word starts. Email-like `a@b` is ignored. */
export function findFileMentions(text: string): FileMention[] {
  const mentions: FileMention[] = [];
  for (const match of text.matchAll(mentionPattern)) {
    const prefix = match[1] ?? '';
    const path = match[2] ?? '';
    const start = match.index + prefix.length;
    const mentionText = `@${path}`;
    mentions.push({ path, start, end: start + mentionText.length, text: mentionText });
  }
  return mentions;
}

/** The `@partial` token ending at the cursor, if the user is typing one. */
export function activeMention(text: string, cursor: number): FileMention | undefined {
  const before = text.slice(0, cursor);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (match === null) return undefined;
  const prefix = match[1] ?? '';
  const path = match[2] ?? '';
  const start = match.index + prefix.length;
  return { path, start, end: cursor, text: `@${path}` };
}

/** Ranks candidate relative paths for a partial mention: prefix matches, then substrings. */
export function rankPaths(candidates: readonly string[], partial: string, limit: number): string[] {
  const needle = partial.toLowerCase().replaceAll('\\', '/');
  const scored: { path: string; score: number }[] = [];
  for (const path of candidates) {
    const normalized = path.toLowerCase().replaceAll('\\', '/');
    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    let score: number;
    if (needle === '') score = 3;
    else if (normalized.startsWith(needle)) score = 0;
    else if (base.startsWith(needle)) score = 1;
    else if (normalized.includes(needle)) score = 2;
    else continue;
    scored.push({ path, score });
  }
  return scored
    .toSorted(
      (left, right) =>
        left.score - right.score ||
        left.path.length - right.path.length ||
        left.path.localeCompare(right.path),
    )
    .slice(0, limit)
    .map((entry) => entry.path);
}
