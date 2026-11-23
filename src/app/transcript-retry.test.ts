import { describe, expect, test } from 'bun:test';

import { BackendError } from '../adapter/backend.ts';
import {
  retryDelay,
  transcriptFailureRetryable,
  transcriptRetryLimit,
  TranscriptRetryTracker,
} from './transcript-retry.ts';

describe('transcript retry policy (#309)', () => {
  test('only transient backend failures are retryable', () => {
    expect(transcriptFailureRetryable(new Error('plain'))).toBe(true);
    expect(transcriptFailureRetryable(new BackendError('transport', 'session.read', 'x'))).toBe(
      true,
    );
    expect(transcriptFailureRetryable(new BackendError('unknown', 'session.read', 'x'))).toBe(true);
    expect(transcriptFailureRetryable(new BackendError('not-found', 'session.read', 'x'))).toBe(
      false,
    );
    expect(transcriptFailureRetryable(new BackendError('unauthorized', 'session.read', 'x'))).toBe(
      false,
    );
  });

  test('backoff doubles per attempt from the base delay', () => {
    expect(retryDelay(1, 250)).toBe(250);
    expect(retryDelay(2, 250)).toBe(500);
    expect(retryDelay(3, 250)).toBe(1000);
  });

  test('attempts are per key and capped at the retry limit', () => {
    const tracker = new TranscriptRetryTracker();
    expect(tracker.next('local:a')).toBe(1);
    expect(tracker.next('local:a')).toBe(2);
    expect(tracker.next('remote:a')).toBe(1);
    expect(tracker.next('local:a')).toBe(3);
    expect(tracker.next('local:a')).toBeUndefined();
    expect([...tracker.keys()]).toEqual(['remote:a']);
    expect(transcriptRetryLimit).toBe(3);
  });

  test('reset clears one key so retries can start over', () => {
    const tracker = new TranscriptRetryTracker();
    tracker.next('local:a');
    tracker.next('local:a');
    tracker.reset('local:a');
    expect(tracker.next('local:a')).toBe(1);
  });
});
