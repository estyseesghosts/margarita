import type { ModelSelection } from './model-ref.ts';
import type { CatalogModel } from './model-resolution.ts';
import type { TokenUsage } from './session.ts';
import {
  type AssistantPart,
  type ToolCall,
  toolIdentity,
  type TranscriptMessage,
} from './transcript.ts';

/**
 * Honest session analytics. Three quantities are deliberately kept apart:
 *  - lifetime consumption (server-reported `session.tokens` and `cost`, never reset),
 *  - current context occupancy (the latest assistant step after the last *completed*
 *    compaction, using that step's own model limit), and
 *  - activity counts derived from the loaded message window (labelled as such).
 *
 * Anything that cannot be measured is reported as `unknown`/`unavailable`, never as a
 * fabricated zero or a percentage with no denominator (issue #124).
 */

export type ContextStatus = 'unknown' | 'pending' | 'known';

export type ContextReading = Readonly<{
  status: ContextStatus;
  /** Sum of the latest step's token categories. Absent when no valid step is available. */
  tokens?: number;
  /** Context limit of the model used on that step, when the catalog knows it. */
  limit?: number;
  /** Occupancy percent (0–100) only when both tokens and limit are known. */
  occupancy?: number;
  /** The model actually used on the step, never the currently selected one. */
  model?: ModelSelection;
  /** Tokens consumed by steps after the last completed compaction, when derivable. */
  sinceCompaction?: number;
}>;

export type ToolCategoryKey =
  'read' | 'search' | 'edit' | 'shell' | 'web' | 'delegate' | 'mcp' | 'other';

export type UsageAnalytics = Readonly<{
  serverID: string;
  sessionID: string;
  /** Lifetime server totals; `undefined` means the server did not report them. */
  lifetime?: TokenUsage;
  /** Server-reported USD; `undefined` means unknown, NOT zero. */
  cost?: number;
  context: ContextReading;
  /** Completed *user* turns: one prompt plus its assistant steps, however many steps it took. */
  completedUserTurns: number;
  toolUsingTurns: number;
  /** toolUsingTurns / completedUserTurns, absent when the denominator is zero. */
  toolTurnPercent?: number;
  toolCalls: number;
  toolCategories: Readonly<Record<ToolCategoryKey, number>>;
  toolCompleted: number;
  toolFailed: number;
  /** Server-confirmed running calls only; streaming/pending/unknown states are not labelled running. */
  toolRunning: number;
  /** Streaming or otherwise unclassified tool states. */
  toolOther: number;
  /** failed / (completed + failed), absent without a known outcome denominator. */
  toolFailurePercent?: number;
  completedCompactions: number;
  lastCompactionAt?: number;
  /** Tool/turn stats come from the loaded window, not the whole (possibly paginated) session. */
  loadedOnly: boolean;
  stale: boolean;
}>;

export type UsageInput = Readonly<{
  serverID: string;
  sessionID: string;
  messages: readonly TranscriptMessage[];
  tokens?: TokenUsage;
  cost?: number;
  catalog: readonly CatalogModel[];
  mcpServers?: readonly string[];
  stale?: boolean;
}>;

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stepTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
}

/** Exact v2.3.0 context accounting: every reported category for one assistant step. */
export function assistantUsage(message: TranscriptMessage): TokenUsage | undefined {
  if (message.kind !== 'assistant' || message.usage === undefined) return undefined;
  const usage = message.usage;
  if (finite(usage.input) === undefined || finite(usage.output) === undefined) return undefined;
  return usage;
}

function contextLimitFor(
  model: ModelSelection,
  catalog: readonly CatalogModel[],
): number | undefined {
  const entry = catalog.find(
    (item) => item.providerID === model.providerID && item.modelID === model.modelID,
  );
  if (entry?.contextLimit === undefined) return undefined;
  const limit = finite(entry.contextLimit);
  return limit !== undefined && limit > 0 ? limit : undefined;
}

function toolsIn(parts: readonly AssistantPart[]): ToolCall[] {
  return parts.flatMap((part) => (part.kind === 'tool' ? [part.tool] : []));
}

function categoryOf(name: string, mcpServers: readonly string[]): ToolCategoryKey {
  const identity = toolIdentity(name, mcpServers);
  if (identity.kind === 'mcp') return 'mcp';
  if (identity.kind === 'builtin') return identity.category;
  return 'other';
}

/** Pure projector; no wire mapping and no UI formatting. */
export function projectUsage(input: UsageInput): UsageAnalytics {
  const messages = input.messages;
  const mcpServers = input.mcpServers ?? [];

  // Compaction boundary: only a *completed* compaction resets context. A running or failed
  // one keeps the previous boundary, so a failed compaction never resets the reading.
  let compactionIndex = -1;
  let completedCompactions = 0;
  let lastCompactionAt: number | undefined;
  messages.forEach((message, index) => {
    if (message.kind !== 'compaction' || message.state !== 'completed') return;
    compactionIndex = index;
    completedCompactions += 1;
    lastCompactionAt = message.createdAt;
  });

  // Active context moves only on a server-confirmed context event (a completed compaction
  // above). A staged files-only revert does not rewrite the conversation or its consumed
  // context, so it is deliberately not an input here (issue #142).
  const scoped: { message: Extract<TranscriptMessage, { kind: 'assistant' }>; index: number }[] =
    [];
  messages.forEach((message, index) => {
    if (index > compactionIndex && message.kind === 'assistant') {
      scoped.push({ message, index });
    }
  });
  const withUsage: {
    message: Extract<TranscriptMessage, { kind: 'assistant' }>;
    usage: TokenUsage;
  }[] = [];
  scoped.forEach((entry) => {
    const usage = assistantUsage(entry.message);
    if (usage !== undefined) withUsage.push({ message: entry.message, usage });
  });
  const latest = withUsage.at(-1);

  let context: ContextReading;
  if (latest === undefined) {
    context = { status: compactionIndex >= 0 ? 'pending' : 'unknown' };
  } else {
    const tokens = stepTokens(latest.usage);
    const limit = contextLimitFor(latest.message.model, input.catalog);
    context = {
      status: 'known',
      tokens,
      ...(limit === undefined ? {} : { limit, occupancy: Math.min(100, (tokens / limit) * 100) }),
      model: latest.message.model,
    };
  }
  if (compactionIndex >= 0) {
    const since = withUsage.reduce((sum, entry) => sum + stepTokens(entry.usage), 0);
    context = { ...context, sinceCompaction: since };
  }

  // Activity stats over the loaded window. A turn is one user prompt plus all of its
  // assistant steps, so multiple steps for a single prompt count as ONE completed turn (#141).
  // Tools from the active streaming step are included and reported by their real status,
  // while an incomplete first/last turn (no user boundary in the window) is not counted.
  const seen = new Set<string>();
  const tools: ToolCall[] = [];
  let completedUserTurns = 0;
  let toolUsingTurns = 0;
  let turnStarted = false;
  let turnCompleted = false;
  let turnUsedTools = false;
  const finishTurn = (): void => {
    if (turnStarted && turnCompleted) {
      completedUserTurns += 1;
      if (turnUsedTools) toolUsingTurns += 1;
    }
    turnStarted = false;
    turnCompleted = false;
    turnUsedTools = false;
  };
  messages.forEach((message) => {
    if (message.kind === 'user') {
      finishTurn();
      turnStarted = true;
      return;
    }
    if (message.kind !== 'assistant') return;
    const parts = toolsIn(message.parts);
    if (parts.length > 0) turnUsedTools = true;
    parts.forEach((tool) => {
      if (seen.has(tool.id)) return;
      seen.add(tool.id);
      tools.push(tool);
    });
    if (message.completedAt !== undefined) turnCompleted = true;
  });
  finishTurn();

  const toolCategories: Record<ToolCategoryKey, number> = {
    read: 0,
    search: 0,
    edit: 0,
    shell: 0,
    web: 0,
    delegate: 0,
    mcp: 0,
    other: 0,
  };
  let toolCompleted = 0;
  let toolFailed = 0;
  let toolRunning = 0;
  let toolOther = 0;
  tools.forEach((tool) => {
    toolCategories[categoryOf(tool.name, mcpServers)] += 1;
    if (tool.status === 'completed') toolCompleted += 1;
    else if (tool.status === 'error') toolFailed += 1;
    else if (tool.status === 'running') toolRunning += 1;
    else toolOther += 1; // streaming or unknown — never presented as running
  });

  const knownOutcomes = toolCompleted + toolFailed;
  return {
    serverID: input.serverID,
    sessionID: input.sessionID,
    ...(input.tokens === undefined ? {} : { lifetime: input.tokens }),
    ...(input.cost === undefined ? {} : { cost: input.cost }),
    context,
    completedUserTurns,
    toolUsingTurns,
    ...(completedUserTurns > 0
      ? { toolTurnPercent: (toolUsingTurns / completedUserTurns) * 100 }
      : {}),
    toolCalls: tools.length,
    toolCategories,
    toolCompleted,
    toolFailed,
    toolRunning,
    toolOther,
    ...(knownOutcomes > 0 ? { toolFailurePercent: (toolFailed / knownOutcomes) * 100 } : {}),
    completedCompactions,
    ...(lastCompactionAt === undefined ? {} : { lastCompactionAt }),
    loadedOnly: true,
    stale: input.stale ?? false,
  };
}
