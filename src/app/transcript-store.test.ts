import { describe, expect, test } from 'bun:test';

import type { TranscriptMessage } from '../domain/transcript.ts';
import { approximateTranscriptBytes } from '../perf/memory.ts';
import { mergeLatest } from './controller.ts';
import {
  buildTranscriptIndex,
  indexOfMessage,
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
    let messages = Array.from({ length: 200 }, (_, index) =>
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
    let messages: TranscriptMessage[] = [user('m2', 2), user('m3', 3)];
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
    let messages = cached;
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
