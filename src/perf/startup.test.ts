import { describe, expect, test } from 'bun:test';

import { createStartupTimeline, startupStages } from './startup.ts';

function tickingClock(): { clock: () => number; advance: (ms: number) => void } {
  let now = 1_000;
  return {
    clock: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

describe('startup timeline', () => {
  test('records monotonic offsets and deltas in insertion order', () => {
    const time = tickingClock();
    const timeline = createStartupTimeline({ clock: time.clock });
    timeline.mark('process-entry');
    time.advance(4);
    timeline.mark('execute-entry');
    time.advance(20);
    timeline.mark('config-loaded');
    time.advance(3);
    timeline.mark('first-frame');

    const snapshot = timeline.snapshot();
    expect(snapshot.clock).toBe('monotonic');
    expect(snapshot.stages).toEqual([
      { stage: 'process-entry', atMs: 0 },
      { stage: 'execute-entry', atMs: 4, deltaMs: 4 },
      { stage: 'config-loaded', atMs: 24, deltaMs: 20 },
      { stage: 'first-frame', atMs: 27, deltaMs: 3 },
    ]);
    expect(snapshot.spans).toEqual({
      'process-entry->first-frame': 27,
    });
    expect(snapshot.missing).toContain('composer-ready');
    expect(snapshot.missing.length).toBe(startupStages.length - 4);
  });

  test('a later mark for the same stage replaces the earlier offset', () => {
    const time = tickingClock();
    const timeline = createStartupTimeline({ clock: time.clock });
    time.advance(5);
    timeline.mark('composer-ready');
    time.advance(5);
    timeline.mark('composer-ready');
    expect(timeline.snapshot().stages).toEqual([{ stage: 'composer-ready', atMs: 10 }]);
  });

  test('explicit controller milestones share the process-relative clock', () => {
    const time = tickingClock();
    const timeline = createStartupTimeline({ clock: time.clock });
    timeline.mark('process-entry');
    time.advance(10);
    timeline.markAt('session-page-ready', 8);
    time.advance(2);
    timeline.mark('composer-ready');
    expect(timeline.snapshot().spans).toEqual({
      'process-entry->session-page-ready': 8,
      'process-entry->composer-ready': 12,
      'session-page-ready->composer-ready': 4,
    });
  });

  test('negative explicit offsets are clamped and no content is accepted', () => {
    const timeline = createStartupTimeline({ clock: () => 0 });
    timeline.markAt('process-entry', -10);
    const snapshot = timeline.snapshot();
    expect(snapshot.stages[0]?.atMs).toBe(0);
    expect(Object.keys(snapshot.spans)).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });
});
