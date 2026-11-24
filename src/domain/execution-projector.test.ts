import { describe, expect, test } from 'bun:test';

import { createExecutionMarkerProjector } from './execution-projector.ts';
import { executionMarkers } from './execution-segment.ts';
import type { TranscriptMessage } from './transcript.ts';

const model = { providerID: 'p', modelID: 'm' };

function user(id: string, createdAt: number): TranscriptMessage {
  return { kind: 'user', id, createdAt, text: `say: ${id}`, attachments: [] };
}

function assistant(id: string, createdAt: number, completedAt?: number): TranscriptMessage {
  return {
    kind: 'assistant',
    id,
    createdAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    agent: 'build',
    model,
    parts: [{ kind: 'text', text: id }],
  };
}

function idle(id: string, createdAt: number): TranscriptMessage {
  return { kind: 'idle', id, createdAt, outcome: 'succeeded' };
}

function turn(index: number): TranscriptMessage[] {
  const at = index * 100;
  return [
    user(`u${index}`, at),
    assistant(`a${index}`, at + 10, at + 20),
    idle(`i${index}`, at + 30),
  ];
}

function history(turns: number): TranscriptMessage[] {
  return Array.from({ length: turns }, (_, index) => turn(index)).flat();
}

function openTail(index: number): TranscriptMessage[] {
  const at = index * 100;
  return [user(`u${index}`, at), assistant(`a${index}`, at + 10)];
}

const reference = (messages: readonly TranscriptMessage[], running: boolean) =>
  executionMarkers(messages, running);

describe('incremental execution-marker projector (#349)', () => {
  test('a reset matches the pure derivation', () => {
    const messages = [...history(3), ...openTail(3)];
    const projector = createExecutionMarkerProjector();
    const projection = projector.project(messages, true, { kind: 'reset' });
    expect(projection.markers).toEqual(reference(messages, true));
    expect(projection.stats.messagesScanned).toBe(messages.length);
  });

  test('an append rescans only the open tail and reuses completed segments', () => {
    const messages = [...history(40), ...openTail(40)];
    const projector = createExecutionMarkerProjector();
    const first = projector.project(messages, true, { kind: 'reset' });
    const reused = first.markers[0];
    const appended = [...messages, assistant('a40-next', 9_000)];
    const projection = projector.project(appended, true, {
      kind: 'replace',
      firstChangedIndex: messages.length,
    });
    expect(projection.markers).toEqual(reference(appended, true));
    expect(projection.stats.messagesScanned).toBe(3);
    expect(projection.stats.segmentsReused).toBe(40);
    expect(projection.markers[0]).toBe(reused);
  });

  test('a running-state change rewrites only the trailing marker', () => {
    const messages = history(40);
    const projector = createExecutionMarkerProjector();
    projector.project(messages, false, { kind: 'reset' });
    const projection = projector.project(messages, true, { kind: 'tail' });
    expect(projection.markers).toEqual(reference(messages, true));
    expect(projection.stats.segmentsReused).toBe(40);
  });

  test('a replacement inside one completed segment invalidates that suffix', () => {
    const messages = [...history(3), ...openTail(3)];
    const projector = createExecutionMarkerProjector();
    const first = projector.project(messages, true, { kind: 'reset' });
    const changed: TranscriptMessage = { ...messages[4]!, createdAt: 999 };
    const next = [...messages];
    next[4] = changed;
    const projection = projector.project(next, true, { kind: 'replace', firstChangedIndex: 4 });
    expect(projection.markers).toEqual(reference(next, true));
    // Segments before turn 1 survive; turn 1 and everything after are rescanned.
    expect(projection.markers[0]).toBe(first.markers[0]);
    expect(projection.stats.messagesScanned).toBe(next.length - 3);
  });

  test('a prepend reuses closed segments after the junction', () => {
    const messages = [...history(3), ...openTail(3)];
    const projector = createExecutionMarkerProjector();
    const first = projector.project(messages, true, { kind: 'reset' });
    const older = turn(99).map((message) => ({ ...message, id: `old-${message.id}` }));
    const next = [...older, ...messages];
    const projection = projector.project(next, true, {
      kind: 'prepend',
      prependCount: older.length,
    });
    expect(projection.markers).toEqual(reference(next, true));
    // The first old segment at the junction is rebuilt; later closed segments keep their
    // identity. The trailing running marker is re-derived with the current running value.
    const reused = first.markers.find((marker) => marker.id === 'u2');
    expect(projection.markers.find((marker) => marker.id === 'u2')).toBe(reused);
    expect(projection.stats.segmentsReused).toBeGreaterThan(0);
    expect(projection.stats.messagesScanned).toBeLessThan(next.length);
  });

  test('a prepend that joins an open segment falls back to a full rescan', () => {
    const messages = [user('u0', 0), assistant('a0', 10)];
    const projector = createExecutionMarkerProjector();
    projector.project(messages, true, { kind: 'reset' });
    const older = [user('old-u', -100), assistant('old-a', -90)];
    const next = [...older, ...messages];
    const projection = projector.project(next, true, {
      kind: 'prepend',
      prependCount: older.length,
    });
    expect(projection.markers).toEqual(reference(next, true));
    expect(projection.stats.messagesScanned).toBe(next.length);
  });
});
