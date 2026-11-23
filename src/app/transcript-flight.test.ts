import { describe, expect, test } from 'bun:test';

import { TranscriptFlightTracker } from './transcript-flight.ts';

describe('transcript single-flight tracking (#309)', () => {
  test('a new signal while idle does not coalesce', () => {
    const tracker = new TranscriptFlightTracker();
    expect(tracker.coalesce('local:a', false)).toBe(false);
    const idle = tracker.begin('local:a');
    expect(tracker.drain(idle)).toEqual({ dirty: false, dirtyJobs: false });
  });

  test('signals during a flight coalesce into dirty hints', () => {
    const tracker = new TranscriptFlightTracker();
    const flight = tracker.begin('local:a');
    expect(tracker.isInFlight('local:a')).toBe(true);
    expect(tracker.coalesce('local:a', false)).toBe(true);
    expect(tracker.coalesce('local:a', true)).toBe(true);
    expect(tracker.coalesce('remote:a', true)).toBe(false);
    expect(tracker.drain(flight)).toEqual({ dirty: true, dirtyJobs: true });
    expect(tracker.end(flight)).toBe(true);
    expect(tracker.isInFlight('local:a')).toBe(false);
  });

  test('hints drain once, even after a rejected read', () => {
    const tracker = new TranscriptFlightTracker();
    // The tracker never inspects the promise outcome; the controller drains hints
    // on both success and failure, so a settled promise exercises the same path.
    const flight = tracker.begin('local:a');
    tracker.coalesce('local:a', true);
    expect(tracker.drain(flight)).toEqual({ dirty: true, dirtyJobs: true });
    expect(tracker.end(flight)).toBe(true);
    expect(tracker.drain(flight)).toEqual({ dirty: false, dirtyJobs: false });
  });

  test('in-flight keys are exposed for eviction protection', () => {
    const tracker = new TranscriptFlightTracker();
    const first = tracker.begin('local:a');
    tracker.begin('remote:b');
    expect(tracker.inFlightKeys()).toEqual(['local:a', 'remote:b']);
    expect(tracker.end(first)).toBe(true);
    expect(tracker.inFlightKeys()).toEqual(['remote:b']);
  });

  test('a late completion cannot close or drain a replacement flight (#333)', () => {
    const tracker = new TranscriptFlightTracker();
    const old = tracker.begin('local:a');
    tracker.coalesce('local:a', true);
    // The session was deleted and recreated under the same ID while the read hung.
    tracker.retire('local:a');
    const replacement = tracker.begin('local:a');
    expect(tracker.isCurrent(old)).toBe(false);
    expect(tracker.end(old)).toBe(false);
    expect(tracker.drain(old)).toEqual({ dirty: false, dirtyJobs: false });
    expect(tracker.isCurrent(replacement)).toBe(true);
    expect(tracker.drain(replacement)).toEqual({ dirty: false, dirtyJobs: false });
    expect(tracker.end(replacement)).toBe(true);
  });

  test('host and controller teardown retire only the owned lifetimes (#333)', () => {
    const tracker = new TranscriptFlightTracker();
    const local = tracker.begin('local:a');
    const remote = tracker.begin('remote:b');
    tracker.coalesce('local:a', true);
    tracker.coalesce('remote:b', true);
    tracker.retireWhere((key) => key.startsWith('local:'));
    expect(tracker.inFlightKeys()).toEqual(['remote:b']);
    expect(tracker.drain(remote)).toEqual({ dirty: true, dirtyJobs: true });
    expect(tracker.isCurrent(local)).toBe(false);
    tracker.dispose();
    expect(tracker.inFlightKeys()).toEqual([]);
    expect(tracker.drain(remote)).toEqual({ dirty: false, dirtyJobs: false });
  });
});
