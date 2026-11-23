/**
 * The single owner of local-state writes (#317).
 *
 * Feature owners supply typed patches; this service serializes the actual writes,
 * adopts the snapshot merged on disk, and reports warnings and failures. It never
 * reaches into the reactive store or notices directly, so persistence can be
 * tested without a controller or a filesystem.
 */
import type { LocalState, SaveResult } from '../config/local-state.ts';
import { mergeState } from '../config/local-state.ts';

/** Everything the composition root injects into the write queue. */
export interface PersistenceCoordinatorDeps {
  /** Snapshot loaded at startup; later patches build on it. */
  readonly initial: LocalState;
  readonly save: (state: LocalState) => Promise<SaveResult | void>;
  /** Called after a disk-merged snapshot is adopted, so owners refresh their projections. */
  readonly onMerge: (state: LocalState) => void;
  readonly onWarning: (warning: string) => void;
  readonly onError: (message: string) => void;
  /** Supplied by the controller so error text stays identical across the boundary. */
  readonly describeError: (error: unknown) => string;
}

/**
 * Serializes local-state patches and merges the result back into one snapshot.
 * Owns the save chain and the last save error; `flush()` is the shutdown gate.
 */
export class PersistenceCoordinator {
  private snapshot: LocalState;
  private saveChain: Promise<void> = Promise.resolve();
  private saveError: string | undefined;

  constructor(private readonly deps: PersistenceCoordinatorDeps) {
    this.snapshot = deps.initial;
  }

  /** The current snapshot, including patches not yet written to disk. */
  get state(): LocalState {
    return this.snapshot;
  }

  /** Stages a patch synchronously and queues one serialized write. */
  patch(patch: Partial<Omit<LocalState, 'schemaVersion'>>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    const saved = this.snapshot;
    this.saveChain = this.saveChain.then(async () => {
      try {
        const result = await this.deps.save(saved);
        const merged = result?.state;
        if (merged !== undefined) {
          // Adopt the post-merge snapshot so later patches build on what is actually on
          // disk. If this process applied a newer patch while the save was in flight,
          // re-merge that patch over the disk state instead of dropping either.
          const latest = this.snapshot;
          const adopted = latest === saved ? merged : mergeState(latest, merged);
          this.snapshot = adopted;
          this.deps.onMerge(adopted);
        }
        if (result?.warning !== undefined) this.deps.onWarning(result.warning);
      } catch (error: unknown) {
        this.saveError = this.deps.describeError(error);
        this.deps.onError(this.saveError);
      }
    });
  }

  /** Waits for queued writes and reports a saved failure once to the caller. */
  async flush(): Promise<void> {
    await this.saveChain;
    if (this.saveError !== undefined) {
      const message = this.saveError;
      this.saveError = undefined;
      throw new Error(message);
    }
  }
}
