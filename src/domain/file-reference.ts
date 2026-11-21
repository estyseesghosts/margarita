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

const mentionPattern = /(^|\s)@([^\s@]+)/g;
const rangeSuffix = /#(\d+)-(\d+)$/;

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

/** `@path` tokens at word starts. Email-like `a@b` is ignored. */
export function findFileMentions(text: string): FileMention[] {
  const mentions: FileMention[] = [];
  for (const match of text.matchAll(mentionPattern)) {
    const prefix = match[1] ?? '';
    const raw = match[2] ?? '';
    const start = match.index + prefix.length;
    mentions.push(mentionFrom(raw, start, start + raw.length + 1));
  }
  return mentions;
}

/** The `@partial` token ending at the cursor, if the user is typing one. */
export function activeMention(text: string, cursor: number): FileMention | undefined {
  const before = text.slice(0, cursor);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (match === null) return undefined;
  const prefix = match[1] ?? '';
  const raw = match[2] ?? '';
  const start = match.index + prefix.length;
  return mentionFrom(raw, start, cursor);
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
