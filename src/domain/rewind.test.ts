import { describe, expect, test } from 'bun:test';

import { rewindCandidates, rewindTimeLabel } from './rewind.ts';
import type { TranscriptMessage } from './transcript.ts';

const user = (id: string, createdAt: number, text: string): TranscriptMessage => ({
  kind: 'user',
  id,
  createdAt,
  text,
  attachments: [],
});

describe('rewind prompts (#102)', () => {
  test('lists only user prompts, oldest first, with stable ordinals', () => {
    const candidates = rewindCandidates([
      user('u2', 20, 'second'),
      {
        kind: 'assistant',
        id: 'm1',
        createdAt: 21,
        agent: 'build',
        model: { providerID: 'p', modelID: 'm' },
        parts: [],
      },
      user('u1', 10, 'first\nwith detail'),
    ]);
    expect(candidates.map((item) => item.messageID)).toEqual(['u2', 'u1']);
    expect(candidates.map((item) => item.ordinal)).toEqual([1, 2]);
    expect(candidates[1]?.text).toContain('first');
  });

  test('timestamps carry an explicit UTC label so they are never mistaken for local time (#145)', () => {
    expect(rewindTimeLabel(0)).toBe('1970-01-01 00:00 UTC');
    expect(rewindTimeLabel(Date.UTC(2024, 0, 2, 3, 4))).toBe('2024-01-02 03:04 UTC');
  });

  test('corrupt and unrepresentable timestamps are labelled, never thrown (#145)', () => {
    expect(rewindTimeLabel(Number.NaN)).toBe('time unknown');
    expect(rewindTimeLabel(Number.POSITIVE_INFINITY)).toBe('time unknown');
    expect(rewindTimeLabel(Number.NEGATIVE_INFINITY)).toBe('time unknown');
    expect(rewindTimeLabel(1e20)).toBe('time unknown');
    expect(rewindTimeLabel(-1e20)).toBe('time unknown');
  });
});
