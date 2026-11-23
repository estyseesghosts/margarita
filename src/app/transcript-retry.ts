/**
 * Bounded retry policy for transcript reads (#309).
 *
 * Only transient read failures are retried, at most a few times, with exponential
 * backoff. This module owns the retryability rule, the backoff calculation and
 * the per-session attempt counters; timer scheduling and notices stay in the
 * controller.
 */
import { BackendError } from '../adapter/backend.ts';

/** Maximum number of retries after an initial failed transcript read. */
export const transcriptRetryLimit = 3;
/** Base delay for the first retry; later attempts double it. */
export const transcriptRetryBaseDelayMs = 250;

/** Transient read failures are worth a bounded retry; a gone session or auth failure is not. */
export function transcriptFailureRetryable(error: unknown): boolean {
  if (!(error instanceof BackendError)) return true;
  return error.kind === 'transport' || error.kind === 'unknown';
}

/** Exponential backoff for a 1-based retry attempt. */
export function retryDelay(attempt: number, baseMs: number): number {
  return baseMs * 2 ** (attempt - 1);
}

/** Owns per-session retry attempt counters. */
export class TranscriptRetryTracker {
  private readonly attempts = new Map<string, number>();

  /** Returns the next 1-based attempt, or undefined when the budget is exhausted. */
  next(key: string): number | undefined {
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    if (attempt > transcriptRetryLimit) {
      this.attempts.delete(key);
      return undefined;
    }
    this.attempts.set(key, attempt);
    return attempt;
  }

  /** Clears one session's attempts after success, a terminal failure or teardown. */
  reset(key: string): void {
    this.attempts.delete(key);
  }

  keys(): IterableIterator<string> {
    return this.attempts.keys();
  }
}
