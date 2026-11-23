import { describe, expect, test } from 'bun:test';

import { TranscriptGenerations } from './transcript-generations.ts';

describe('transcript generations (#309)', () => {
  test('read generations increase globally across sessions', () => {
    const generations = new TranscriptGenerations();
    expect(generations.nextRead()).toBe(1);
    expect(generations.nextRead()).toBe(2);
    expect(generations.nextRead()).toBe(3);
  });

  test('a stale read cannot commit over a newer one for the same session', () => {
    const generations = new TranscriptGenerations();
    const older = generations.nextRead();
    const newer = generations.nextRead();
    expect(generations.shouldCommit('local:a', newer)).toBe(true);
    generations.commit('local:a', newer);
    expect(generations.committedGeneration('local:a')).toBe(newer);
    expect(generations.shouldCommit('local:a', older)).toBe(false);
    expect(generations.shouldCommit('local:a', newer)).toBe(false);
    expect(generations.shouldCommit('local:a', newer + 1)).toBe(true);
  });

  test('watermarks are per session and teardown forgets one', () => {
    const generations = new TranscriptGenerations();
    generations.commit('local:a', 2);
    generations.commit('remote:a', 5);
    expect(generations.committedGeneration('remote:a')).toBe(5);
    generations.forget('local:a');
    expect(generations.committedGeneration('local:a')).toBe(0);
    expect(generations.shouldCommit('local:a', 1)).toBe(true);
  });
});
