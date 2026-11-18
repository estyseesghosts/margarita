import type { FileDiff } from './diff.ts';
import type { ModelSelection } from './model-ref.ts';

export type TokenUsage = Readonly<{
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}>;

/** A revert staged server-side on the session (message it will rewind to). */
export type StagedRevert = Readonly<{
  messageID: string;
  files?: readonly FileDiff[];
}>;

/** Server-reported session facts the frontend needs. Identity is `id`, never the title. */
export type SessionSummary = Readonly<{
  id: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title?: string;
  agent?: string;
  model?: ModelSelection;
  /** Server-reported USD; `undefined` means the server did not report a value. */
  cost?: number;
  tokens?: TokenUsage;
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  /** Present only while a revert is staged on the server (not yet committed or cleared). */
  revert?: StagedRevert;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}>;

/**
 * Execution is projected from server facts. `unknown` is never shown as idle.
 * `waiting` carries the pending request IDs so the UI can surface them.
 */
export type Execution =
  | { state: 'idle'; outcome?: 'succeeded' | 'failed' | 'interrupted' }
  | { state: 'working'; startedAt?: number }
  | { state: 'waiting'; permissionIDs: readonly string[]; formIDs: readonly string[] }
  | { state: 'unknown'; reason: 'disconnected' | 'not-loaded' };

export function executionLabel(execution: Execution): string {
  switch (execution.state) {
    case 'idle':
      return execution.outcome === 'failed'
        ? 'failed'
        : execution.outcome === 'interrupted'
          ? 'interrupted'
          : 'idle';
    case 'working':
      return 'working';
    case 'waiting':
      return 'needs input';
    case 'unknown':
      return execution.reason === 'disconnected' ? 'reconnecting' : '…';
    default:
      return assertNever(execution);
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
}
