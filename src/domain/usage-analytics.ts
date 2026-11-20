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
  completedAssistantTurns: number;
  toolUsingTurns: number;
  /** toolUsingTurns / completedAssistantTurns, absent when the denominator is zero. */
  toolTurnPercent?: number;
  toolCalls: number;
  toolCategories: Readonly<Record<ToolCategoryKey, number>>;
  toolCompleted: number;
  toolFailed: number;
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
  /** A staged revert boundary: assistant steps after it are excluded from active context. */
  revertMessageID?: string;
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

  // A staged revert excludes assistant steps at or after its boundary from active context.
  let upper = messages.length - 1;
  if (input.revertMessageID !== undefined) {
    const revertIndex = messages.findIndex((message) => message.id === input.revertMessageID);
    // The boundary message itself is part of the reverted state; only later steps are out.
    if (revertIndex >= 0) upper = revertIndex;
  }

  const scoped: { message: Extract<TranscriptMessage, { kind: 'assistant' }>; index: number }[] =
    [];
  messages.forEach((message, index) => {
    if (index <= upper && index > compactionIndex && message.kind === 'assistant') {
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

  // Activity stats over the loaded window. Each tool call belongs to exactly one category
  // and outcome; deduplicate by tool id so a repeated message cannot double-count.
  const seen = new Set<string>();
  const tools: ToolCall[] = [];
  let completedAssistantTurns = 0;
  let toolUsingTurns = 0;
  messages.forEach((message) => {
    if (message.kind !== 'assistant' || message.completedAt === undefined) return;
    completedAssistantTurns += 1;
    const parts = toolsIn(message.parts);
    if (parts.length > 0) toolUsingTurns += 1;
    parts.forEach((tool) => {
      if (seen.has(tool.id)) return;
      seen.add(tool.id);
      tools.push(tool);
    });
  });

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
  let toolOther = 0;
  tools.forEach((tool) => {
    toolCategories[categoryOf(tool.name, mcpServers)] += 1;
    if (tool.status === 'completed') toolCompleted += 1;
    else if (tool.status === 'error') toolFailed += 1;
    else toolOther += 1;
  });

  const knownOutcomes = toolCompleted + toolFailed;
  return {
    serverID: input.serverID,
    sessionID: input.sessionID,
    ...(input.tokens === undefined ? {} : { lifetime: input.tokens }),
    ...(input.cost === undefined ? {} : { cost: input.cost }),
    context,
    completedAssistantTurns,
    toolUsingTurns,
    ...(completedAssistantTurns > 0
      ? { toolTurnPercent: (toolUsingTurns / completedAssistantTurns) * 100 }
      : {}),
    toolCalls: tools.length,
    toolCategories,
    toolCompleted,
    toolFailed,
    toolOther,
    ...(knownOutcomes > 0 ? { toolFailurePercent: (toolFailed / knownOutcomes) * 100 } : {}),
    completedCompactions,
    ...(lastCompactionAt === undefined ? {} : { lastCompactionAt }),
    loadedOnly: true,
    stale: input.stale ?? false,
  };
}
