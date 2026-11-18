import { describe, expect, test } from 'bun:test';

import { executionMarkers } from './execution-segment.ts';
import type { TranscriptMessage } from './transcript.ts';

const model = { providerID: 'p', modelID: 'm' };

function user(id: string, createdAt: number): TranscriptMessage {
  return { kind: 'user', id, createdAt, text: `say: ${id}`, attachments: [] };
}

function assistant(
  id: string,
  createdAt: number,
  completedAt?: number,
  error?: string,
): TranscriptMessage {
  return {
    kind: 'assistant',
    id,
    createdAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    agent: 'build',
    model,
    parts: [],
    ...(error === undefined ? {} : { error }),
  };
}

function idle(
  id: string,
  createdAt: number,
  outcome: 'succeeded' | 'failed' | 'interrupted',
): TranscriptMessage {
  return { kind: 'idle', id, createdAt, outcome };
}

const markerAt = (messages: readonly TranscriptMessage[], running: boolean) =>
  executionMarkers(messages, running);

describe('executionMarkers', () => {
  test('a bare queued user message produces no marker', () => {
    expect(markerAt([user('u', 10)], false)).toEqual([]);
  });

  test('a completed segment reports wall time, completion time, and its id', () => {
    const markers = markerAt(
      [user('u1', 100), assistant('a', 110, 220), idle('i', 230, 'succeeded')],
      false,
    );
    expect(markers).toEqual([
      {
        id: 'u1',
        afterMessageId: 'i',
        phase: 'completed',
        startedAt: 110,
        completedAt: 230,
        durationMs: 120,
      },
    ]);
  });

  test('two sequential completed segments keep their own identities and durations', () => {
    const markers = markerAt(
      [
        user('u1', 100),
        assistant('a1', 110, 130),
        idle('i1', 140, 'succeeded'),
        user('u2', 200),
        assistant('a2', 210, 240),
        idle('i2', 250, 'interrupted'),
      ],
      false,
    );
    expect(markers.map((marker) => [marker.id, marker.phase, marker.durationMs])).toEqual([
      ['u1', 'completed', 30],
      ['u2', 'interrupted', 40],
    ]);
  });

  test('an interrupted or failed outcome comes from idle, not the assistant message', () => {
    const markers = markerAt(
      [user('u', 10), assistant('a', 11, 25), idle('i', 50, 'interrupted')],
      false,
    );
    expect(markers[0]?.phase).toBe('interrupted');
    expect(markers[0]?.completedAt).toBe(50);
  });

  test('prompts steered into a running turn share its single marker', () => {
    const markers = markerAt(
      [
        user('u1', 100),
        assistant('a1', 110, undefined),
        user('u2', 120), // steered follow-up mid-turn; still one execution
        assistant('a2', 130, 250),
        idle('i', 260, 'succeeded'),
      ],
      false,
    );
    expect(markers).toEqual([
      {
        id: 'u1',
        afterMessageId: 'i',
        phase: 'completed',
        startedAt: 110,
        completedAt: 260,
        durationMs: 150,
      },
    ]);
  });

  test('the running segment is only the last one; a queued follow-up does not reset it', () => {
    const markers = markerAt(
      [user('u1', 10), assistant('a1', 11, 12), idle('i1', 13, 'succeeded'), user('u2', 20)],
      true,
    );
    expect(markers.map((marker) => [marker.id, marker.phase])).toEqual([
      ['u1', 'completed'],
      ['u2', 'running'],
    ]);
  });

  test('a running segment reports the most recent tool category as its activity', () => {
    const markers = markerAt(
      [
        user('u', 10),
        {
          kind: 'assistant',
          id: 'a',
          createdAt: 11,
          agent: 'build',
          model,
          parts: [
            {
              kind: 'tool',
              tool: { id: 't', name: 'grep', status: 'running', input: {}, startedAt: 12 },
            },
          ],
        },
      ],
      true,
    );
    expect(markers).toEqual([
      { id: 'u', afterMessageId: 'a', phase: 'running', startedAt: 11, activity: 'Searching' },
    ]);
  });

  test('a running compaction reports the compaction phase', () => {
    const markers = markerAt(
      [user('u', 10), { kind: 'compaction', id: 'c', createdAt: 12, state: 'running' }],
      true,
    );
    expect(markers).toEqual([
      {
        id: 'u',
        afterMessageId: 'c',
        phase: 'running',
        startedAt: 10,
        activity: 'Compacting conversation',
      },
    ]);
  });

  test('a completed compaction falls back to the underlying agent activity', () => {
    const markers = markerAt(
      [
        user('u', 10),
        {
          kind: 'assistant',
          id: 'a',
          createdAt: 11,
          agent: 'build',
          model,
          parts: [{ kind: 'reasoning', text: 'hmm', done: false }],
        },
        { kind: 'compaction', id: 'c', createdAt: 20, state: 'completed' },
      ],
      true,
    );
    expect(markers[0]?.activity).toBe('Thinking');
  });

  test('an interrupted assistant message with no idle of its own still terminates via idle', () => {
    const markers = markerAt(
      [user('u', 10), assistant('a', 11, 41, 'boom'), idle('i', 60, 'failed')],
      false,
    );
    expect(markers[0]).toMatchObject({ id: 'u', phase: 'failed', completedAt: 60 });
  });

  test('an assistant-completed segment without idle yields a qualified completion', () => {
    const markers = markerAt([user('u', 10), assistant('a', 11, 41)], false);
    expect(markers[0]).toEqual({
      id: 'u',
      afterMessageId: 'a',
      phase: 'completed',
      startedAt: 11,
      completedAt: 41,
      durationMs: 30,
    });
  });

  test('the measured wall time anchors to the assistant message, not the queued user message', () => {
    const messages = [user('u', 10), assistant('a', 200, 300), idle('i', 310, 'succeeded')];
    expect(markerAt(messages, false)[0]).toMatchObject({ startedAt: 200, durationMs: 110 });
  });
});
