import type { TranscriptMessage } from '../domain/transcript.ts';
import {
  approximateMessageBytes,
  approximateTranscriptBytes,
  type RetainedBytes,
} from '../perf/memory.ts';

/**
 * Per-transcript reconciliation metadata (#350, #351).
 *
 * This never stores a second copy of the messages. It keeps the server-qualified id index and
 * the retained-byte totals the controller needs to reconcile a latest page, prepend older
 * history and plan cache eviction without walking the whole loaded transcript.
 *
 * Indices are stored relative to `baseOffset`: a prepend only changes `baseOffset`, leaving
 * every cached mapping untouched. Absolute index = raw index + baseOffset.
 */
export type TranscriptIndex = {
  messages: readonly TranscriptMessage[];
  readonly idToIndex: Map<string, number>;
  baseOffset: number;
  bytes: RetainedBytes;
};

export type MergeTranscriptOutcome = Readonly<{
  messages: TranscriptMessage[];
  index: TranscriptIndex;
  /** First canonical index that differs from the cached array. */
  firstChangedIndex: number;
  /** Cached messages inspected/replaced by this reconciliation. */
  reconciled: number;
  removed: number;
  added: number;
  /** False when a malformed/disjoint page forced a defensive full-array filter. */
  pageProportional: boolean;
}>;

export type PrependTranscriptOutcome = Readonly<{
  messages: TranscriptMessage[];
  index: TranscriptIndex;
  added: number;
}>;

function addBytes(left: RetainedBytes, right: RetainedBytes): RetainedBytes {
  return {
    total: left.total + right.total,
    text: left.text + right.text,
    structure: left.structure + right.structure,
  };
}

function subtractBytes(left: RetainedBytes, right: RetainedBytes): RetainedBytes {
  return {
    total: left.total - right.total,
    text: left.text - right.text,
    structure: left.structure - right.structure,
  };
}

export function buildTranscriptIndex(messages: readonly TranscriptMessage[]): TranscriptIndex {
  const idToIndex = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    // Malformed payloads may repeat an id. The first position is canonical; a later duplicate
    // still renders but must not steal the boundary lookup from the earlier message.
    if (!idToIndex.has(message.id)) idToIndex.set(message.id, index);
  }
  return {
    messages,
    idToIndex,
    baseOffset: 0,
    bytes: approximateTranscriptBytes(messages),
  };
}

/** Returns the current absolute index of `id`, or undefined when it is not loaded. */
export function indexOfMessage(index: TranscriptIndex, id: string): number | undefined {
  const raw = index.idToIndex.get(id);
  return raw === undefined ? undefined : raw + index.baseOffset;
}

/**
 * Reuses the index for `messages` when they are the same array; otherwise rebuilds it. This is
 * the explicit repair path (state written by another owner, tests or a restored snapshot).
 */
export function ensureTranscriptIndex(
  index: TranscriptIndex | undefined,
  messages: readonly TranscriptMessage[],
): TranscriptIndex {
  if (index !== undefined && index.messages === messages) return index;
  return buildTranscriptIndex(messages);
}

function uniquePage(page: readonly TranscriptMessage[]): TranscriptMessage[] {
  const seen = new Set<string>();
  const unique: TranscriptMessage[] = [];
  for (const message of page) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    unique.push(message);
  }
  return unique;
}

function removeIds(
  index: TranscriptIndex,
  messages: readonly TranscriptMessage[],
  from: number,
): RetainedBytes {
  let removed = { total: 0, text: 0, structure: 0 };
  for (let position = from; position < messages.length; position += 1) {
    const message = messages[position];
    if (message === undefined) continue;
    index.idToIndex.delete(message.id);
    removed = addBytes(removed, approximateMessageBytes(message));
  }
  return removed;
}

/**
 * Merges a fresh latest page into the cached transcript. The page boundary is located through
 * the id index, so the common case inspects only the page plus the messages it replaces.
 * Server objects remain authoritative inside the page, including reordering and deletion.
 */
export function mergeLatestIndexed(
  cached: readonly TranscriptMessage[],
  currentIndex: TranscriptIndex | undefined,
  page: readonly TranscriptMessage[],
): MergeTranscriptOutcome {
  const index = ensureTranscriptIndex(currentIndex, cached);
  if (page.length === 0) {
    return {
      messages: [...cached],
      index,
      firstChangedIndex: cached.length,
      reconciled: 0,
      removed: 0,
      added: 0,
      pageProportional: true,
    };
  }
  const deduped = uniquePage(page);
  const first = deduped[0];
  if (first === undefined) {
    return {
      messages: [...cached],
      index,
      firstChangedIndex: cached.length,
      reconciled: 0,
      removed: 0,
      added: 0,
      pageProportional: true,
    };
  }

  const boundary = indexOfMessage(index, first.id);
  let older: TranscriptMessage[];
  let pageProportional = true;
  if (boundary !== undefined) {
    older = cached.slice(0, boundary);
  } else {
    // A disjoint page is normal after eviction or resume. Cut at the timestamp boundary, then
    // filter duplicate ids defensively. The full filter is only for this malformed/non-overlap
    // fallback; a normal overlapping page never takes it.
    let cut = cached.length;
    while (cut > 0 && (cached[cut - 1]?.createdAt ?? 0) > first.createdAt) cut -= 1;
    const pageIDs = new Set(deduped.map((message) => message.id));
    older = cached.slice(0, cut).filter((message) => !pageIDs.has(message.id));
    pageProportional = false;
  }

  // Within the page only, keep the cached object when the server's payload is unchanged. The
  // latest page is the sole place a fresh DTO identity can appear, so this bounded comparison
  // preserves message/node identity without an accidental whole-history deep-equal path (#283,
  // #350). A genuine replacement keeps the server object.
  const canonical =
    boundary === undefined
      ? deduped
      : deduped.map((message, offset) => {
          const prior = cached[boundary + offset];
          return prior !== undefined && (prior === message || Bun.deepEquals(prior, message))
            ? prior
            : message;
        });

  const removedMessages = cached.length - older.length;
  const removedBytes = removeIds(index, cached, older.length);
  let addedBytes = { total: 0, text: 0, structure: 0 };
  for (const [offset, message] of canonical.entries()) {
    index.idToIndex.set(message.id, older.length + offset - index.baseOffset);
    addedBytes = addBytes(addedBytes, approximateMessageBytes(message));
  }
  index.bytes = subtractBytes(addBytes(index.bytes, addedBytes), removedBytes);

  const messages = older.length === 0 ? canonical : [...older, ...canonical];
  let firstChangedIndex = boundary ?? 0;
  if (boundary !== undefined) {
    while (
      firstChangedIndex < cached.length &&
      firstChangedIndex < messages.length &&
      cached[firstChangedIndex] === messages[firstChangedIndex]
    ) {
      firstChangedIndex += 1;
    }
  }
  index.messages = messages;
  return {
    messages,
    index,
    firstChangedIndex,
    reconciled: removedMessages + canonical.length,
    removed: removedMessages,
    added: canonical.length,
    pageProportional,
  };
}

/**
 * Prepends an older page, suppressing ids that are already cached. The existing id mappings
 * stay valid because the index stores relative positions and only `baseOffset` moves.
 */
export function prependOlderIndexed(
  cached: readonly TranscriptMessage[],
  currentIndex: TranscriptIndex | undefined,
  page: readonly TranscriptMessage[],
): PrependTranscriptOutcome {
  const index = ensureTranscriptIndex(currentIndex, cached);
  const older: TranscriptMessage[] = [];
  for (const message of page) {
    if (indexOfMessage(index, message.id) !== undefined) continue;
    older.push(message);
  }
  if (older.length === 0) {
    return { messages: [...cached], index, added: 0 };
  }
  const added = older.length;
  index.baseOffset += added;
  for (const [offset, message] of older.entries()) {
    index.idToIndex.set(message.id, offset - index.baseOffset);
  }
  let addedBytes = { total: 0, text: 0, structure: 0 };
  for (const message of older) addedBytes = addBytes(addedBytes, approximateMessageBytes(message));
  index.bytes = addBytes(index.bytes, addedBytes);
  const messages = [...older, ...cached];
  index.messages = messages;
  return { messages, index, added };
}
