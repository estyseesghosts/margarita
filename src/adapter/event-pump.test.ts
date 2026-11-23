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

/** A manually fired first-event watchdog, so never-yield streams can be tested without waiting. */
function fakeWatchdog() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    schedule: (fire: () => void, _ms: number) => {
      const id = ++next;
      pending.set(id, fire);
      return () => pending.delete(id);
    },
    fireAll: () => {
      const due = [...pending.values()];
      pending.clear();
      for (const fire of due) fire();
    },
    count: () => pending.size,
  };
}

function neverYieldingSource(signal: AbortSignal): AsyncIterable<BackendEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<BackendEvent>> {
          await untilAborted(signal);
          return { done: true, value: undefined };
        },
      };
    },
  };
}

describe('first-event watchdog (#342)', () => {
  test('a stream that never yields triggers reconnect and a fresh attempt', async () => {
    const timers = fakeWatchdog();
    const statuses: StreamStatus[] = [];
    const sleeps: number[] = [];
    let connections = 0;
    const stop = startEventPump({
      timeToFirstEventMs: 1000,
      scheduleTimeout: timers.schedule,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      source: (signal) => {
        connections += 1;
        return neverYieldingSource(signal);
      },
      onStatus: (status) => statuses.push(status),
      onBatch: () => undefined,
    });
    await waitFor(() => timers.count() === 1);
    timers.fireAll();
    await waitFor(() => connections === 2);
    expect(statuses).toContain('reconnecting');
    expect(sleeps).toEqual([500]);
    // The fresh attempt armed its own watchdog; no indefinite `connecting`.
    expect(timers.count()).toBe(1);
    await stop();
  });

  test('a first frame before the deadline clears the watchdog and goes live', async () => {
    const timers = fakeWatchdog();
    const statuses: StreamStatus[] = [];
    const { promise: gate, resolve } = Promise.withResolvers<void>();
    const stop = startEventPump({
      timeToFirstEventMs: 1000,
      scheduleTimeout: timers.schedule,
      source: (signal) =>
        (async function* () {
          await gate;
          yield { kind: 'connected' };
          await untilAborted(signal);
        })(),
      onStatus: (status) => statuses.push(status),
      onBatch: () => undefined,
    });
    await waitFor(() => timers.count() === 1);
    resolve();
    await waitFor(() => statuses.includes('live'));
    expect(timers.count()).toBe(0);
    // An idle, connected stream stays live without periodic reconnection.
    await new Promise((done) => setTimeout(done, 20));
    expect(statuses).toEqual(['connecting', 'live']);
    await stop();
  });

  test('a non-connected first frame also goes live without waiting for connected', async () => {
    const timers = fakeWatchdog();
    const statuses: StreamStatus[] = [];
    const stop = startEventPump({
      timeToFirstEventMs: 1000,
      scheduleTimeout: timers.schedule,
      source: (signal) =>
        (async function* () {
          yield changed('first');
          await untilAborted(signal);
        })(),
      onStatus: (status) => statuses.push(status),
      onBatch: () => undefined,
    });
    await waitFor(() => statuses.includes('live'));
    expect(timers.count()).toBe(0);
    await stop();
  });

  test('a late frame from a timed-out attempt cannot publish status or batches (#342)', async () => {
    const timers = fakeWatchdog();
    const statuses: StreamStatus[] = [];
    const batches: unknown[] = [];
    const { promise: lateGate, resolve: releaseLate } = Promise.withResolvers<void>();
    let connections = 0;
    const stop = startEventPump({
      timeToFirstEventMs: 1000,
      scheduleTimeout: timers.schedule,
      sleep: async () => {},
      random: () => 0.5,
      source: (signal) => {
        connections += 1;
        if (connections === 1) {
          return (async function* () {
            // Delivered only after the watchdog has aborted this attempt.
            await lateGate;
            yield { kind: 'connected' };
          })();
        }
        return neverYieldingSource(signal);
      },
      onStatus: (status) => statuses.push(status),
      onBatch: (events, resync) => batches.push({ events, resync }),
    });
    await waitFor(() => timers.count() === 1);
    timers.fireAll();
    releaseLate();
    await waitFor(() => connections === 2);
    expect(statuses).not.toContain('live');
    expect(batches).toEqual([]);
    await stop();
  });

  test('stop during a pending opening is bounded and publishes nothing afterward', async () => {
    const timers = fakeWatchdog();
    const statuses: StreamStatus[] = [];
    const stop = startEventPump({
      timeToFirstEventMs: 1000,
      stopGraceMs: 10,
      scheduleTimeout: timers.schedule,
      // Deliberately ignores its signal: shutdown must not wait on it forever (#342).
      source: () => ({
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<BackendEvent>> {
              return new Promise(() => {});
            },
          };
        },
      }),
      onStatus: (status) => statuses.push(status),
      onBatch: () => undefined,
    });
    await waitFor(() => timers.count() === 1);
    const started = Date.now();
    await stop();
    expect(Date.now() - started).toBeLessThan(500);
    const published = statuses.length;
    timers.fireAll();
    await new Promise((done) => setTimeout(done, 20));
    expect(statuses.length).toBe(published);
  });
});
