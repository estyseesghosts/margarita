import { isRecord } from './backend-event.ts';

/**
 * Goals, plans and task progress (docs/11). This is frontend sidecar data: it is never
 * inferred from assistant prose, and a task only changes state through an explicit user
 * action.
 */

export const taskStates = ['todo', 'in-progress', 'blocked', 'done', 'cancelled'] as const;
export type TaskState = (typeof taskStates)[number];

export type TaskEvidence = Readonly<{ messageID?: string; path?: string; note?: string }>;

export type PlanTask = Readonly<{
  id: string;
  title: string;
  description?: string;
  state: TaskState;
  deps: readonly string[];
  evidence: readonly TaskEvidence[];
  updatedAt: string;
}>;

export type Goal = Readonly<{
  title: string;
  detail?: string;
  acceptance: readonly string[];
  owner: 'user' | 'agent';
  updatedAt: string;
}>;

export type Plan = Readonly<{
  revision: number;
  source: 'user' | 'agent-proposal';
  accepted: boolean;
  updatedAt: string;
  tasks: readonly PlanTask[];
}>;

export type InstructionSync = Readonly<{
  enabled: boolean;
  key: string;
  /** Document revision last acknowledged by the server. */
  revision: number;
  lastAckAt?: string;
  error?: string;
}>;

export type GoalPlanV1 = Readonly<{
  schemaVersion: 1;
  /** File revision for compare-and-swap writes; bumps on every save. */
  revision: number;
  backend: string;
  sessionID: string;
  projectID: string;
  goal?: Goal;
  plan?: Plan;
  /** A plan proposed by the agent, waiting for the user to accept or reject it. */
  proposal?: Plan;
  modelInstructionSync?: InstructionSync;
}>;

export const instructionKey = 'margarita.goal.v1';

export function emptyGoalPlan(backend: string, sessionID: string, projectID: string): GoalPlanV1 {
  return { schemaVersion: 1, revision: 0, backend, sessionID, projectID };
}

// ---------- parsing and migration ----------

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function isTaskState(value: unknown): value is TaskState {
  return taskStates.some((state) => state === value);
}

function parseTask(raw: unknown, now: string): PlanTask | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw['id']);
  const title = text(raw['title']);
  if (id === undefined || title === undefined) return undefined;
  const description = text(raw['description']);
  const evidence: TaskEvidence[] = [];
  if (Array.isArray(raw['evidence'])) {
    for (const entry of raw['evidence']) {
      if (!isRecord(entry)) continue;
      const messageID = text(entry['messageID']);
      const path = text(entry['path']);
      const note = text(entry['note']);
      evidence.push({
        ...(messageID === undefined ? {} : { messageID }),
        ...(path === undefined ? {} : { path }),
        ...(note === undefined ? {} : { note }),
      });
    }
  }
  return {
    id,
    title,
    ...(description === undefined ? {} : { description }),
    state: isTaskState(raw['state']) ? raw['state'] : 'todo',
    deps: strings(raw['deps']),
    evidence,
    updatedAt: text(raw['updatedAt']) ?? now,
  };
}

function parsePlan(raw: unknown, now: string): Plan | undefined {
  if (!isRecord(raw) || !Array.isArray(raw['tasks'])) return undefined;
  const tasks = raw['tasks']
    .map((task) => parseTask(task, now))
    .filter((task) => task !== undefined);
  return {
    revision: typeof raw['revision'] === 'number' ? raw['revision'] : 1,
    source: raw['source'] === 'agent-proposal' ? 'agent-proposal' : 'user',
    accepted: raw['accepted'] === true,
    updatedAt: text(raw['updatedAt']) ?? now,
    tasks,
  };
}

function parseGoal(raw: unknown, now: string): Goal | undefined {
  // Version 0 stored the goal as a bare string.
  if (typeof raw === 'string') {
    return { title: raw, acceptance: [], owner: 'user', updatedAt: now };
  }
  if (!isRecord(raw)) return undefined;
  const title = text(raw['title']);
  if (title === undefined) return undefined;
  const detail = text(raw['detail']);
  return {
    title,
    ...(detail === undefined ? {} : { detail }),
    acceptance: strings(raw['acceptance']),
    owner: raw['owner'] === 'agent' ? 'agent' : 'user',
    updatedAt: text(raw['updatedAt']) ?? now,
  };
}

/**
 * Reads any known schema version and migrates it to V1. Unknown future versions are
 * rejected rather than guessed at, so an older build never overwrites newer data.
 */
export function parseGoalPlan(raw: unknown, now: string): GoalPlanV1 {
  if (!isRecord(raw)) throw new Error('goal plan is not an object');
  const version = raw['schemaVersion'] ?? 0;
  if (version !== 0 && version !== 1) {
    throw new Error(`goal plan schema ${JSON.stringify(version)} is newer than this build`);
  }
  const sessionID = text(raw['sessionID']);
  if (sessionID === undefined) throw new Error('goal plan has no session ID');
  const goal = parseGoal(raw['goal'], now);
  const plan = parsePlan(raw['plan'], now);
  const proposal = parsePlan(raw['proposal'], now);
  const sync = raw['modelInstructionSync'];
  let modelInstructionSync: InstructionSync | undefined;
  if (isRecord(sync)) {
    const lastAckAt = text(sync['lastAckAt']);
    modelInstructionSync = {
      enabled: sync['enabled'] === true,
      key: text(sync['key']) ?? instructionKey,
      revision: typeof sync['revision'] === 'number' ? sync['revision'] : 0,
      ...(lastAckAt === undefined ? {} : { lastAckAt }),
    };
  }
  return {
    schemaVersion: 1,
    revision: typeof raw['revision'] === 'number' ? raw['revision'] : 0,
    backend: text(raw['backend']) ?? 'local',
    sessionID,
    projectID: text(raw['projectID']) ?? '',
    ...(goal === undefined ? {} : { goal }),
    ...(plan === undefined ? {} : { plan }),
    ...(proposal === undefined ? {} : { proposal }),
    ...(modelInstructionSync === undefined ? {} : { modelInstructionSync }),
  };
}

// ---------- editing ----------

export function setGoal(doc: GoalPlanV1, title: string, now: string): GoalPlanV1 {
  const trimmed = title.trim();
  if (trimmed === '') {
    const { goal: _removed, ...rest } = doc;
    return rest;
  }
  return {
    ...doc,
    goal: {
      title: trimmed,
      acceptance: doc.goal?.acceptance ?? [],
      owner: 'user',
      updatedAt: now,
    },
  };
}

export function setAcceptance(
  doc: GoalPlanV1,
  criteria: readonly string[],
  now: string,
): GoalPlanV1 {
  if (doc.goal === undefined) return doc;
  return {
    ...doc,
    goal: {
      ...doc.goal,
      acceptance: criteria.filter((entry) => entry.trim() !== ''),
      updatedAt: now,
    },
  };
}

/** Extracts list items (`- x`, `* x`, `1. x`, `1) x`) or, failing that, `;`-separated steps. */
export function parseSteps(source: string): string[] {
  const listed = source
    .split('\n')
    .map((line) => /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line)?.[1])
    .filter((step) => step !== undefined);
  if (listed.length > 0) return listed;
  return source
    .split(/[;\n]/)
    .map((step) => step.trim())
    .filter((step) => step !== '');
}

function makeTasks(steps: readonly string[], now: string): PlanTask[] {
  return steps.map((title, index) => ({
    id: `t${index + 1}`,
    title,
    state: 'todo',
    deps: [],
    evidence: [],
    updatedAt: now,
  }));
}

/** A user-authored plan is authoritative immediately; it keeps states of tasks with the same title. */
export function setUserPlan(doc: GoalPlanV1, steps: readonly string[], now: string): GoalPlanV1 {
  const previous = new Map((doc.plan?.tasks ?? []).map((task) => [task.title, task]));
  const tasks = makeTasks(steps, now).map((task) => {
    const kept = previous.get(task.title);
    return kept === undefined ? task : { ...kept, id: task.id };
  });
  return {
    ...doc,
    plan: {
      revision: (doc.plan?.revision ?? 0) + 1,
      source: 'user',
      accepted: true,
      updatedAt: now,
      tasks,
    },
  };
}

export function proposePlan(doc: GoalPlanV1, steps: readonly string[], now: string): GoalPlanV1 {
  return {
    ...doc,
    proposal: {
      revision: (doc.plan?.revision ?? 0) + 1,
      source: 'agent-proposal',
      accepted: false,
      updatedAt: now,
      tasks: makeTasks(steps, now),
    },
  };
}

export function acceptProposal(doc: GoalPlanV1, now: string): GoalPlanV1 {
  if (doc.proposal === undefined) return doc;
  const { proposal, ...rest } = doc;
  return { ...rest, plan: { ...proposal, accepted: true, updatedAt: now } };
}

/** Rejecting leaves the current plan untouched. */
export function rejectProposal(doc: GoalPlanV1): GoalPlanV1 {
  const { proposal: _rejected, ...rest } = doc;
  return rest;
}

function updateTask(
  doc: GoalPlanV1,
  taskID: string,
  change: (task: PlanTask) => PlanTask,
): GoalPlanV1 {
  if (doc.plan === undefined) return doc;
  return {
    ...doc,
    plan: {
      ...doc.plan,
      tasks: doc.plan.tasks.map((task) => (task.id === taskID ? change(task) : task)),
    },
  };
}

export function setTaskState(
  doc: GoalPlanV1,
  taskID: string,
  state: TaskState,
  now: string,
): GoalPlanV1 {
  return updateTask(doc, taskID, (task) => ({ ...task, state, updatedAt: now }));
}

/** Space cycles todo → in progress → done → todo; blocked/cancelled return to todo. */
export function nextTaskState(state: TaskState): TaskState {
  if (state === 'todo') return 'in-progress';
  if (state === 'in-progress') return 'done';
  return 'todo';
}

export function addEvidence(
  doc: GoalPlanV1,
  taskID: string,
  evidence: TaskEvidence,
  now: string,
): GoalPlanV1 {
  return updateTask(doc, taskID, (task) => ({
    ...task,
    evidence: [...task.evidence, evidence],
    updatedAt: now,
  }));
}

export function setSync(doc: GoalPlanV1, enabled: boolean): GoalPlanV1 {
  return {
    ...doc,
    modelInstructionSync: {
      enabled,
      key: doc.modelInstructionSync?.key ?? instructionKey,
      revision: doc.modelInstructionSync?.revision ?? 0,
      ...(doc.modelInstructionSync?.lastAckAt === undefined
        ? {}
        : { lastAckAt: doc.modelInstructionSync.lastAckAt }),
    },
  };
}

/** Copies goal and plan into a forked session with fresh identity (docs/11: never alias). */
export function forkGoalPlan(doc: GoalPlanV1, sessionID: string): GoalPlanV1 {
  const { modelInstructionSync: _sync, proposal: _proposal, ...rest } = doc;
  return { ...rest, sessionID, revision: 0 };
}

// ---------- presentation ----------

export function progress(plan: Plan | undefined): { done: number; total: number } {
  const tasks = (plan?.tasks ?? []).filter((task) => task.state !== 'cancelled');
  return { done: tasks.filter((task) => task.state === 'done').length, total: tasks.length };
}

export const taskStateLabel: Record<TaskState, string> = {
  todo: 'todo',
  'in-progress': 'in progress',
  blocked: 'blocked',
  done: 'done',
  cancelled: 'cancelled',
};

const maxSyncedTasks = 20;

/** Compact model-facing summary (docs/11 example). Never a giant task dump. */
export function instructionText(doc: GoalPlanV1): string {
  const lines: string[] = [];
  if (doc.goal !== undefined) {
    lines.push(`User goal (revision ${doc.revision}): ${doc.goal.title}`);
    if (doc.goal.detail !== undefined) lines.push(`Constraints: ${doc.goal.detail}`);
  }
  if (doc.plan !== undefined && doc.plan.accepted) {
    const shown = doc.plan.tasks.slice(0, maxSyncedTasks);
    const steps = shown.map(
      (task, index) => `${index + 1}) ${task.title} [${taskStateLabel[task.state]}]`,
    );
    const more = doc.plan.tasks.length - shown.length;
    lines.push(`Accepted plan: ${steps.join(', ')}${more > 0 ? `, +${more} more` : ''}.`);
  }
  if (doc.goal !== undefined && doc.goal.acceptance.length > 0) {
    lines.push(`Acceptance: ${doc.goal.acceptance.join('; ')}.`);
  }
  if (lines.length === 0) return '';
  lines.push('Do not assume UI task states are proof of implementation; cite tests/logs.');
  return lines.join('\n');
}
