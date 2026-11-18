import { describe, expect, test } from 'bun:test';

import type { BackendEvent } from '../domain/backend-event.ts';
import { reconnectDelay, startEventPump, type StreamStatus } from './event-pump.ts';

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

const changed = (sessionID: string): BackendEvent => ({ kind: 'transcript-changed', sessionID });

function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error('timed out'));
      else setTimeout(check, 5);
    };
    check();
  });
}

describe('event pump', () => {
  test('connect triggers a resync, then events arrive in batches in order', async () => {
    const batches: { events: readonly BackendEvent[]; resync: boolean }[] = [];
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const stop = startEventPump({
      flushIntervalMs: 1,
      source: async function* (signal) {
        yield { kind: 'connected' };
        await gate;
        yield changed('a');
        yield changed('b');
        await untilAborted(signal);
      },
      onBatch: (events, resync) => batches.push({ events, resync }),
      onStatus: () => undefined,
    });
    await waitFor(() => batches.length === 1);
    expect(batches[0]).toEqual({ events: [], resync: true });
    release();
    await waitFor(() => batches.length === 2);
    expect(batches[1]).toEqual({ events: [changed('a'), changed('b')], resync: false });
    await stop();
  });

  test('overflow drops the buffer and requests a resync', async () => {
    const batches: { count: number; resync: boolean }[] = [];
    const stop = startEventPump({
      maxBuffered: 3,
      flushIntervalMs: 20,
      source: async function* (signal) {
        for (let index = 0; index < 10; index += 1) yield changed(String(index));
        await untilAborted(signal);
      },
      onBatch: (events, resync) => batches.push({ count: events.length, resync }),
      onStatus: () => undefined,
    });
    await waitFor(() => batches.length > 0);
    expect(batches[0]).toEqual({ count: 0, resync: true });
    await stop();
  });

  test('a dropped stream reconnects with backoff and reports status', async () => {
    const statuses: StreamStatus[] = [];
    const sleeps: number[] = [];
    let connections = 0;
    const stop = startEventPump({
      flushIntervalMs: 1,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      source: async function* (signal) {
        connections += 1;
        if (connections < 3) throw new Error('socket closed');
        yield { kind: 'connected' };
        await untilAborted(signal);
      },
      onBatch: () => undefined,
      onStatus: (status) => statuses.push(status),
    });
    await waitFor(() => statuses.includes('live'));
    expect(sleeps).toEqual([500, 1000]);
    expect(statuses).toEqual(['connecting', 'reconnecting', 'reconnecting', 'live']);
    await stop();
  });

  test('backoff is capped with jitter', () => {
    expect(reconnectDelay(0, () => 0)).toBe(400);
    expect(reconnectDelay(50, () => 1)).toBe(15_000);
  });
});
