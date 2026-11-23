import { describe, expect, test } from 'bun:test';

import { emptyState, type LocalState, type SaveResult } from '../config/local-state.ts';
import type { ModelSelection } from '../domain/model-ref.ts';
import {
  PersistenceCoordinator,
  type PersistenceCoordinatorDeps,
} from './persistence-coordinator.ts';

function model(modelID: string): ModelSelection {
  return { providerID: 'provider', modelID };
}

interface Recorder {
  readonly deps: PersistenceCoordinatorDeps;
  readonly saved: readonly LocalState[];
  readonly merged: readonly LocalState[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  release(index: number): void;
}

type SaveHook = (state: LocalState, gates: Array<() => void>) => Promise<SaveResult | void>;

function recorder(save: SaveHook): Recorder {
  const saved: LocalState[] = [];
  const merged: LocalState[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const gates: Array<() => void> = [];
  return {
    saved,
    merged,
    warnings,
    errors,
    release(index: number): void {
      gates[index]?.();
    },
    deps: {
      initial: emptyState,
      save: (state: LocalState) => {
        saved.push(state);
        return save(state, gates);
      },
      onMerge: (state: LocalState) => {
        merged.push(state);
      },
      onWarning: (warning: string) => {
        warnings.push(warning);
      },
      onError: (message: string) => {
        errors.push(message);
      },
      describeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    },
  };
}

describe('persistence coordinator (#317)', () => {
  test('stages patches synchronously and serializes writes in arrival order', async () => {
    const rec = recorder(async (_state, gates) => {
      const gate = Promise.withResolvers<void>();
      gates.push(() => gate.resolve());
      await gate.promise;
      return { state: _state };
    });
    const coordinator = new PersistenceCoordinator(rec.deps);
    coordinator.patch({ recentModels: [model('first')] });
    coordinator.patch({ recentModels: [model('first'), model('second')] });
    expect(coordinator.state.recentModels.map((entry) => entry.modelID)).toEqual([
      'first',
      'second',
    ]);

    await Bun.sleep(0);
    expect(rec.saved).toHaveLength(1);
    rec.release(0);
    await Bun.sleep(0);
    expect(rec.saved).toHaveLength(2);
    expect(rec.saved[0]?.recentModels.map((entry) => entry.modelID)).toEqual(['first']);
    expect(rec.saved[1]?.recentModels.map((entry) => entry.modelID)).toEqual(['first', 'second']);
    rec.release(1);
    await coordinator.flush();
  });

  test('adopts the snapshot actually merged on disk', async () => {
    const disk = { ...emptyState, recentModels: [model('other-process')] };
    const rec = recorder(async () => ({ state: disk }));
    const coordinator = new PersistenceCoordinator(rec.deps);
    coordinator.patch({ recentModels: [model('ours')] });
    await coordinator.flush();
    expect(rec.merged).toHaveLength(1);
    expect(coordinator.state.recentModels.map((entry) => entry.modelID)).toEqual(['other-process']);
  });

  test('remerges a newer patch applied while the save was in flight', async () => {
    const disk = { ...emptyState, recentModels: [model('other-process')] };
    const rec = recorder(async (_state, gates) => {
      if (gates.length === 0) {
        const gate = Promise.withResolvers<void>();
        gates.push(() => gate.resolve());
        await gate.promise;
      }
      return { state: disk };
    });
    const coordinator = new PersistenceCoordinator(rec.deps);
    coordinator.patch({ recentModels: [model('ours')] });
    await Bun.sleep(0);
    coordinator.patch({ recentModels: [model('newer')] });
    rec.release(0);
    await coordinator.flush();
    const ids = coordinator.state.recentModels.map((entry) => entry.modelID);
    expect(ids).toContain('newer');
    expect(ids).toContain('other-process');
  });

  test('reports warnings and exposes a saved failure once through flush', async () => {
    const rec = recorder(async () => ({ state: emptyState, warning: 'disk nearly full' }));
    const coordinator = new PersistenceCoordinator(rec.deps);
    coordinator.patch({ recentModels: [model('a')] });
    await coordinator.flush();
    expect(rec.warnings).toEqual(['disk nearly full']);

    const failing = recorder(async () => {
      throw new Error('write failed');
    });
    const failingCoordinator = new PersistenceCoordinator(failing.deps);
    failingCoordinator.patch({ recentModels: [model('b')] });
    let rejected: string | undefined;
    try {
      await failingCoordinator.flush();
    } catch (error: unknown) {
      rejected = error instanceof Error ? error.message : String(error);
    }
    expect(rejected).toBe('write failed');
    expect(failing.errors).toEqual(['write failed']);
    await failingCoordinator.flush();
  });
});
