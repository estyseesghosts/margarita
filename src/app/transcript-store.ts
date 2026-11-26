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
  /** Tool ID -> owning message ID, maintained with the same page-sized deltas. */
  readonly toolMessages: Map<string, string>;
  baseOffset: number;
  bytes: RetainedBytes;
  /** Monotonic change revision; transferred to the produced message view. */
  revision: number;
};

/**
 * Canonical transcript storage as immutable pages rather than one flat array. The view is
 * array-compatible for existing consumers (`length`, indexed access, iteration, `map`,
 * `slice`, ...) but the message references live in shared chunks. Replacing the latest server
 * page or prepending an older one creates new chunks at the edge only; the retained prefix is
 * shared by reference, with no deep clone and no `toArray().slice()` flattening.
 */
export interface TranscriptMessageView extends ReadonlyArray<TranscriptMessage> {
  /** Increments on every structural commit; an explicit change/robustness boundary. */
  readonly revision: number;
  /** First canonical index changed by the commit that produced this view. */
  readonly changeBoundary: number | undefined;
  /** Number of retained chunks; useful for asserting page sharing in tests/benchmarks. */
  chunkCount(): number;
  /** Direct read of the retained chunks (read-only). */
  chunks(): readonly (readonly TranscriptMessage[])[];
  /** Flattens explicitly. Callers that can use `at`/`range` should avoid this. */
  toArray(): TranscriptMessage[];
  /** Copies a half-open range with one allocation, in forward order. */
  range(start: number, end: number): TranscriptMessage[];
  /** Exact chunks for `[start, end)`, sharing whole chunks and slicing at most one edge. */
  chunkRange(start: number, end: number): (readonly TranscriptMessage[])[];
  replaceTail(
    boundary: number,
    page: readonly TranscriptMessage[],
    revision: number,
    changeBoundary?: number,
  ): TranscriptMessageView;
  prependOlder(older: readonly TranscriptMessage[], revision: number): TranscriptMessageView;
  /** Drops `count` leading messages, keeping only whole trailing chunks (reloadable pages). */
  evictPrefix(count: number, revision: number): TranscriptMessageView;
}

/** True when an array-like value is already a paged view. */
export function isTranscriptMessageView(messages: unknown): messages is TranscriptMessageView {
  return (
    typeof messages === 'object' &&
    messages !== null &&
    'chunkCount' in messages &&
    typeof messages.chunkCount === 'function'
  );
}

/** Wraps an array once; an existing paged view is returned unchanged. */
export function asTranscriptMessageView(
  messages: readonly TranscriptMessage[],
): TranscriptMessageView {
  return isTranscriptMessageView(messages) ? messages : createTranscriptMessageView(messages);
}

class PagedTranscriptMessages {
  readonly length: number;
  private readonly offsets: number[] = [];

  constructor(
    private readonly parts: readonly (readonly TranscriptMessage[])[],
    readonly revision: number,
    readonly changeBoundary: number | undefined,
  ) {
    let total = 0;
    for (const chunk of parts) {
      this.offsets.push(total);
      total += chunk.length;
    }
    this.length = total;
  }

  at(index: number): TranscriptMessage | undefined {
    const position = index < 0 ? this.length + index : index;
    if (position < 0 || position >= this.length) return undefined;
    let low = 0;
    let high = this.parts.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const start = this.offsets[middle] ?? 0;
      const chunk = this.parts[middle];
      if (chunk === undefined) return undefined;
      if (position < start) high = middle - 1;
      else if (position >= start + chunk.length) low = middle + 1;
      else return chunk[position - start];
    }
    return undefined;
  }

  range(start: number, end: number): TranscriptMessage[] {
    const from = Math.max(0, Math.min(this.length, start));
    const to = Math.max(from, Math.min(this.length, end));
    const count = to - from;
    if (count === 0) return [];
    const result: TranscriptMessage[] = [];
    result.length = count;
    let written = 0;
    for (let index = 0; index < this.parts.length && written < count; index += 1) {
      const chunk = this.parts[index];
      if (chunk === undefined) continue;
      const chunkStart = this.offsets[index] ?? 0;
      if (chunkStart + chunk.length <= from) continue;
      if (chunkStart >= to) break;
      const copyFrom = Math.max(0, from - chunkStart);
      const available = Math.min(chunk.length - copyFrom, count - written);
      for (let offset = 0; offset < available; offset += 1) {
        result[written + offset] = chunk[copyFrom + offset]!;
      }
      written += available;
    }
    return result;
  }

  chunkRange(start: number, end: number): (readonly TranscriptMessage[])[] {
    const from = Math.max(0, Math.min(this.length, start));
    const to = Math.max(from, Math.min(this.length, end));
    if (from === to) return [];
    const chunks: (readonly TranscriptMessage[])[] = [];
    for (let index = 0; index < this.parts.length; index += 1) {
      const chunk = this.parts[index];
      if (chunk === undefined) continue;
      const chunkStart = this.offsets[index] ?? 0;
      const chunkEnd = chunkStart + chunk.length;
      if (chunkEnd <= from || chunkStart >= to) continue;
      const sliceFrom = Math.max(0, from - chunkStart);
      const sliceTo = Math.min(chunk.length, to - chunkStart);
      chunks.push(
        sliceFrom === 0 && sliceTo === chunk.length ? chunk : chunk.slice(sliceFrom, sliceTo),
      );
    }
    return chunks;
  }

  toArray(): TranscriptMessage[] {
    return this.parts.flat();
  }

  map<U>(callback: (message: TranscriptMessage, index: number) => U): U[] {
    const out: U[] = [];
    for (let index = 0; index < this.length; index += 1) {
      const message = this.at(index);
      if (message !== undefined) out.push(callback(message, index));
    }
    return out;
  }

  slice(start?: number, end?: number): TranscriptMessage[] {
    return this.range(start ?? 0, end ?? this.length);
  }

  forEach(callback: (message: TranscriptMessage, index: number) => void): void {
    for (let index = 0; index < this.length; index += 1) {
      const message = this.at(index);
      if (message !== undefined) callback(message, index);
    }
  }

  find(predicate: (message: TranscriptMessage) => boolean): TranscriptMessage | undefined {
    for (let index = 0; index < this.length; index += 1) {
      const message = this.at(index);
      if (message !== undefined && predicate(message)) return message;
    }
    return undefined;
  }

  filter(predicate: (message: TranscriptMessage) => boolean): TranscriptMessage[] {
    const out: TranscriptMessage[] = [];
    for (let index = 0; index < this.length; index += 1) {
      const message = this.at(index);
      if (message !== undefined && predicate(message)) out.push(message);
    }
    return out;
  }

  some(predicate: (message: TranscriptMessage) => boolean): boolean {
    for (let index = 0; index < this.length; index += 1) {
      const message = this.at(index);
      if (message !== undefined && predicate(message)) return true;
    }
    return false;
  }

  flatMap<U>(callback: (message: TranscriptMessage, index: number) => U[]): U[] {
    const out: U[] = [];
    for (let index = 0; index < this.length; index += 1) {
      const message = this.at(index);
      if (message !== undefined) out.push(...callback(message, index));
    }
    return out;
  }

  *entries(): IterableIterator<[number, TranscriptMessage]> {
    for (let index = 0; index < this.length; index += 1) {
      const message = this.at(index);
      if (message !== undefined) yield [index, message];
    }
  }

  *[Symbol.iterator](): IterableIterator<TranscriptMessage> {
    for (const chunk of this.parts) yield* chunk;
  }

  chunkCount(): number {
    return this.parts.length;
  }

  chunks(): readonly (readonly TranscriptMessage[])[] {
    return this.parts;
  }

  replaceTail(
    boundary: number,
    page: readonly TranscriptMessage[],
    revision: number,
    changeBoundary?: number,
  ): TranscriptMessageView {
    const prefix = this.chunkRange(0, boundary);
    return createTranscriptMessageViewFromChunks(
      [...prefix, ...(page.length === 0 ? [] : [page])],
      revision,
      changeBoundary,
    );
  }

  prependOlder(older: readonly TranscriptMessage[], revision: number): TranscriptMessageView {
    return createTranscriptMessageViewFromChunks(
      [...(older.length === 0 ? [] : [older]), ...this.parts],
      revision,
      this.changeBoundary,
    );
  }

  evictPrefix(count: number, revision: number): TranscriptMessageView {
    const chunks = this.chunkRange(Math.max(0, count), this.length);
    return createTranscriptMessageViewFromChunks(chunks, revision, this.changeBoundary);
  }
}

/** Creates a paged view from existing chunks, sharing every retained chunk by reference. */
function createTranscriptMessageViewFromChunks(
  chunks: readonly (readonly TranscriptMessage[])[],
  revision: number,
  changeBoundary: number | undefined,
): TranscriptMessageView {
  const store = new PagedTranscriptMessages(chunks, revision, changeBoundary);
  const proxy: unknown = new Proxy(store, {
    get(target, property) {
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        return target.at(Number(property));
      }
      const value = Reflect.get(target, property, target);
      if (value !== undefined) {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      // Full array compatibility for uncommon methods (indexOf, concat, join, ...).
      const arrayMethod: unknown = Reflect.get(Array.prototype, property);
      if (typeof arrayMethod === 'function') {
        return (...args: unknown[]) => arrayMethod.apply(target.toArray(), args);
      }
      return value;
    },
  });
  // The proxy target is intentionally private; only the array-compatible facade escapes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return proxy as TranscriptMessageView;
}

/** Creates a paged view from a flat array. The array is retained by reference, not cloned. */
export function createTranscriptMessageView(
  messages: readonly TranscriptMessage[],
  revision = 0,
  changeBoundary?: number,
): TranscriptMessageView {
  return createTranscriptMessageViewFromChunks(
    messages.length === 0 ? [] : [messages],
    revision,
    changeBoundary,
  );
}

export type MergeTranscriptOutcome = Readonly<{
  /** Array-compatible paged view; assign this to canonical state, never `toArray()`. */
  messages: TranscriptMessageView;
  view: TranscriptMessageView;
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
  /** Array-compatible paged view; assign this to canonical state, never `toArray()`. */
  messages: TranscriptMessageView;
  view: TranscriptMessageView;
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
  const toolMessages = new Map<string, string>();
  for (const [index, message] of messages.entries()) {
    // Malformed payloads may repeat an id. The first position is canonical; a later duplicate
    // still renders but must not steal the boundary lookup from the earlier message.
    if (!idToIndex.has(message.id)) idToIndex.set(message.id, index);
    if (message.kind !== 'assistant') continue;
    for (const part of message.parts) {
      if (part.kind === 'tool') toolMessages.set(part.tool.id, message.id);
    }
  }
  return {
    messages,
    idToIndex,
    toolMessages,
    baseOffset: 0,
    bytes: approximateTranscriptBytes(messages),
    revision: 0,
  };
}

/** Owning message id for a rendered tool call, if it is loaded. */
export function messageIDOfTool(index: TranscriptIndex, toolID: string): string | undefined {
  return index.toolMessages.get(toolID);
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
    if (message.kind === 'assistant') {
      for (const part of message.parts) {
        if (part.kind === 'tool') index.toolMessages.delete(part.tool.id);
      }
    }
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
  const unchanged = asTranscriptMessageView(cached);
  if (page.length === 0) {
    const messages = unchanged;
    index.messages = messages;
    return {
      messages,
      view: unchanged,
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
    const messages = unchanged;
    index.messages = messages;
    return {
      messages,
      view: unchanged,
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
    if (message.kind === 'assistant') {
      for (const part of message.parts) {
        if (part.kind === 'tool') index.toolMessages.set(part.tool.id, message.id);
      }
    }
    addedBytes = addBytes(addedBytes, approximateMessageBytes(message));
  }
  index.bytes = subtractBytes(addBytes(index.bytes, addedBytes), removedBytes);

  let firstChangedIndex = boundary ?? 0;
  let view: TranscriptMessageView;
  if (pageProportional) {
    // Shared prefix chunks; only the latest page becomes a new chunk.
    view = unchanged.replaceTail(older.length, canonical, index.revision + 1, firstChangedIndex);
    while (
      firstChangedIndex < cached.length &&
      firstChangedIndex < view.length &&
      cached[firstChangedIndex] === view[firstChangedIndex]
    ) {
      firstChangedIndex += 1;
    }
    if (firstChangedIndex !== view.changeBoundary) {
      view = unchanged.replaceTail(older.length, canonical, index.revision + 1, firstChangedIndex);
    }
  } else {
    // Defensive malformed/disjoint page: filtering the prefix invalidates chunk boundaries.
    view = createTranscriptMessageView(
      [...older, ...canonical],
      index.revision + 1,
      firstChangedIndex,
    );
  }
  index.revision += 1;
  const messages = view;
  index.messages = messages;
  return {
    messages,
    view,
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
  const unchanged = asTranscriptMessageView(cached);
  if (older.length === 0) {
    const messages = unchanged;
    index.messages = messages;
    return { messages, view: unchanged, index, added: 0 };
  }
  const added = older.length;
  index.baseOffset += added;
  for (const [offset, message] of older.entries()) {
    index.idToIndex.set(message.id, offset - index.baseOffset);
    if (message.kind === 'assistant') {
      for (const part of message.parts) {
        if (part.kind === 'tool') index.toolMessages.set(part.tool.id, message.id);
      }
    }
  }
  let addedBytes = { total: 0, text: 0, structure: 0 };
  for (const message of older) addedBytes = addBytes(addedBytes, approximateMessageBytes(message));
  index.bytes = addBytes(index.bytes, addedBytes);
  const view = unchanged.prependOlder(older, index.revision + 1);
  index.revision += 1;
  const messages = view;
  index.messages = messages;
  return { messages, view, index, added };
}
