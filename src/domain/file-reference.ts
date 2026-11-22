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
// delimiters additionally let a filename contain its own punctuation and spaces (#164, #203).
const mentionPrefix = '[\\s(\\[{`"\',;:]';
const prefixChar = new RegExp(`^${mentionPrefix}$`);
const activeMentionPattern = new RegExp(`(^|${mentionPrefix})@([^\\s@]*)$`);
// `"@docs/a b` and `@"docs/a b`: a quote opened right before or after the `@`, not yet closed.
const activeQuotedBefore = new RegExp(`(^|${mentionPrefix})(["'\`])@((?:(?!\\2)[^@\\n])*)$`);
const activeQuotedAfter = new RegExp(`(^|${mentionPrefix})@(["'\`])((?:(?!\\2)[^@\\n])*)$`);
const rangeSuffix = /#(\d+)-(\d+)$/;
const quoteChars = new Set(['"', "'", '`']);
/** What may follow a closing quote: end of text, whitespace or prose punctuation. */
const afterQuote = /^(?:$|[\s,;:!?.)\]}])/;

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

/** The closing quote index of a delimited token opened before `from`, on the same line. */
function closingQuote(text: string, from: number, quote: string): number {
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n') return -1;
    if (char === quote) return index;
  }
  return -1;
}

/**
 * One tokenizer for both submission and completion (#203). A mention is `@token`, where the
 * token is either bare (no whitespace), or delimited by balanced quotes/backticks that may
 * contain spaces and punctuation: `"@docs/a b.md"` or `@"docs/a b.md"#2-4`. An unmatched or
 * unbounded delimiter never swallows the rest of the prompt; it falls back to the bare rule.
 */
function mentionAt(text: string, at: number): FileMention | undefined {
  const prefix = at === 0 ? '' : (text[at - 1] ?? '');
  if (prefix !== '' && !prefixChar.test(prefix)) return undefined;
  const before = quoteChars.has(prefix) ? prefix : undefined;
  const after = text[at + 1];
  if (after !== undefined && quoteChars.has(after)) {
    const close = closingQuote(text, at + 2, after);
    if (close > at + 2) {
      let end = close + 1;
      const suffix = /^#\d+-\d+/.exec(text.slice(end))?.[0] ?? '';
      end += suffix.length;
      const inner = text.slice(at + 2, close);
      if (afterQuote.test(text.slice(end)) && !inner.includes('@') && inner.trim() === inner) {
        const parsed = parseMentionPath(`${inner}${suffix}`);
        return {
          path: parsed.path,
          start: at,
          end,
          text: text.slice(at, end),
          ...(parsed.range === undefined ? {} : { range: parsed.range }),
          ...(parsed.rangeError === undefined ? {} : { rangeError: parsed.rangeError }),
        };
      }
    }
  }
  if (before !== undefined) {
    const close = closingQuote(text, at + 1, before);
    if (close > at + 1) {
      const inner = text.slice(at + 1, close);
      if (
        /\s/.test(inner) &&
        !inner.includes('@') &&
        inner.trim() === inner &&
        afterQuote.test(text.slice(close + 1))
      ) {
        return mentionFrom(inner, at, at + inner.length + 1);
      }
    }
  }
  let raw = /^[^\s@]+/.exec(text.slice(at + 1))?.[0];
  if (raw === undefined) return undefined;
  // `@a,"@b c"`: a quote opening the next mention is not part of this one.
  if (text[at + 1 + raw.length] === '@') raw = raw.replace(/["'`]$/, '');
  const identity = mentionIdentity(prefix, raw);
  return identity === '' ? undefined : mentionFrom(identity, at, at + identity.length + 1);
}

/** `@path` tokens at word starts. Email-like `a@b` is ignored; prose punctuation is not
 * part of the identity, and quoted tokens keep their internal punctuation and spaces. */
export function findFileMentions(text: string): FileMention[] {
  const mentions: FileMention[] = [];
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    const mention = mentionAt(text, at);
    if (mention === undefined) continue;
    mentions.push(mention);
    // Never rescan inside a delimited token that was just consumed.
    at = Math.max(at, mention.end - 1);
  }
  return mentions;
}

/** The `@partial` token ending at the cursor, if the user is typing one. */
export function activeMention(text: string, cursor: number): FileMention | undefined {
  if (cursor <= 0) return undefined;
  // Ordinary prose typing must not copy/scan the whole draft. Every mention form contains an
  // `@` on the cursor's line, so a backward search rejects unrelated input in O(line tail).
  const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
  if (text.lastIndexOf('@', cursor - 1) < lineStart) return undefined;
  const before = text.slice(0, cursor);
  const line = before.slice(lineStart);
  const opened = activeQuotedAfter.exec(line);
  if (opened !== null) {
    const start = lineStart + opened.index + (opened[1] ?? '').length;
    const parsed = parseMentionPath(opened[3] ?? '');
    return {
      path: parsed.path,
      start,
      end: before.length,
      text: before.slice(start),
      ...(parsed.range === undefined ? {} : { range: parsed.range }),
      ...(parsed.rangeError === undefined ? {} : { rangeError: parsed.rangeError }),
    };
  }
  const spaced = activeQuotedBefore.exec(line);
  if (spaced !== null && /\s/.test(spaced[3] ?? '')) {
    const start = lineStart + spaced.index + (spaced[1] ?? '').length + 1;
    return mentionFrom(spaced[3] ?? '', start, before.length);
  }
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
