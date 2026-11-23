import type { BackendEvent } from '../domain/backend-event.ts';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

export type EventPumpOptions = Readonly<{
  source: (signal: AbortSignal) => AsyncIterable<BackendEvent>;
  /** Receives batches in arrival order. `resync: true` means events were lost; refetch everything. */
  onBatch: (events: readonly BackendEvent[], resync: boolean) => void;
  onStatus: (status: StreamStatus, error?: unknown) => void;
  maxBuffered?: number;
  flushIntervalMs?: number;
  /**
   * Deadline for the first valid frame of each subscription attempt. A stream that opens but
   * never yields its initial frame is abandoned and enters the normal backoff/resync path
   * (#342). This is first-frame detection only, not an idle heartbeat.
   */
  timeToFirstEventMs?: number;
  /** Upper bound on how long `stop()` waits for a non-cooperative iterator (#342). */
  stopGraceMs?: number;
  /** Injectable watchdog timer; returns a cancel function. */
  scheduleTimeout?: (fire: () => void, ms: number) => () => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}>;

const backoffMs = [500, 1000, 2000, 4000, 8000];
const maxBackoffMs = 15_000;
const defaultTimeToFirstEventMs = 15_000;
const defaultStopGraceMs = 250;

export function reconnectDelay(attempt: number, random: () => number): number {
  const base = backoffMs[attempt] ?? maxBackoffMs;
  return Math.min(maxBackoffMs, Math.round(base * (0.8 + random() * 0.4)));
}

function defaultScheduleTimeout(fire: () => void, ms: number): () => void {
  const handle = setTimeout(fire, ms);
  return () => clearTimeout(handle);
}

/**
 * Owns the single global event subscription. The SDK stream is live-only with no
 * replay, so every (re)connect is reported as a resync and consumers refetch state.
 * Returns a stop function; nothing keeps running after it resolves.
 */
export function startEventPump(options: EventPumpOptions): () => Promise<void> {
  const controller = new AbortController();
  const maxBuffered = options.maxBuffered ?? 2000;
  const flushIntervalMs = options.flushIntervalMs ?? 50;
  const timeToFirstEventMs = options.timeToFirstEventMs ?? defaultTimeToFirstEventMs;
  const stopGraceMs = options.stopGraceMs ?? defaultStopGraceMs;
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  let buffer: BackendEvent[] = [];
  let overflowed = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  // A stream abandoned by teardown (or a late frame from a timed-out attempt) must never
  // publish a status or batch after stop, even if its iterator is non-cooperative (#342).
  const reportStatus = (status: StreamStatus, error?: unknown) => {
    if (!stopped && !controller.signal.aborted) options.onStatus(status, error);
  };

  const flush = () => {
    flushTimer = undefined;
    if (stopped || controller.signal.aborted) return;
    if (buffer.length === 0 && !overflowed) return;
    const batch = buffer;
    const resync = overflowed;
    buffer = [];
    overflowed = false;
    options.onBatch(resync ? [] : batch, resync);
  };

  const push = (event: BackendEvent) => {
    if (stopped || controller.signal.aborted) return;
    if (event.kind === 'connected') {
      // A (re)connect means we may have missed events: force a full resync.
      buffer = [];
      overflowed = true;
    } else if (buffer.length >= maxBuffered) {
      buffer = [];
      overflowed = true;
    } else if (!overflowed) {
      buffer.push(event);
    }
    flushTimer ??= setTimeout(flush, flushIntervalMs);
  };

  const loop = async () => {
    let attempt = 0;
    reportStatus('connecting');
    while (!controller.signal.aborted) {
      // Per-attempt abort, linked to the owner. The watchdog cancels only this subscription;
      // the owner-level shutdown abort remains independent and final (#342).
      const attemptAbort = new AbortController();
      const onOwnerAbort = () => attemptAbort.abort(controller.signal.reason);
      if (controller.signal.aborted) onOwnerAbort();
      else controller.signal.addEventListener('abort', onOwnerAbort, { once: true });

      let firstEventSeen = false;
      let timedOut = false;
      const cancelWatchdog = scheduleTimeout(() => {
        if (firstEventSeen) return;
        timedOut = true;
        attemptAbort.abort(new Error('first-event watchdog'));
      }, timeToFirstEventMs);

      let error: unknown;
      try {
        for await (const event of options.source(attemptAbort.signal)) {
          // A frame delivered by an abandoned attempt cannot mutate the live subscription.
          if (attemptAbort.signal.aborted) break;
          const first = !firstEventSeen;
          if (first) firstEventSeen = true;
          if (first || event.kind === 'connected') {
            // The first valid frame proves the stream is live even if `connected` never arrives;
            // a later `connected` frame additionally forces the resync performed by push().
            if (first) cancelWatchdog();
            attempt = 0;
            reportStatus('live');
          }
          push(event);
        }
      } catch (cause) {
        error = cause;
      } finally {
        cancelWatchdog();
        controller.signal.removeEventListener('abort', onOwnerAbort);
      }
      if (controller.signal.aborted) break;
      if (timedOut) error = new Error(`No event within ${timeToFirstEventMs}ms`);
      reportStatus('reconnecting', error);
      try {
        await sleep(reconnectDelay(attempt, random), controller.signal);
      } catch {
        break; // aborted while waiting
      }
      attempt += 1;
    }
  };

  const running = loop();
  return async () => {
    stopped = true;
    controller.abort();
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    // A non-cooperative iterator may ignore abort forever; do not make shutdown depend on it.
    // The stopped/abort guards ensure it cannot publish anything in the meantime (#342).
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      running,
      new Promise<void>((resolve) => {
        grace = setTimeout(resolve, stopGraceMs);
      }),
    ]);
    if (grace !== undefined) clearTimeout(grace);
  };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
