import { describe, expect, test } from 'bun:test';

import type { TranscriptMessage } from '../domain/transcript.ts';
import { mergeLatest } from './controller.ts';

function user(id: string, createdAt: number, text = id): TranscriptMessage {
  return { kind: 'user', id, createdAt, text, attachments: [] };
}

const ids = (messages: readonly TranscriptMessage[]) => messages.map((message) => message.id);

describe('mergeLatest (#205)', () => {
  test('a cached message with the same timestamp as a disjoint page is preserved', () => {
    const merged = mergeLatest([user('a', 100)], [user('b', 100), user('c', 101)]);
    expect(ids(merged)).toEqual(['a', 'b', 'c']);
  });

  test('exact overlap replaces the covered messages with server data', () => {
    const merged = mergeLatest(
      [user('a', 1), user('b', 2, 'old'), user('c', 3)],
      [user('b', 2, 'edited'), user('c', 3)],
    );
    expect(ids(merged)).toEqual(['a', 'b', 'c']);
    expect(merged[1]).toMatchObject({ text: 'edited' });
  });

  test('older cached messages stay, newer cache-only messages are not invented back', () => {
    const merged = mergeLatest([user('a', 1), user('z', 50)], [user('b', 10)]);
    expect(ids(merged)).toEqual(['a', 'b']);
  });

  test('an empty page keeps the cache and ids are never duplicated', () => {
    expect(ids(mergeLatest([user('a', 1)], []))).toEqual(['a']);
    expect(ids(mergeLatest([user('a', 5)], [user('a', 5), user('b', 6)]))).toEqual(['a', 'b']);
  });
});
