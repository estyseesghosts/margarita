import { describe, expect, test } from 'bun:test';

import type { TranscriptMessage } from '../domain/transcript.ts';
import { approximateTranscriptBytes } from '../perf/memory.ts';
import { mergeLatest } from './controller.ts';
import {
  asTranscriptMessageView,
  buildTranscriptIndex,
  createTranscriptMessageView,
  indexOfMessage,
  isTranscriptMessageView,
  mergeLatestIndexed,
  prependOlderIndexed,
} from './transcript-store.ts';

function user(id: string, createdAt: number, text = id): TranscriptMessage {
  return { kind: 'user', id, createdAt, text, attachments: [] };
}

const ids = (messages: readonly TranscriptMessage[]) => messages.map((message) => message.id);

describe('indexed latest-page reconciliation (#350)', () => {
  test('matches the reference merge for overlap, disjoint pages and empty pages', () => {
    const cached = [user('a', 1), user('b', 2, 'old'), user('c', 3)];
    for (const page of [
      [user('b', 2, 'edited'), user('c', 3)],
      [user('d', 10)],
      [],
      [user('a', 1), user('b', 2, 'edited')],
    ]) {
      const outcome = mergeLatestIndexed(cached, buildTranscriptIndex(cached), page);
      expect(ids(outcome.messages)).toEqual(ids(mergeLatest(cached, page)));
      expect(outcome.index.bytes.total).toBe(approximateTranscriptBytes(outcome.messages).total);
    }
  });

  test('randomized replacements, deletions and additions keep ids and bytes exact', () => {
    let messages: readonly TranscriptMessage[] = Array.from({ length: 200 }, (_, index) =>
      user(`m${index}`, index, `payload ${index}`),
    );
    let index = buildTranscriptIndex(messages);
    for (let round = 0; round < 60; round += 1) {
      const size = 10 + (round % 20);
      const start = Math.max(0, messages.length - size);
      const page = messages.slice(start).map((message) => ({ ...message }));
      const edit = page[round % page.length];
      if (edit !== undefined && edit.kind === 'user') {
        page[round % page.length] = { ...edit, text: `edited ${round}` } as TranscriptMessage;
      }
      if (page.length > 3 && round % 3 === 0) page.splice(1, 1);
      if (round % 4 === 0) {
        page.push(user(`extra${round}`, 10_000 + round, 'x'.repeat(round * 37)));
      }
      const outcome = mergeLatestIndexed(messages, index, page);
      expect(ids(outcome.messages)).toEqual(ids(mergeLatest(messages, page)));
      expect(new Set(ids(outcome.messages)).size).toBe(outcome.messages.length);
      expect(outcome.index.bytes.total).toBe(approximateTranscriptBytes(outcome.messages).total);
      expect(outcome.firstChangedIndex).toBeLessThanOrEqual(outcome.messages.length);
      for (const [position, message] of outcome.messages.entries()) {
        expect(indexOfMessage(outcome.index, message.id)).toBe(position);
      }
      messages = outcome.messages;
      index = outcome.index;
    }
  });

  test('a 120-message page reconciles page-sized work in a 50k history', () => {
    const messages = Array.from({ length: 50_000 }, (_, item) =>
      user(`m${item}`, item, `v${item}`),
    );
    const index = buildTranscriptIndex(messages);
    const page = messages.slice(-120).map((message) => ({ ...message }));
    const last = page.at(-1);
    if (last === undefined || last.kind !== 'user') throw new Error('page fixture is not a user');
    page[page.length - 1] = { ...last, text: 'replaced' };
    const outcome = mergeLatestIndexed(messages, index, page);
    expect(outcome.pageProportional).toBe(true);
    expect(outcome.reconciled).toBeLessThanOrEqual(240);
    // Only the replaced tail message differs; unchanged page objects were reused by identity.
    expect(outcome.firstChangedIndex).toBe(49_999);
    expect(outcome.messages).toHaveLength(50_000);
    expect(outcome.index.bytes.total).toBe(approximateTranscriptBytes(outcome.messages).total);
  });

  test('duplicate ids in a malformed page never duplicate the transcript', () => {
    const cached = [user('a', 1), user('b', 2)];
    const outcome = mergeLatestIndexed(cached, buildTranscriptIndex(cached), [
      user('b', 2, 'first'),
      user('c', 3),
      user('b', 2, 'second'),
    ]);
    expect(ids(outcome.messages)).toEqual(['a', 'b', 'c']);
    expect(outcome.messages[1]).toMatchObject({ text: 'first' });
  });

  test('a disjoint newer page keeps cached history and reports the fallback', () => {
    const cached = Array.from({ length: 1_000 }, (_, index) => user(`m${index}`, index));
    const page = [user('new-1', 10_000), user('new-2', 10_001)];
    const outcome = mergeLatestIndexed(cached, buildTranscriptIndex(cached), page);
    expect(outcome.pageProportional).toBe(false);
    expect(outcome.messages).toHaveLength(1_002);
    expect(outcome.index.bytes.total).toBe(approximateTranscriptBytes(outcome.messages).total);
  });
});

describe('indexed older-page prepend (#350)', () => {
  test('prepends unique rows and suppresses duplicates without rebuilding id maps', () => {
    const cached = [user('b', 2), user('c', 3)];
    const older = [user('a', 1), user('b', 2), user('zero', 0, 'x'.repeat(10_000))];
    const outcome = prependOlderIndexed(cached, buildTranscriptIndex(cached), older);
    expect(outcome.added).toBe(2);
    expect(ids(outcome.messages)).toEqual(['a', 'zero', 'b', 'c']);
    expect(outcome.index.bytes.total).toBe(approximateTranscriptBytes(outcome.messages).total);
    for (const [position, message] of outcome.messages.entries()) {
      expect(indexOfMessage(outcome.index, message.id)).toBe(position);
    }
  });

  test('repeated prepends keep relative indices valid', () => {
    let messages: readonly TranscriptMessage[] = [user('m2', 2), user('m3', 3)];
    let index = buildTranscriptIndex(messages);
    for (let round = 0; round < 20; round += 1) {
      const older = [user(`old${round}`, -round - 1)];
      const outcome = prependOlderIndexed(messages, index, older);
      messages = outcome.messages;
      index = outcome.index;
      expect(outcome.added).toBe(1);
      expect(index.bytes.total).toBe(approximateTranscriptBytes(messages).total);
    }
    for (const [position, message] of messages.entries()) {
      expect(indexOfMessage(index, message.id)).toBe(position);
    }
  });

  test('a large payload replaced by a smaller one updates bytes exactly', () => {
    const cached = [user('a', 1, 'x'.repeat(200_000)), user('b', 2)];
    let index = buildTranscriptIndex(cached);
    const before = index.bytes.total;
    let messages: readonly TranscriptMessage[] = cached;
    const smaller = mergeLatestIndexed(messages, index, [user('a', 1, 'tiny'), user('b', 2)]);
    expect(smaller.index.bytes.total).toBeLessThan(before);
    expect(smaller.index.bytes.total).toBe(approximateTranscriptBytes(smaller.messages).total);
    messages = smaller.messages;
    index = smaller.index;
    const larger = mergeLatestIndexed(messages, index, [
      user('a', 1, 'y'.repeat(400_000)),
      user('b', 2),
    ]);
    expect(larger.index.bytes.total).toBe(approximateTranscriptBytes(larger.messages).total);
  });
});

function makeMessages(from: number, count: number): TranscriptMessage[] {
  return Array.from({ length: count }, (_unused, index) =>
    user(`m${from + index}`, from + index, `payload ${from + index}`),
  );
}

describe('paged TranscriptMessageView (slow.txt task 8)', () => {
  test('is array-compatible but stores messages in shared chunks', () => {
    const view = createTranscriptMessageView(makeMessages(0, 6));
    expect(isTranscriptMessageView(view)).toBe(true);
    expect(view.length).toBe(6);
    expect(view[3]?.id).toBe('m3');
    expect(view.at(-1)?.id).toBe('m5');
    expect(ids(view)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
    expect(ids(view.slice(2, 5))).toEqual(['m2', 'm3', 'm4']);
    expect(ids(view.range(1, 3))).toEqual(['m1', 'm2']);
    expect([...view].length).toBe(6);
    expect(view.chunkCount()).toBe(1);
    expect(view.revision).toBe(0);
  });

  test('tail replacement shares the prefix chunk and only adds one page chunk', () => {
    // Two page-sized chunks: the replacement boundary aligns with the chunk edge, so the
    // older chunk is shared by reference rather than sliced.
    const view = createTranscriptMessageView(makeMessages(990, 10), 3).prependOlder(
      makeMessages(0, 990),
      4,
    );
    const next = view.replaceTail(990, makeMessages(990, 20), 5, 990);
    expect(next.length).toBe(1010);
    expect(next.chunkCount()).toBe(2);
    expect(next.chunks()[0]).toBe(view.chunks()[0]);
    expect(next.revision).toBe(5);
    expect(next.changeBoundary).toBe(990);
    expect(next[989]?.id).toBe('m989');
    expect(next[990]?.id).toBe('m990');
  });

  test('older prepend inserts one chunk and shares the cached chunks', () => {
    const view = createTranscriptMessageView(makeMessages(100, 50), 2);
    const next = view.prependOlder(makeMessages(0, 100), 3);
    expect(next.length).toBe(150);
    expect(next.chunkCount()).toBe(2);
    expect(next.chunks()[1]).toBe(view.chunks()[0]);
    expect(next.revision).toBe(3);
    expect(next[0]?.id).toBe('m0');
    expect(next[100]?.id).toBe('m100');
  });

  test('canonical reconciliation never flattens the retained prefix', () => {
    // Page-sized chunks mirror how the controller builds canonical history over time.
    let cached = createTranscriptMessageView(makeMessages(49_920, 80));
    for (let start = 49_800; start >= 0; start -= 120) {
      cached = cached.prependOlder(makeMessages(start, 120), cached.revision + 1);
    }
    const index = buildTranscriptIndex(cached);
    expect(cached.length).toBe(50_000);
    const prefixChunks = cached.chunks().slice();
    const tail = makeMessages(49_920, 80);
    tail[0] = user('m49920', 49_920, 'replaced');
    const outcome = mergeLatestIndexed(cached, index, tail);
    const mergedView = asTranscriptMessageView(outcome.messages);
    expect(isTranscriptMessageView(outcome.messages)).toBe(true);
    expect(outcome.firstChangedIndex).toBe(49_920);
    expect(mergedView.chunkCount()).toBe(prefixChunks.length);
    for (let position = 0; position < prefixChunks.length - 1; position += 1) {
      expect(mergedView.chunks()[position]).toBe(prefixChunks[position]);
    }
    expect(outcome.index.revision).toBe(1);

    const olderPage = Array.from({ length: 120 }, (_unused, position) =>
      user(`older${position}`, -120 + position),
    );
    const prepended = prependOlderIndexed(outcome.messages, outcome.index, olderPage);
    const prependedView = asTranscriptMessageView(prepended.messages);
    expect(isTranscriptMessageView(prepended.messages)).toBe(true);
    expect(prependedView.chunks()).toContain(prefixChunks[0]!);
    expect(prepended.index.revision).toBe(2);
    expect(prepended.messages.length).toBe(50_120);
  });
});
