import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileGoalStore, GoalConflictError } from '../config/goal-store.ts';
import {
  acceptProposal,
  emptyGoalPlan,
  forkGoalPlan,
  nextTaskState,
  parseGoalPlan,
  parseSteps,
  progress,
  proposePlan,
  rejectProposal,
  setAcceptance,
  setGoal,
  setTaskState,
  setUserPlan,
} from './goal-plan.ts';

const now = '2026-11-18T00:00:00.000Z';
const base = emptyGoalPlan('local', 'ses_a', 'p');

describe('goal plan', () => {
  test('migrates a v0 document with a bare goal string', () => {
    const doc = parseGoalPlan({ sessionID: 'ses_a', goal: 'Ship it' }, now);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.goal?.title).toBe('Ship it');
  });

  test('refuses schemas newer than this build', () => {
    expect(() => parseGoalPlan({ schemaVersion: 2, sessionID: 'x' }, now)).toThrow('newer');
  });

  test('round-trips through JSON', () => {
    const doc = setUserPlan(setGoal(base, 'Fix it', now), ['a', 'b'], now);
    expect(parseGoalPlan(JSON.parse(JSON.stringify(doc)), now)).toEqual(doc);
  });

  test('parses markdown lists, numbered steps and semicolons', () => {
    expect(parseSteps('Plan:\n1. Profile\n2) Cull\n- [ ] Test')).toEqual([
      'Profile',
      'Cull',
      'Test',
    ]);
    expect(parseSteps('a; b ;c')).toEqual(['a', 'b', 'c']);
  });

  test('rejecting a proposal keeps the accepted plan; accepting replaces it', () => {
    const planned = setUserPlan(base, ['one'], now);
    const proposed = proposePlan(planned, ['x', 'y'], now);
    expect(rejectProposal(proposed).plan).toEqual(planned.plan);
    expect(rejectProposal(proposed).proposal).toBeUndefined();
    const accepted = acceptProposal(proposed, now);
    expect(accepted.plan?.tasks.map((task) => task.title)).toEqual(['x', 'y']);
    expect(accepted.plan?.accepted).toBe(true);
  });

  test('task state only changes explicitly; progress ignores cancelled', () => {
    let doc = setUserPlan(base, ['a', 'b', 'c'], now);
    doc = setTaskState(doc, 't1', 'done', now);
    doc = setTaskState(doc, 't3', 'cancelled', now);
    expect(progress(doc.plan)).toEqual({ done: 1, total: 2 });
    expect(nextTaskState('todo')).toBe('in-progress');
    expect(nextTaskState('in-progress')).toBe('done');
    expect(nextTaskState('blocked')).toBe('todo');
  });

  test('rewriting a user plan keeps states of unchanged steps', () => {
    let doc = setTaskState(setUserPlan(base, ['a', 'b'], now), 't2', 'done', now);
    doc = setUserPlan(doc, ['z', 'b'], now);
    expect(doc.plan?.tasks.map((task) => task.state)).toEqual(['todo', 'done']);
    expect(doc.plan?.revision).toBe(2);
  });

  test('criteria migrate from a legacy local goal and round-trip', () => {
    const legacy = parseGoalPlan(
      {
        sessionID: 'ses_a',
        goal: { title: 'Hit 30 FPS', acceptance: ['p95 < 16ms', 'no allocs'] },
      },
      now,
    );
    expect(legacy.criteria).toEqual(['p95 < 16ms', 'no allocs']);
    const doc = setAcceptance(base, [' 60 FPS ', ''], now);
    expect(doc.criteria).toEqual(['60 FPS']);
    const roundTripped = parseGoalPlan(JSON.parse(JSON.stringify(doc)), now);
    expect(roundTripped.criteria).toEqual(['60 FPS']);
  });

  test('fork copies with a fresh identity', () => {
    const forked = forkGoalPlan({ ...setGoal(base, 'g', now), revision: 4 }, 'ses_b');
    expect(forked.sessionID).toBe('ses_b');
    expect(forked.revision).toBe(0);
    expect(forked.criteria).toEqual([]);
  });
});

describe('goal store', () => {
  test('atomic compare-and-swap saves detect concurrent edits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-goals-'));
    try {
      const store = fileGoalStore(dir, () => now);
      expect(await store.load('ses_a')).toBeUndefined();
      const first = await store.save(setGoal(base, 'one', now));
      expect(first.revision).toBe(1);
      expect((await store.load('ses_a'))?.goal?.title).toBe('one');
      // A second instance still holding revision 0 must not silently overwrite.
      const stale = store.save(setGoal(base, 'two', now));
      expect(stale).rejects.toBeInstanceOf(GoalConflictError);
      await stale.catch(() => {});
      const second = await store.save(setGoal(first, 'three', now));
      expect(second.revision).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
