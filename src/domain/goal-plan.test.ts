import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileGoalStore, GoalConflictError } from '../config/goal-store.ts';
import {
  acceptProposal,
  addEvidence,
  emptyGoalPlan,
  forkGoalPlan,
  type GoalPlanV1,
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
      expect(await store.load({ serverID: 'local', sessionID: 'ses_a' })).toBeUndefined();
      const first = await store.save(setGoal(base, 'one', now));
      expect(first.revision).toBe(1);
      expect((await store.load({ serverID: 'local', sessionID: 'ses_a' }))?.goal?.title).toBe(
        'one',
      );
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

  test('two servers with the same session ID keep separate sidecars', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-goals-'));
    try {
      const store = fileGoalStore(dir, () => now);
      const remote = { ...base, backend: 'srv_1' };
      await store.save(setGoal(base, 'local goal', now));
      await store.save(setGoal(remote, 'remote goal', now));
      expect((await store.load({ serverID: 'local', sessionID: 'ses_a' }))?.goal?.title).toBe(
        'local goal',
      );
      expect((await store.load({ serverID: 'srv_1', sessionID: 'ses_a' }))?.goal?.title).toBe(
        'remote goal',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('legacy local sidecars keep their bare filename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marg-goals-'));
    try {
      const store = fileGoalStore(dir, () => now);
      await store.save(setGoal(base, 'legacy', now));
      expect(await Bun.file(join(dir, 'ses_a.json')).exists()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const withDep = (doc: GoalPlanV1, title: string, deps: string[]): GoalPlanV1 => ({
  ...doc,
  plan: {
    ...doc.plan!,
    tasks: doc.plan!.tasks.map((task) => (task.title === title ? { ...task, deps } : task)),
  },
});

describe('plan task identity across rewrites (#162)', () => {
  test('reordering A/B keeps B dependent on A, never on itself', () => {
    const doc = withDep(setUserPlan(base, ['A', 'B'], now), 'B', ['t1']);
    const reordered = setUserPlan(doc, ['B', 'A'], now);
    const a = reordered.plan?.tasks.find((task) => task.title === 'A');
    const b = reordered.plan?.tasks.find((task) => task.title === 'B');
    if (a === undefined || b === undefined) throw new Error('missing task');
    expect(b.deps).toEqual([a.id]);
    expect(b.deps).not.toContain(b.id);
  });

  test('duplicate titles stay independent when one is completed and rewritten', () => {
    let doc = setUserPlan(base, ['Test', 'Test'], now);
    const first = doc.plan?.tasks[0];
    if (first === undefined) throw new Error('no task');
    doc = setTaskState(doc, first.id, 'done', now);
    const rewritten = setUserPlan(doc, ['Test', 'Test'], now);
    expect(rewritten.plan?.tasks.map((task) => task.state)).toEqual(['done', 'todo']);
    expect(new Set(rewritten.plan?.tasks.map((task) => task.id)).size).toBe(2);
  });

  test('matched tasks keep their state and evidence across a rewrite', () => {
    let doc = setUserPlan(base, ['a', 'b'], now);
    doc = setTaskState(doc, 't2', 'done', now);
    doc = addEvidence(doc, 't2', { note: 'proof' }, now);
    const rewritten = setUserPlan(doc, ['z', 'b'], now);
    const b = rewritten.plan?.tasks.find((task) => task.title === 'b');
    expect(b?.state).toBe('done');
    expect(b?.evidence).toEqual([{ note: 'proof' }]);
  });

  test('deleted tasks do not leave dependencies pointing at reused IDs', () => {
    const doc = withDep(setUserPlan(base, ['A', 'B'], now), 'B', ['t1']);
    const rewritten = setUserPlan(doc, ['B', 'C'], now);
    const b = rewritten.plan?.tasks.find((task) => task.title === 'B');
    const c = rewritten.plan?.tasks.find((task) => task.title === 'C');
    expect(b?.deps).toEqual([]);
    expect(c?.id).not.toBe('t1');
  });

  test('parsed plans drop dangling and self-referential dependencies', () => {
    const parsed = parseGoalPlan(
      {
        schemaVersion: 1,
        sessionID: 'ses_a',
        revision: 1,
        plan: {
          revision: 1,
          source: 'user',
          accepted: true,
          updatedAt: now,
          tasks: [
            {
              id: 't1',
              title: 'A',
              state: 'todo',
              deps: ['t1', 't9'],
              evidence: [],
              updatedAt: now,
            },
            {
              id: 't2',
              title: 'B',
              state: 'todo',
              deps: ['t1', 't1'],
              evidence: [],
              updatedAt: now,
            },
          ],
        },
      },
      now,
    );
    expect(parsed.plan?.tasks[0]?.deps).toEqual([]);
    expect(parsed.plan?.tasks[1]?.deps).toEqual(['t1']);
  });
});
