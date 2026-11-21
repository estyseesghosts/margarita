export type LineRange = Readonly<{ start: number; end: number }>;

export type FileMention = Readonly<{
  /** Path with any Margarita line-range suffix removed. */
  path: string;
  start: number;
  end: number;
  /** Original typed token, including a `#start-end` suffix when present. */
  text: string;
  range?: LineRange;
  /** Set when a `#…` suffix looks like a range but is invalid; never sent as a path. */
  rangeError?: string;
}>;

// A mention may follow prose punctuation (e.g. `(@reviewer)` or `@a,@b`). Quoting/backtick
// delimiters additionally let a filename contain its own punctuation (#164).
const mentionPrefix = '[\\s(\\[{`"\',;:]';
// Keep the prefix available to the next match when it separates adjacent mentions.
const mentionPattern = new RegExp(`(?=(^|${mentionPrefix})@([^\\s@]+))`, 'g');
const activeMentionPattern = new RegExp(`(^|${mentionPrefix})@([^\\s@]*)$`);
const rangeSuffix = /#(\d+)-(\d+)$/;

/** A quoted mention keeps its internal punctuation; a bare one drops trailing prose. */
const closingDelimiter: Readonly<Record<string, string>> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '`': '`',
  '"': '"',
  "'": "'",
};

function mentionIdentity(prefix: string, raw: string): string {
  const closing = closingDelimiter[prefix];
  if (closing !== undefined) {
    const closingIndex = raw.lastIndexOf(closing);
    if (closingIndex >= 0 && /^[,;:!?)\]}.]*$/.test(raw.slice(closingIndex + 1))) {
      return raw.slice(0, closingIndex);
    }
  }
  // Deterministic rule: these trailing marks are prose, never part of a bare mention.
  return raw.replace(/[,.;:!?)\]}]+$/, '');
}

/** Parse an optional, unambiguous `#start-end` line-range suffix (1-based, start <= end). */
export function parseMentionPath(raw: string): {
  path: string;
  range?: LineRange;
  rangeError?: string;
} {
  const match = rangeSuffix.exec(raw);
  if (match === null) return { path: raw };
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < 1 ||
    start > end
  ) {
    return { path: raw, rangeError: `Invalid line range "${match[0]}"` };
  }
  return { path: raw.slice(0, match.index), range: { start, end } };
}

function mentionFrom(raw: string, start: number, end: number): FileMention {
  const parsed = parseMentionPath(raw);
  return {
    path: parsed.path,
    start,
    end,
    text: `@${raw}`,
    ...(parsed.range === undefined ? {} : { range: parsed.range }),
    ...(parsed.rangeError === undefined ? {} : { rangeError: parsed.rangeError }),
  };
}

/** `@path` tokens at word starts. Email-like `a@b` is ignored; prose punctuation is not
 * part of the identity, and quoted tokens keep their internal punctuation (#164). */
export function findFileMentions(text: string): FileMention[] {
  const mentions: FileMention[] = [];
  for (const match of text.matchAll(mentionPattern)) {
    const prefix = match[1] ?? '';
    const identity = mentionIdentity(prefix, match[2] ?? '');
    if (identity === '') continue;
    const start = match.index + prefix.length;
    // The span covers only the real mention (`@` + identity), never trailing prose.
    mentions.push(mentionFrom(identity, start, start + identity.length + 1));
  }
  return mentions;
}

/** The `@partial` token ending at the cursor, if the user is typing one. */
export function activeMention(text: string, cursor: number): FileMention | undefined {
  const before = text.slice(0, cursor);
  const match = activeMentionPattern.exec(before);
  if (match === null) return undefined;
  const prefix = match[1] ?? '';
  const identity = mentionIdentity(prefix, match[2] ?? '');
  const start = match.index + prefix.length;
  return mentionFrom(identity, start, start + identity.length + 1);
}

/**
 * True for a bare `@name` token that could be an agent attachment. Paths (`@src/file.ts`,
 * `C:\…`, `./…`) and ranged references (`@file.ts#1-9`) are never agent candidates. This is
 * the single rule shared by completion, submission and the fail-closed guard: a bare name is
 * ambiguous until a verified catalog for the owning scope says whether it is an agent (#134).
 */
export function isBareAgentNameMention(mention: FileMention): boolean {
  return (
    mention.range === undefined && mention.rangeError === undefined && !/[\\/.]/.test(mention.path)
  );
}

/**
 * Bare `@name` mentions that name a known agent. Paths (`@src/file.ts`, `C:\…`, `./…`)
 * are never agents, and an agent is only used when it is in the current server's catalog.
 * File mentions keep their exact spans, so both attachment kinds can coexist in one prompt.
 */
export function agentMentions(
  mentions: readonly FileMention[],
  agentIDs: ReadonlySet<string>,
): FileMention[] {
  return mentions.filter(
    (mention) => isBareAgentNameMention(mention) && agentIDs.has(mention.path),
  );
}

/** Append one-based `start`/`end` query parameters to a file URI, if a range was typed. */
export function withLineRange(uri: string, range: LineRange | undefined): string {
  if (range === undefined) return uri;
  return `${uri}${uri.includes('?') ? '&' : '?'}start=${range.start}&end=${range.end}`;
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
