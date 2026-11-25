import { describe, expect, test } from 'bun:test';

import { strings } from '../i18n/index.ts';
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

const reasoningMessage = (id: string, at: number) =>
  ({
    kind: 'assistant',
    id,
    createdAt: at,
    agent: 'build',
    model,
    parts: [{ kind: 'reasoning', text: 'hmm', done: false }],
  }) as const;
const compactionRecord = (id: string, state: 'running' | 'completed' | 'failed', at: number) =>
  ({ kind: 'compaction', id, createdAt: at, state }) as const;
const activityOf = (messages: Parameters<typeof markerAt>[0]) =>
  markerAt(messages, true)[0]?.activity;

function toolMessage(status: 'running' | 'completed' | 'streaming'): TranscriptMessage {
  return {
    kind: 'assistant',
    id: 'a',
    createdAt: 11,
    agent: 'build',
    model,
    parts: [
      {
        kind: 'tool',
        tool: { id: 't', name: 'shell', status, input: {}, startedAt: 12 },
      },
    ],
  };
}

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
      {
        id: 'u',
        afterMessageId: 'a',
        phase: 'running',
        startedAt: 11,
        activity: strings.throbber.activity.search,
      },
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
        activity: strings.throbber.compacting,
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
    expect(markers[0]?.activity).toBe(strings.throbber.thinking);
  });

  test('running → completed → reasoning never leaves a stale compaction status (#39)', () => {
    expect(
      activityOf([
        user('u', 10),
        reasoningMessage('a', 11),
        compactionRecord('c', 'running', 12),
        compactionRecord('c2', 'completed', 13),
        reasoningMessage('b', 14),
      ]),
    ).toBe(strings.throbber.thinking);
    // Model output after a still-"running" record also ends the status.
    expect(
      activityOf([user('u', 10), compactionRecord('c', 'running', 12), reasoningMessage('b', 14)]),
    ).toBe(strings.throbber.thinking);
    expect(
      activityOf([
        user('u', 10),
        compactionRecord('c', 'running', 12),
        compactionRecord('c2', 'failed', 13),
      ]),
    ).toBeUndefined();
    expect(
      activityOf([
        user('u', 10),
        compactionRecord('c', 'completed', 12),
        compactionRecord('c3', 'running', 20),
      ]),
    ).toBe(strings.throbber.compacting);
    expect(activityOf([user('u', 10), compactionRecord('c', 'completed', 12)])).toBeUndefined();
  });

  test('a finished tool never keeps labelling the running turn (issue #75)', () => {
    // A completed call leaves the phase to the throbber's own verb instead of "Running".
    expect(activityOf([user('u', 10), toolMessage('completed')])).toBeUndefined();
    expect(activityOf([user('u', 10), toolMessage('streaming')])).toBe(
      strings.throbber.activity.shell,
    );
    // Reasoning after the call is authoritative again.
    expect(activityOf([user('u', 10), toolMessage('completed'), reasoningMessage('r', 20)])).toBe(
      strings.throbber.thinking,
    );
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
