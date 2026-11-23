import { describe, expect, test } from 'bun:test';

import { TranscriptFlightTracker } from './transcript-flight.ts';

describe('transcript single-flight tracking (#309)', () => {
  test('a new signal while idle does not coalesce', () => {
    const tracker = new TranscriptFlightTracker();
    expect(tracker.coalesce('local:a', false)).toBe(false);
    expect(tracker.drain('local:a')).toEqual({ dirty: false, dirtyJobs: false });
  });

  test('signals during a flight coalesce into dirty hints', async () => {
    const tracker = new TranscriptFlightTracker();
    let release!: () => void;
    const run = new Promise<void>((resolve) => {
      release = resolve;
    });
    tracker.begin('local:a', run);
    expect(tracker.isInFlight('local:a')).toBe(true);
    expect(tracker.coalesce('local:a', false)).toBe(true);
    expect(tracker.coalesce('local:a', true)).toBe(true);
    expect(tracker.coalesce('remote:a', true)).toBe(false);
    tracker.end('local:a');
    expect(tracker.isInFlight('local:a')).toBe(false);
    expect(tracker.drain('local:a')).toEqual({ dirty: true, dirtyJobs: true });
    release();
    await run;
  });

  test('hints drain once, even after a rejected read', () => {
    const tracker = new TranscriptFlightTracker();
    // The tracker never inspects the promise outcome; the controller drains hints
    // on both success and failure, so a settled promise exercises the same path.
    tracker.begin('local:a', Promise.resolve());
    tracker.coalesce('local:a', true);
    tracker.end('local:a');
    expect(tracker.drain('local:a')).toEqual({ dirty: true, dirtyJobs: true });
    expect(tracker.drain('local:a')).toEqual({ dirty: false, dirtyJobs: false });
  });

  test('in-flight keys are exposed for eviction protection', () => {
    const tracker = new TranscriptFlightTracker();
    tracker.begin('local:a', Promise.resolve());
    tracker.begin('remote:b', Promise.resolve());
    expect(tracker.inFlightKeys()).toEqual(['local:a', 'remote:b']);
    tracker.end('local:a');
    expect(tracker.inFlightKeys()).toEqual(['remote:b']);
  });
});
