import type { Execution, SessionSummary } from './session.ts';

export type ExecutionFacts = Readonly<{
  connected: boolean;
  loaded: boolean;
  /** From `session.active` or execution events. */
  running: boolean;
  outcome?: SessionSummary['outcome'];
  permissionIDs: readonly string[];
  formCount: number;
}>;

/**
 * Projects execution state from server facts. Pending permissions/forms always win so
 * a blocked session reads as needing input; a disconnect is unknown, never idle.
 */
export function projectExecution(facts: ExecutionFacts): Execution {
  if (!facts.connected) return { state: 'unknown', reason: 'disconnected' };
  if (!facts.loaded) return { state: 'unknown', reason: 'not-loaded' };
  if (facts.permissionIDs.length > 0 || facts.formCount > 0) {
    return {
      state: 'waiting',
      permissionIDs: facts.permissionIDs,
      formIDs: Array.from({ length: facts.formCount }, (_, index) => `form-${index}`),
    };
  }
  if (facts.running) return { state: 'working' };
  return facts.outcome === undefined
    ? { state: 'idle' }
    : { state: 'idle', outcome: facts.outcome };
}
