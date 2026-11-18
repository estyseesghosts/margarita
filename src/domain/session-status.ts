import type { Execution } from './session.ts';

/** One classifier drives dots, tabs, badges, and counts. */
export type SessionStatus = 'idle' | 'failed' | 'needs-input' | 'working' | 'unknown';

export type StatusInput = Readonly<{
  /** False when the owning server is offline/unauthorized/incompatible. */
  online: boolean;
  execution: Execution;
  /** Archived sessions never count as active. */
  archived?: boolean;
}>;

/**
 * Classifies status with a single precedence: needs input > working > failed > idle.
 * Connectivity is separate from failure: a disconnected server yields `unknown`, never
 * a red dot, and never a stale green one. A recovered tool error is not a session failure;
 * only a terminal `failed` outcome is red, and an explicit interruption stays idle.
 * Archived sessions are idle for presence purposes even if stale data says otherwise.
 */
export function classifySessionStatus(input: StatusInput): SessionStatus {
  if (!input.online) return 'unknown';
  if (input.archived === true) return 'idle';
  switch (input.execution.state) {
    case 'waiting':
      return 'needs-input';
    case 'working':
      return 'working';
    case 'idle':
      return input.execution.outcome === 'failed' ? 'failed' : 'idle';
    case 'unknown':
      return 'unknown';
    default:
      return 'unknown';
  }
}

/** True for sessions shown in the Active tab (working or blocked on the user). */
export function isActiveStatus(status: SessionStatus): boolean {
  return status === 'working' || status === 'needs-input';
}

/** True for the Needs input tab. Stale/unknown evidence never qualifies. */
export function needsInputStatus(status: SessionStatus): boolean {
  return status === 'needs-input';
}
