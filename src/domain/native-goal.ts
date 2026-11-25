import { strings } from '../i18n/index.ts';
/** Native OpenCode `opencode.goal` plugin state, decoded from the plugin's RPC wire shape. */

export type GoalStatus = 'active' | 'paused' | 'complete';

export type NativeGoal = Readonly<{
  id: string;
  objective: string;
  status: GoalStatus;
  reason?: string;
  rounds: number;
  maxRounds: number;
  stalls?: number;
}>;

/** Narrow guard for the plugin's RPC payloads. Wire data is never trusted. */
export function toNativeGoal(raw: unknown): NativeGoal | null {
  if (raw === null) return null;
  if (!isRecord(raw)) return null;
  const id = raw['id'];
  const objective = raw['objective'];
  const status = raw['status'];
  const rounds = raw['rounds'];
  const maxRounds = raw['maxRounds'];
  if (typeof id !== 'string' || typeof objective !== 'string') return null;
  if (status !== 'active' && status !== 'paused' && status !== 'complete') return null;
  if (typeof rounds !== 'number' || typeof maxRounds !== 'number') return null;
  if (!Number.isFinite(rounds) || !Number.isFinite(maxRounds)) return null;
  const reason = raw['reason'];
  const stalls = raw['stalls'];
  return {
    id,
    objective,
    status,
    ...(typeof reason === 'string' ? { reason } : {}),
    rounds,
    maxRounds,
    ...(typeof stalls === 'number' && Number.isFinite(stalls) ? { stalls } : {}),
  };
}

/** Why a goal read could not produce an authoritative answer. */
export type GoalQueryFailure = 'unsupported' | 'unauthorized' | 'transport' | 'unknown';

/**
 * What is known about a session's native goal. A failed read is `unavailable`, which is
 * never the same as a confirmed `none`: the last verified value may be kept for display,
 * but it is stale and must not drive goal actions.
 */
export type NativeGoalState =
  | { readonly status: 'unknown' }
  | { readonly status: 'loading' }
  | { readonly status: 'none' }
  | { readonly status: 'verified'; readonly goal: NativeGoal }
  | {
      readonly status: 'unavailable';
      readonly reason: GoalQueryFailure;
      readonly message: string;
      readonly sessionID: string;
      readonly directory?: string;
      /** Last verified reading (a goal, or null for a confirmed absence), if any. */
      readonly last?: NativeGoal;
    };

export const unknownGoal: NativeGoalState = { status: 'unknown' };

/** The last *verified* goal, or null. Stale or loading state never counts. */
export function verifiedGoal(state: NativeGoalState | undefined): NativeGoal | null {
  return state?.status === 'verified' ? state.goal : null;
}

/** True when a previous reading is being shown because the current one failed. */
export function goalIsStale(state: NativeGoalState | undefined): boolean {
  return state?.status === 'unavailable' && state.last !== undefined;
}

const statusGlyph: Readonly<Record<GoalStatus, string>> = {
  active: '◎',
  paused: '◌',
  complete: '●',
};

const statusWord: Readonly<Record<GoalStatus, string>> = strings.chrome.goalBadge.statusWords;

/**
 * The small footer badge. While a user-interrupt pause awaits a follow-up the badge says so
 * instead of pointing at an idle paused goal the user may not remember. An unreadable goal
 * is marked stale rather than shown as definitely active, and a failed read never claims
 * that no goal is set.
 */
export function goalBadge(
  state: NativeGoalState | undefined,
  awaitingSteer: string | undefined,
): string {
  if (state === undefined || state.status === 'unknown' || state.status === 'loading') return '';
  if (state.status === 'none') return '';
  if (state.status === 'unavailable') {
    if (state.last === undefined) return '';
    return strings.chrome.goalBadge.stale(statusGlyph[state.last.status]);
  }
  const goal = state.goal;
  if (awaitingSteer === goal.id && goal.status === 'paused')
    return strings.chrome.goalBadge.followUp(statusGlyph.paused);
  if (goal.status === 'active')
    return strings.chrome.goalBadge.active(statusGlyph.active, goal.rounds);
  return strings.chrome.goalBadge.status(statusGlyph[goal.status], statusWord[goal.status]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
