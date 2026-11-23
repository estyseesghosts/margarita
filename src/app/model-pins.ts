/**
 * Pure model-scope keys and pin-intent computation (#313).
 *
 * Pinning is a cross-process merge problem: every mutation must carry a monotone
 * per-scope revision and an explicit clear, so another process's unrelated scope
 * is never overwritten. This module computes those values without touching the
 * reactive store, persistence or notices.
 */
import type { PinnedModelOperation } from '../config/local-state.ts';
import type { ModelSelection } from '../domain/model-ref.ts';
import { directoryKey } from '../domain/path-identity.ts';

/** Stable per-host, per-project scope for remembered and pinned models (#189). */
export function modelScope(serverID: string, directory: string, platform: NodeJS.Platform): string {
  return `${serverID}|${directoryKey(directory, platform)}`;
}

/** The pin key for a project scope. */
export function projectPinScope(
  serverID: string,
  directory: string,
  platform: NodeJS.Platform,
): string {
  return `project:${modelScope(serverID, directory, platform)}`;
}

/** The derived state from one pin mutation. */
export interface PinMutation {
  /** Canonical operations, including the new explicit intent. */
  readonly operations: Record<string, PinnedModelOperation>;
  /** The user-visible pin view to persist and show. */
  readonly pins: Record<string, ModelSelection>;
}

/**
 * Applies one scope's pin intent. `null` is an explicit clear: it removes the
 * visible pin but keeps a revisioned operation so an older writer cannot revive it.
 */
export function applyPin(
  currentOperations: Readonly<Record<string, PinnedModelOperation>>,
  currentPins: Readonly<Record<string, ModelSelection>>,
  key: string,
  model: ModelSelection | null,
  now: string,
): PinMutation {
  const revision = (currentOperations[key]?.revision ?? 0) + 1;
  const operations: Record<string, PinnedModelOperation> = {
    ...currentOperations,
    [key]: { revision, model, updatedAt: now },
  };
  const pins: Record<string, ModelSelection> = { ...currentPins };
  if (model === null) delete pins[key];
  else pins[key] = model;
  return { operations, pins };
}
