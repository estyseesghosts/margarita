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

const statusGlyph: Readonly<Record<GoalStatus, string>> = {
  active: '◎',
  paused: '◌',
  complete: '●',
};

const statusWord: Readonly<Record<GoalStatus, string>> = {
  active: 'goal',
  paused: 'goal paused',
  complete: 'goal complete',
};

/**
 * The small footer badge. While a user-interrupt pause awaits a follow-up the badge says so
 * instead of pointing at an idle paused goal the user may not remember.
 */
export function goalBadge(goal: NativeGoal | null, awaitingSteer: string | undefined): string {
  if (goal === null) return '';
  if (awaitingSteer === goal.id && goal.status === 'paused')
    return `${statusGlyph.paused} goal · follow-up`;
  if (goal.status === 'active') return `${statusGlyph.active} goal · round ${goal.rounds}`;
  return `${statusGlyph[goal.status]} ${statusWord[goal.status]}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
