import type { BackendEvent } from '../domain/backend-event.ts';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

export type EventPumpOptions = Readonly<{
  source: (signal: AbortSignal) => AsyncIterable<BackendEvent>;
  /** Receives batches in arrival order. `resync: true` means events were lost; refetch everything. */
  onBatch: (events: readonly BackendEvent[], resync: boolean) => void;
  onStatus: (status: StreamStatus, error?: unknown) => void;
  maxBuffered?: number;
  flushIntervalMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}>;

const backoffMs = [500, 1000, 2000, 4000, 8000];
const maxBackoffMs = 15_000;

export function reconnectDelay(attempt: number, random: () => number): number {
  const base = backoffMs[attempt] ?? maxBackoffMs;
  return Math.min(maxBackoffMs, Math.round(base * (0.8 + random() * 0.4)));
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
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  let buffer: BackendEvent[] = [];
  let overflowed = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    flushTimer = undefined;
    if (buffer.length === 0 && !overflowed) return;
    const batch = buffer;
    const resync = overflowed;
    buffer = [];
    overflowed = false;
    options.onBatch(resync ? [] : batch, resync);
  };

  const push = (event: BackendEvent) => {
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
    options.onStatus('connecting');
    while (!controller.signal.aborted) {
      let error: unknown;
      try {
        for await (const event of options.source(controller.signal)) {
          if (attempt !== 0 || event.kind === 'connected') {
            attempt = 0;
            options.onStatus('live');
          }
          push(event);
        }
      } catch (cause) {
        error = cause;
      }
      if (controller.signal.aborted) break;
      options.onStatus('reconnecting', error);
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
    controller.abort();
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    await running;
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
