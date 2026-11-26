import { strings } from '../i18n/index.ts';
import type { Variations } from '../i18n/types.ts';
import { formatBytes } from './attachment.ts';
import type { ExecutionMarker } from './execution-segment.ts';
import type { ModelSelection } from './model-ref.ts';
import { retainedPayload } from './payload-retention.ts';
import { sanitizeSingleLine, sanitizeTerminalText } from './sanitize-text.ts';
import { assertNever, type TokenUsage } from './session.ts';
import { truncatePrompt } from './sticky-prompt.ts';
import { clipLineTailToCells, clipLineToCells, lineRows } from './text-width.ts';
import {
  classifyTool,
  isBuiltinToolName,
  type ToolCategory,
  toolIdentity,
} from './tool-classification.ts';
import { resolveVariation } from './variations.ts';
import type { WorkerJob } from './worker.ts';

// Kept as temporary re-exports while callers migrate to the focused module (#319).
export {
  classifyTool,
  mcpNamespace,
  toolIdentity,
  type ToolCategory,
  type ToolIdentity,
} from './tool-classification.ts';

/** Frontend projection of server messages; adapters map wire types into these. */
export type ToolStatus = 'streaming' | 'running' | 'completed' | 'error';

/** A file returned by a tool. Data URIs are described, never retained as encoded bytes. */
export type ToolFileReference = Readonly<{
  /** Safe display name: the server's name, else a MIME-derived label. */
  name: string;
  /** MIME type when the server supplied or the data URI declared one. */
  mime?: string;
  /** Verifiable decoded byte count for data URIs; omitted when unknown. */
  size?: number;
  /** A normal file/resource URI; never a `data:` payload. */
  uri?: string;
}>;

/**
 * One safe display label for a tool file. The value is not clipped here: the transcript
 * decides its cell budget, while the inspector/copy path must keep the full metadata.
 */
export function toolFileLabel(file: ToolFileReference): string {
  return [
    sanitizeSingleLine(file.name),
    ...(file.mime === undefined ? [] : [sanitizeSingleLine(file.mime)]),
    ...(file.size === undefined ? [] : [formatBytes(file.size)]),
    ...(file.uri === undefined ? [] : [sanitizeSingleLine(file.uri)]),
  ].join(' · ');
}

/** Corporeal row ceilings for metadata outside the nested-child budget (#277). */
export const toolMetadataRows: Readonly<
  Record<'compact' | 'detailed' | 'expanded', Readonly<{ error: number; files: number }>>
> = {
  compact: { error: 4, files: 4 },
  detailed: { error: 12, files: 16 },
  expanded: { error: 24, files: 48 },
};

export function toolMetadataRowBudget(
  kind: 'error' | 'files',
  detailed: boolean,
  expanded = false,
  baseRows = configuredPreviewRows,
): number {
  return scaleBudget(
    toolMetadataRows[expanded ? 'expanded' : detailed ? 'detailed' : 'compact'][kind],
    baseRows,
  );
}

/** First `rows` file references plus the exact number kept out of the inline window. */
export function toolFileWindow(
  files: readonly ToolFileReference[],
  rows: number,
): { visible: readonly ToolFileReference[]; hidden: number } {
  const budget = Math.max(0, Math.floor(rows));
  if (files.length <= budget) return { visible: files, hidden: 0 };
  return { visible: files.slice(0, budget), hidden: files.length - budget };
}

/** One nested Code Mode operation reported in `execute.metadata.toolCalls`. */
export type ToolCallChild = Readonly<{
  /** Stable `${parentID}:${index}` identity across progress snapshots. */
  id: string;
  parentID: string;
  /** Source order in the upstream `toolCalls` list. */
  index: number;
  /** Qualified name as reported (for example `lotus.get_issue`). */
  name: string;
  status: ToolStatus;
  /** Bounded, sanitized display input; never the full script. */
  input?: Readonly<Record<string, string | number | boolean>>;
  /**
   * Optional child diagnostics retained only when the server supplies them. OpenCode v2.3.x
   * reports just `tool`, `status` and `input`; these fields stay absent rather than invented.
   */
  error?: string;
  /** Bounded child output, retained only when present in the metadata. */
  output?: string;
  /** True when `output` was clipped to its bounded display size. */
  outputTruncated?: boolean;
  startedAt?: number;
  completedAt?: number;
}>;

export type ToolCall = Readonly<{
  id: string;
  name: string;
  status: ToolStatus;
  input: Readonly<Record<string, unknown>>;
  /**
   * Bounded preview of the tool output. When `outputTruncated` is set, only this preview
   * exists in the frontend; the rest was elided before or by this program.
   */
  output?: string;
  /** 'frontend' when the wire mapping elided the middle, 'server' when the server said it truncated. */
  outputTruncated?: 'frontend' | 'server';
  /** The server's unified diff for an edit, with real file line numbers. */
  diff?: string;
  /** The file the server said an edit touched (from its metadata), when input lacks one. */
  diffFile?: string;
  /** Structured file content parts; encoded data is never part of `output`. */
  files?: readonly ToolFileReference[];
  /** Nested Code Mode calls, in start order; only present when the server supplied them. */
  children?: readonly ToolCallChild[];
  /** `execute` returned a script error while the outer tool still completed. */
  executionError?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
}>;

export type AssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string; done: boolean }
  | { kind: 'tool'; tool: ToolCall };

/**
 * How much of a retained payload the source actually supplied (#221). `complete` means the
 * server supplied everything it had; display clipping is never reported here.
 */
export type SourceCompleteness = 'complete' | 'frontend-elided' | 'server-truncated';

/** One inspectable tool result: full retained text, diff and structured files. */
export type ToolResultPayload = Readonly<{
  /** Printable text without display prefixes; absent for files-only results. */
  text?: string;
  diff?: string;
  files: readonly ToolFileReference[];
  /** Code Mode's script failure, retained separately from the outer completion status. */
  executionError?: string;
  completeness: SourceCompleteness;
}>;

/** What the bounded transcript cache can offer when retrieval is unavailable. */
export function cachedToolResult(tool: ToolCall): ToolResultPayload {
  return {
    ...(tool.output === undefined ? {} : { text: tool.output }),
    ...(tool.diff === undefined ? {} : { diff: retainedPayload(tool, tool.diff) }),
    files: tool.files ?? [],
    ...(tool.executionError === undefined ? {} : { executionError: tool.executionError }),
    completeness:
      tool.outputTruncated === 'server'
        ? 'server-truncated'
        : tool.outputTruncated === 'frontend'
          ? 'frontend-elided'
          : 'complete',
  };
}

/** Human-readable provenance for the inspector header; never claims more than was supplied. */
export function completenessLabel(completeness: SourceCompleteness): string {
  switch (completeness) {
    case 'complete':
      return strings.transcript.completeness.complete;
    case 'frontend-elided':
      return strings.transcript.completeness.frontendElided;
    case 'server-truncated':
      return strings.transcript.completeness.serverTruncated;
    default:
      return assertNever(completeness);
  }
}

/** Locate the message that owns a tool part, for on-demand retrieval (#221). */
export function findToolMessage(
  messages: readonly TranscriptMessage[],
  toolID: string,
): { messageID: string; tool: ToolCall } | undefined {
  for (const message of messages) {
    if (message.kind !== 'assistant') continue;
    for (const part of message.parts) {
      if (part.kind === 'tool' && part.tool.id === toolID) {
        return { messageID: message.id, tool: part.tool };
      }
    }
  }
  return undefined;
}

export type TranscriptMessage =
  | { kind: 'user'; id: string; createdAt: number; text: string; attachments: readonly string[] }
  | {
      kind: 'assistant';
      id: string;
      createdAt: number;
      completedAt?: number;
      agent: string;
      model: ModelSelection;
      parts: readonly AssistantPart[];
      reasoningTokens?: number;
      /** Full per-step usage reported by the server, used for active-context accounting (#124). */
      usage?: TokenUsage;
      error?: string;
    }
  | {
      kind: 'shell';
      id: string;
      /** Wire `shellID`; links the message to its background job (#103). */
      shellID?: string;
      createdAt: number;
      command: string;
      status: 'running' | 'exited' | 'timeout' | 'killed';
      exitCode?: number;
      output?: string;
      /** The server truncated this output; the full text is available via its cursor RPC. */
      outputTruncated?: 'server';
    }
  | { kind: 'agent-switched'; id: string; createdAt: number; agent: string }
  | { kind: 'model-switched'; id: string; createdAt: number; model: ModelSelection }
  | {
      kind: 'idle';
      id: string;
      createdAt: number;
      outcome: 'succeeded' | 'failed' | 'interrupted';
      error?: string;
    }
  | { kind: 'compaction'; id: string; createdAt: number; state: 'running' | 'completed' | 'failed' }
  | { kind: 'note'; id: string; createdAt: number; text: string; source: 'synthetic' | 'system' };

/** The display/identity facts the transcript fold needs to recognize calls. */
export type ToolIdentityHints = Readonly<{
  /** Configured MCP servers; their flattened namespaces identify MCP calls. */
  mcpServers?: readonly string[];
}>;

export type TranscriptNode =
  | { kind: 'user'; key: string; text: string; attachments: readonly string[] }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'reasoning'; key: string; text: string; done: boolean }
  | { kind: 'reasoning-unavailable'; key: string; tokens: number }
  | {
      kind: 'tool';
      key: string;
      tool: ToolCall;
      category: ToolCategory;
      expanded: boolean;
      /** The user explicitly grew this item beyond the mode default (#219). */
      userExpanded?: boolean;
    }
  | {
      kind: 'tool-group';
      key: string;
      summary: string;
      running: boolean;
      /** The call executing right now inside this group, shown beneath the collapsed row. */
      live?: LiveTool;
      tools: readonly ToolCall[];
      expanded: boolean;
    }
  | {
      kind: 'shell';
      key: string;
      /** Wire `shellID`, used to confirm a timed-out shell is still running (#103). */
      shellID?: string;
      command: string;
      status: string;
      exitCode?: number;
      output?: string;
      outputTruncated?: 'server';
    }
  | { kind: 'notice'; key: string; text: string; tone: 'dim' | 'error' | 'warn' }
  | { kind: 'meta'; key: string; text: string }
  /**
   * Server-confirmed background subagent (#101). Distinct from a generic delegate tool row:
   * the worker can outlive the tool call that launched it and has its own child session.
   */
  | { kind: 'worker'; key: string; worker: WorkerJob; expanded: boolean }
  /** Lifecycle marker attached after a turn's own output; static when the run finished. */
  | { kind: 'execution'; key: string; segment: ExecutionMarker };

/** Configured visibility of authentic reasoning text; never a claim about token counts. */
export type ReasoningMode = 'hidden' | 'details-only' | 'always';

export type FoldOptions = Readonly<{
  detailed: boolean;
  reasoningMode?: ReasoningMode;
  groupTools?: 'compact' | 'none';
  /** Group keys the user expanded individually; see `groupKey`. */
  expandedGroups: ReadonlySet<string>;
  /** Tool IDs whose oversized inline diff the user expanded; see `clampDiffPatch`. */
  expandedDiffs?: ReadonlySet<string>;
  /**
   * Configured MCP servers. Their flattened tool namespaces (`<server>_<tool>`, the same
   * registry form OpenCode v2 uses) let a call keep its server identity in group summaries.
   */
  mcpServers?: readonly string[];
  /**
   * Execution markers keyed by the message id the marker is emitted after (the segment's
   * total extent: its idle message, or its last message while running).
   */
  markers?: ReadonlyMap<string, ExecutionMarker>;
  /**
   * First message index known to differ from the previous projection (#352). The controller
   * supplies this from canonical reconciliation so the projector does not rediscover the
   * changed range by scanning the whole history. A false boundary is rejected by an O(1)
   * identity check at the boundary and falls back to the safe scan.
   */
  changedFrom?: number;
}>;

/**
 * Every call that visibly happened folds into the activity group, MCP calls included. A
 * call to a server that is not configured still folds, so its summary can say it was an
 * external tool. Anything mutating the user's focus (failures) never folds, so a failed
 * MCP call keeps its error visible (issue #74).
 */
function isFoldable(tool: ToolCall, mcpServers: readonly string[]): boolean {
  if (tool.status === 'error' || tool.executionError !== undefined) return false;
  if (tool.children?.some((child) => child.status === 'error') === true) return false;
  if (isBuiltinToolName(tool.name)) {
    const category = classifyTool(tool.name);
    return (
      category === 'read' ||
      category === 'search' ||
      category === 'web' ||
      category === 'shell' ||
      category === 'code' ||
      category === 'edit'
    );
  }
  // Any non-builtin call is activity: MCP when its server is known, external otherwise.
  return toolIdentity(tool.name, mcpServers).kind !== 'builtin';
}

export function groupKey(tools: readonly ToolCall[]): string {
  return `group:${tools[0]?.id ?? 'empty'}`;
}

/**
 * Turns canonical messages into display nodes. Deterministic: depends only on message
 * order and fold state. Failures, user turns, final text and edits are never hidden.
 */
export function foldTranscript(
  messages: readonly TranscriptMessage[],
  options: FoldOptions,
): TranscriptNode[] {
  const out: TranscriptNode[] = [];
  for (const message of messages) {
    out.push(...foldMessageNodes(message, options));
    const marker = options.markers?.get(message.id);
    if (marker !== undefined) out.push(executionNode(marker));
  }
  return finishFoldedNodes(out, options);
}

/**
 * One canonical message's display nodes, before cross-message consolidation and grouping.
 * Deterministic and independent of its neighbours, which is what lets an incremental
 * projector cache it by message identity (#283).
 *
 * Every canonical assistant text part is user-visible prose. Whether text matters is not
 * decidable from its length, newline count, or whether a later step was appended (issue
 * #167): short status notes, warnings and intermediate results are all meaningful. The
 * fold therefore never discards canonical text — only repetitive tool calls collapse.
 * Tools still group, reasoning stays hidden in compact mode, and chronology is preserved.
 */
function foldMessageNodes(message: TranscriptMessage, options: FoldOptions): TranscriptNode[] {
  const out: TranscriptNode[] = [];
  switch (message.kind) {
    case 'user': {
      out.push({
        kind: 'user',
        key: message.id,
        text: message.text,
        attachments: message.attachments,
      });
      break;
    }
    case 'assistant':
      foldAssistant(message, options, out);
      break;
    case 'shell':
      out.push({
        kind: 'shell',
        key: message.id,
        ...(message.shellID === undefined ? {} : { shellID: message.shellID }),
        command: message.command,
        status: message.status,
        ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
        ...(message.output === undefined ? {} : { output: message.output }),
        ...(message.outputTruncated === undefined
          ? {}
          : { outputTruncated: message.outputTruncated }),
      });
      break;
    case 'agent-switched':
      out.push({
        kind: 'meta',
        key: message.id,
        text: strings.transcript.meta.agentSwitched(message.agent),
      });
      break;
    case 'model-switched':
      out.push({
        kind: 'meta',
        key: message.id,
        text: strings.transcript.meta.modelSwitched(message.model.modelID, message.model.variant),
      });
      break;
    case 'idle':
      if (message.outcome === 'failed') {
        out.push({
          kind: 'notice',
          key: message.id,
          text: strings.transcript.notices.runFailed(message.error),
          tone: 'error',
        });
      } else if (message.outcome === 'interrupted') {
        out.push({
          kind: 'notice',
          key: message.id,
          text: strings.transcript.notices.interrupted,
          tone: 'warn',
        });
      }
      break;
    case 'compaction':
      // A running compaction is the throbber's job ("Compacting conversation…");
      // only the terminal states earn a one-off transcript notice.
      if (message.state === 'running') break;
      out.push({
        kind: 'notice',
        key: message.id,
        text:
          message.state === 'failed'
            ? strings.transcript.notices.compactionFailed
            : strings.transcript.notices.compacted,
        tone: message.state === 'failed' ? 'error' : 'dim',
      });
      break;
    case 'note':
      if (options.detailed) {
        out.push({ kind: 'notice', key: message.id, text: message.text, tone: 'dim' });
      }
      break;
    default:
      assertNever(message);
  }
  return out;
}

function executionNode(marker: ExecutionMarker): TranscriptNode {
  return { kind: 'execution', key: `seg:${marker.id}`, segment: marker };
}

/** Cross-message passes applied to the concatenated per-message nodes. */
/** Compact grouping can be disabled independently of the detailed view. */
export function groupsEnabled(options: FoldOptions): boolean {
  return options.groupTools !== 'none' && !options.detailed;
}

/** Authentic reasoning text is never inferred from token counts alone. */
export function reasoningVisible(options: FoldOptions): boolean {
  const mode = options.reasoningMode ?? 'details-only';
  return mode === 'always' || (mode === 'details-only' && options.detailed);
}

function finishFoldedNodes(nodes: TranscriptNode[], options: FoldOptions): TranscriptNode[] {
  const consolidated = consolidateInterruptions(nodes);
  return groupsEnabled(options) ? mergeAdjacentGroups(consolidated, options) : consolidated;
}

/**
 * Visibility of a canonical transcript must not depend on the order a cache was filled.
 * The projector treats each canonical message as an immutable value: the controller's
 * `mergeLatest`/`loadOlder` replace the array and the affected message objects, so object
 * identity is a stronger change signal than an ID or timestamp (and catches non-tail
 * replacements and reorders).
 */
const toolArrayIDs = new WeakMap<readonly ToolCall[], number>();
let nextToolArrayID = 1;

function toolArrayKey(tools: readonly ToolCall[]): string {
  const existing = toolArrayIDs.get(tools);
  if (existing !== undefined) return String(existing);
  const id = nextToolArrayID++;
  toolArrayIDs.set(tools, id);
  return String(id);
}

/** Fold options that change per-message derivation. Cleared wholesale when they change. */
function foldOptionSignature(options: FoldOptions): string {
  // Group/diff disclosure is local to the affected message; it must not clear the entire
  // per-message cache. Detailed mode and the MCP catalog remain genuinely global (#354).
  return [
    options.detailed ? 'detailed' : 'compact',
    options.reasoningMode ?? 'details-only',
    options.groupTools ?? 'compact',
    (options.mcpServers ?? []).join('\u0001'),
  ].join('\u0000');
}

/** Disclosure state that changes this message's folded nodes (#354). */
function messageDisclosureKey(message: TranscriptMessage, options: FoldOptions): string {
  if (message.kind !== 'assistant') return '';
  const entries: string[] = [];
  for (const part of message.parts) {
    if (part.kind !== 'tool') continue;
    const id = part.tool.id;
    if (options.expandedDiffs?.has(id) === true) entries.push(`diff:${id}`);
    if (options.expandedGroups.has(`group:${id}`)) entries.push(`group:${id}`);
  }
  return entries.join('\u0001');
}

/** Disclosure state that changes the set of cached message derivations (#354). */
function disclosureOptionSignature(options: FoldOptions): string {
  return [
    [...options.expandedGroups].toSorted().join('\u0001'),
    [...(options.expandedDiffs ?? [])].toSorted().join('\u0001'),
  ].join('\u0000');
}

/** Marker fields that affect its rendered node; an unchanged marker reuses its node. */
function markerFingerprint(marker: ExecutionMarker): string {
  return [
    marker.id,
    marker.afterMessageId,
    marker.phase,
    String(marker.startedAt),
    String(marker.completedAt ?? ''),
    String(marker.durationMs ?? ''),
    Array.isArray(marker.activity) ? marker.activity.join('\u0001') : (marker.activity ?? ''),
  ].join('\u0000');
}

export type ProjectionStats = Readonly<{
  /** Messages whose per-message nodes were derived during this projection. */
  messagesFolded: number;
  /** Messages whose cached nodes were reused unchanged. */
  messagesReused: number;
  /** Messages in the suffix after the reusable execution boundary. */
  messagesReprocessed: number;
  /** Cross-message groups rebuilt during this projection. */
  groupsComputed: number;
  /** Cross-message groups reused by member identity. */
  groupsReused: number;
  /** Final nodes carried over verbatim from the previous projection. */
  prefixNodesReused: number;
  /** Prefix node references copied into a new flat array; 0 through the chunked view. */
  nodesCopied: number;
  /** Chunk/array allocations; each chunk holds many nodes and is not a per-node copy. */
  arraysAllocated: number;
  /** First message index the projection treated as changed. */
  changedFrom: number;
}>;

/**
 * A chunked, random-access view of final transcript nodes (#352). The stable prefix is kept
 * as chunks shared between projections; only the changed tail is rebuilt. Consumers that
 * truly need a flat array call `toArray()` and pay for it explicitly.
 */
export interface TranscriptNodeView {
  readonly length: number;
  at(index: number): TranscriptNode | undefined;
  /** Copies the half-open index range once, in forward order, without flattening the view. */
  range(start: number, end: number): readonly TranscriptNode[];
  tail(limit: number): readonly TranscriptNode[];
  toArray(): TranscriptNode[];
  some(predicate: (node: TranscriptNode) => boolean): boolean;
  /** Returns a view with `nodes` appended as one additional chunk. */
  append(nodes: readonly TranscriptNode[]): TranscriptNodeView;
  /** Returns a view with `notices` inserted directly after the node that owns `toolID`
   * (a tool or a tool-group). Only the affected chunk is rebuilt; every other chunk is
   * shared by reference, so a background confirmation never copies the whole transcript.
   * A notice for a tool absent from this view is dropped, never re-attached elsewhere (#135). */
  insertAfterTool(toolID: string, notices: readonly BackgroundNotice[]): TranscriptNodeView;
  [Symbol.iterator](): IterableIterator<TranscriptNode>;
  /** Pre-existing nodes re-copied by the last structural change that produced this view
   * (0 for a plain projector view; the size of the affected chunk after an insertion). */
  nodesCopied(): number;
}

export type TranscriptProjector = Readonly<{
  project(messages: readonly TranscriptMessage[], options: FoldOptions): TranscriptNode[];
  projectView(messages: readonly TranscriptMessage[], options: FoldOptions): TranscriptNodeView;
  lastStats(): ProjectionStats | undefined;
}>;

type MessageCacheEntry = Readonly<{
  /** Nodes derived from the message alone; expensive Markdown/diff work lives here. */
  content: readonly TranscriptNode[];
  markerKey: string;
  /** Local group/diff disclosure that produced `content` (#354). */
  disclosureKey: string;
  /** Content plus the marker node for `markerKey`; reused only while the marker agrees. */
  nodes: readonly TranscriptNode[];
}>;

type IndexedNode = Readonly<{ node: TranscriptNode; messageIndex: number }>;

type MergeCache = Map<string, Extract<TranscriptNode, { kind: 'tool-group' }>>;
type MergeTracker = { computed: number; reused: number };

/** Bounded cross-projection group reuse; a flush only costs one summary recomputation. */
const mergeCacheLimit = 512;

/**
 * Content equality is only a latest-page fallback (#283/#352). Older messages must be the
 * same object; otherwise a fresh DTO identity could trigger an accidental whole-history
 * deep comparison.
 */
const latestMessageRegion = 120;

function createNodeView(
  chunks: readonly (readonly TranscriptNode[])[],
  copied: number = 0,
): TranscriptNodeView {
  const offsets: number[] = [];
  let total = 0;
  for (const chunk of chunks) {
    offsets.push(total);
    total += chunk.length;
  }

  function at(index: number): TranscriptNode | undefined {
    if (index < 0 || index >= total) return undefined;
    let low = 0;
    let high = chunks.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const start = offsets[middle] ?? 0;
      const chunk = chunks[middle];
      if (chunk === undefined) return undefined;
      if (index < start) high = middle - 1;
      else if (index >= start + chunk.length) low = middle + 1;
      else return chunk[index - start];
    }
    return undefined;
  }

  function range(start: number, end: number): readonly TranscriptNode[] {
    const from = Math.max(0, Math.min(total, start));
    const to = Math.max(from, Math.min(total, end));
    const count = to - from;
    if (count === 0) return [];
    const result: TranscriptNode[] = [];
    result.length = count;
    let low = 0;
    let high = chunks.length - 1;
    let chunkIndex = chunks.length;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const chunkStart = offsets[middle] ?? 0;
      if (from < chunkStart) high = middle - 1;
      else {
        chunkIndex = middle;
        low = middle + 1;
      }
    }
    let written = 0;
    for (let index = chunkIndex; index < chunks.length && written < count; index += 1) {
      const chunk = chunks[index];
      if (chunk === undefined) continue;
      const copyFrom = Math.max(0, from - (offsets[index] ?? 0));
      const available = Math.min(chunk.length - copyFrom, count - written);
      if (available <= 0) continue;
      for (let offset = 0; offset < available; offset += 1) {
        result[written + offset] = chunk[copyFrom + offset]!;
      }
      written += available;
    }
    return result;
  }

  function tail(limit: number): readonly TranscriptNode[] {
    const count = Math.max(0, Math.min(limit, total));
    return range(total - count, total);
  }

  return {
    length: total,
    at,
    range,
    tail,
    toArray: () => chunks.flat(),
    some: (predicate) => chunks.some((chunk) => chunk.some(predicate)),
    append: (nodes) => createNodeView(nodes.length === 0 ? chunks : [...chunks, nodes], copied),
    insertAfterTool: (toolID, notices) => {
      // Find the chunk and position of the node that owns this tool.
      let targetChunk = -1;
      let targetIndex = -1;
      outer: for (let c = 0; c < chunks.length; c += 1) {
        const chunk = chunks[c];
        if (chunk === undefined) continue;
        for (let i = 0; i < chunk.length; i += 1) {
          const node = chunk[i];
          if (node === undefined) continue;
          if (nodeOwnsTool(node, toolID)) {
            targetChunk = c;
            targetIndex = i;
            break outer;
          }
        }
      }
      // A notice for a tool outside this view is dropped, never re-attached elsewhere (#135).
      if (targetChunk === -1) return createNodeView(chunks, copied);
      const chunk = chunks[targetChunk]!;
      const head = chunk.slice(0, targetIndex + 1);
      const rest = chunk.slice(targetIndex + 1);
      const rebuilt = [...head, ...notices.map(backgroundNoticeNode), ...rest];
      const nextChunks = chunks.slice();
      nextChunks[targetChunk] = rebuilt;
      // Only the affected chunk's pre-existing nodes are re-copied; every other chunk,
      // including the full 50k-node prefix, is shared by reference.
      return createNodeView(nextChunks, chunk.length);
    },
    nodesCopied: () => copied,
    *[Symbol.iterator]() {
      for (const chunk of chunks) yield* chunk;
    },
  };
}

/** Builds a one-chunk view for a flat array; use only when a flat result is unavoidable. */
export function nodeViewFromArray(nodes: readonly TranscriptNode[]): TranscriptNodeView {
  return createNodeView(nodes.length === 0 ? [] : [nodes]);
}

/** Truncates a chunk list to exactly `length` nodes without flattening the retained prefix. */
function truncateChunks(
  chunks: readonly (readonly TranscriptNode[])[],
  length: number,
): (readonly TranscriptNode[])[] {
  if (length <= 0) return [];
  const kept: (readonly TranscriptNode[])[] = [];
  let remaining = length;
  for (const chunk of chunks) {
    if (remaining <= 0) break;
    if (chunk.length <= remaining) {
      kept.push(chunk);
      remaining -= chunk.length;
    } else {
      kept.push(chunk.slice(0, remaining));
      remaining = 0;
    }
  }
  return kept;
}

/**
 * Incremental folded-node projector (#283, #352).
 *
 * Canonical messages are folded once and cached by object identity; cross-message work is
 * limited to the current segment. A projection reuses the previous final nodes up to the last
 * execution marker in the unchanged prefix, because an execution marker closes a segment:
 * interruption consolidation and tool grouping never cross one. Stable prefix nodes live in
 * chunks shared between projections, so a tail update does not copy the loaded history.
 */
export function createTranscriptProjector(): TranscriptProjector {
  let messageCache = new WeakMap<TranscriptMessage, MessageCacheEntry>();
  let signature: string | undefined;
  let mergeCache: MergeCache = new Map();
  let baseLists: (readonly TranscriptNode[])[] = [];
  let previousMessages: readonly TranscriptMessage[] = [];
  let chunks: readonly (readonly TranscriptNode[])[] = [];
  let endOffsetByMessage: number[] = [];
  let stats: ProjectionStats | undefined;
  let disclosureSignature: string | undefined;

  function reset(): void {
    messageCache = new WeakMap();
    mergeCache = new Map();
    baseLists = [];
    previousMessages = [];
    chunks = [];
    endOffsetByMessage = [];
    disclosureSignature = undefined;
  }

  function projectView(
    messages: readonly TranscriptMessage[],
    options: FoldOptions,
  ): TranscriptNodeView {
    const nextSignature = foldOptionSignature(options);
    if (nextSignature !== signature) {
      signature = nextSignature;
      reset();
    }

    // The controller knows the first changed message from canonical reconciliation. Accept the
    // hint only when the message before it is still the same object; otherwise fall back to the
    // bounded identity scan so a stale hint can never reuse a stale prefix.
    const comparable = Math.min(previousMessages.length, messages.length);
    const hint = options.changedFrom;
    let firstDifference: number;
    if (
      hint !== undefined &&
      Number.isInteger(hint) &&
      hint >= 0 &&
      hint <= messages.length &&
      (hint === 0 || (hint <= comparable && previousMessages[hint - 1] === messages[hint - 1]))
    ) {
      firstDifference = hint;
    } else {
      firstDifference = 0;
      while (
        firstDifference < comparable &&
        previousMessages[firstDifference] === messages[firstDifference]
      ) {
        firstDifference += 1;
      }
    }

    // Never reuse the final open turn: its marker (running phase, activity) can change
    // without any message changing. The previous projection's open turn is excluded too,
    // because appending its idle (or a later message) closes it and rewrites that marker.
    const openTurnStart = lastIdleIndex(messages) + 1;
    const previousOpenTurnStart = lastIdleIndex(previousMessages) + 1;
    let reusableEnd = -1;

    // A disclosure-only change does not alter message identities. Scan cached disclosure keys
    // to find the first affected message; this is cheap key work, not a Markdown/diff refold,
    // and it prevents the prefix from being reused with stale expansion state (#354).
    const nextDisclosure = disclosureOptionSignature(options);
    const disclosureChanged = nextDisclosure !== disclosureSignature;
    disclosureSignature = nextDisclosure;
    if (disclosureChanged && previousMessages.length > 0) {
      const comparableDisclosure = Math.min(previousMessages.length, messages.length);
      for (let index = 0; index < comparableDisclosure; index += 1) {
        const message = messages[index];
        if (message === undefined) continue;
        const previous = previousMessages[index];
        const candidate =
          messageCache.get(message) ??
          (previous === undefined ? undefined : messageCache.get(previous));
        if (candidate === undefined) continue;
        if (candidate.disclosureKey !== messageDisclosureKey(message, options)) {
          firstDifference = Math.min(firstDifference, index);
          break;
        }
      }
    }

    const reuseLimit = Math.min(firstDifference, openTurnStart, previousOpenTurnStart);
    for (let index = reuseLimit - 1; index >= 0; index -= 1) {
      const nodes = baseLists[index];
      if (nodes !== undefined && endsSegment(nodes)) {
        reusableEnd = index;
        break;
      }
    }

    // Keep the old suffix refs only for the bounded region being rebuilt; the stable prefix is
    // never copied. This also lets us extend reuse across identical rebuilt lists.
    const rebuildStart = reusableEnd + 1;
    const oldSuffix = baseLists.slice(rebuildStart);
    baseLists.length = rebuildStart;

    let messagesFolded = 0;
    let messagesReused = rebuildStart;
    for (let index = rebuildStart; index < messages.length; index += 1) {
      const message = messages[index];
      if (message === undefined) {
        baseLists.push([]);
        continue;
      }
      const marker = options.markers?.get(message.id);
      const markerKey = marker === undefined ? '' : markerFingerprint(marker);
      const disclosureKey = messageDisclosureKey(message, options);
      // A server page arrives as fresh objects even when its content is unchanged, so a
      // reference miss falls back to content equality against the same slot. The fallback is
      // deliberately restricted to the latest page; older history must keep identity (#352).
      const previous = previousMessages[index];
      const candidate =
        messageCache.get(message) ??
        (previous === undefined ? undefined : messageCache.get(previous));
      const contentUnchanged =
        candidate !== undefined &&
        candidate.disclosureKey === disclosureKey &&
        (previous === undefined ||
          previous === message ||
          (index >= messages.length - latestMessageRegion && Bun.deepEquals(previous, message)));
      if (contentUnchanged && candidate !== undefined) {
        // A segment marker may move or change phase without changing the message. Reuse the
        // content nodes and only rebuild the tiny marker tail, so a streaming activity update
        // cannot force Markdown/diff formatting again (#286).
        const nodes =
          candidate.markerKey === markerKey
            ? candidate.nodes
            : marker === undefined
              ? candidate.content
              : [...candidate.content, executionNode(marker)];
        messageCache.set(message, {
          content: candidate.content,
          markerKey,
          disclosureKey,
          nodes,
        });
        baseLists.push(nodes);
        messagesReused += 1;
        continue;
      }
      const content = foldMessageNodes(message, options);
      const nodes = marker === undefined ? content : [...content, executionNode(marker)];
      messageCache.set(message, { content, markerKey, disclosureKey, nodes });
      baseLists.push(nodes);
      messagesFolded += 1;
    }

    // Extend reuse only across matching lists that also end a segment.
    let cut = reusableEnd;
    for (let index = rebuildStart; index < baseLists.length; index += 1) {
      const old = oldSuffix[index - rebuildStart];
      if (old !== baseLists[index]) break;
      const nodes = baseLists[index];
      if (nodes !== undefined && endsSegment(nodes)) cut = index;
    }

    const prefixLength = cut >= 0 ? (endOffsetByMessage[cut] ?? 0) : 0;
    const startIndex = cut >= 0 ? cut + 1 : 0;
    const indexed: IndexedNode[] = [];
    for (let index = startIndex; index < baseLists.length; index += 1) {
      for (const node of baseLists[index] ?? []) indexed.push({ node, messageIndex: index });
    }

    const tracker: MergeTracker = { computed: 0, reused: 0 };
    const consolidated = consolidateInterruptionsIndexed(indexed);
    const finished = groupsEnabled(options)
      ? mergeAdjacentGroupsIndexed(consolidated, options, mergeCache, tracker)
      : consolidated;

    const suffixNodes = finished.map((entry) => entry.node);
    const keptChunks = truncateChunks(chunks, prefixLength);
    chunks = suffixNodes.length === 0 ? keptChunks : [...keptChunks, suffixNodes];

    // Record how many final nodes each message owns, so a later projection can cut at an
    // execution marker without replaying consolidation/grouping before it.
    let cursor = 0;
    for (let index = startIndex; index < baseLists.length; index += 1) {
      while (cursor < finished.length && (finished[cursor]?.messageIndex ?? 0) <= index) {
        cursor += 1;
      }
      endOffsetByMessage[index] = prefixLength + cursor;
    }
    endOffsetByMessage.length = baseLists.length;

    const nextStats: ProjectionStats = {
      messagesFolded,
      messagesReused,
      messagesReprocessed: baseLists.length - startIndex,
      groupsComputed: tracker.computed,
      groupsReused: tracker.reused,
      prefixNodesReused: prefixLength,
      nodesCopied: 0,
      arraysAllocated:
        1 + (suffixNodes.length === 0 ? 0 : 1) + (keptChunks.length === chunks.length ? 0 : 1),
      changedFrom: firstDifference,
    };
    previousMessages = messages;
    stats = nextStats;
    return createNodeView(chunks);
  }

  function project(messages: readonly TranscriptMessage[], options: FoldOptions): TranscriptNode[] {
    return projectView(messages, options).toArray();
  }

  return { project, projectView, lastStats: () => stats };
}

function endsSegment(nodes: readonly TranscriptNode[]): boolean {
  const last = nodes.at(-1);
  return last !== undefined && last.kind === 'execution';
}

/** Index of the newest idle message; everything after it belongs to the open turn. */
function lastIdleIndex(messages: readonly TranscriptMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === 'idle') return index;
  }
  return -1;
}

/** Normalizes a candidate interruption banner without touching the source text. */
function isInterruptionBanner(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/^[*_`]+|[*_`]+$/g, '')
    .replace(/[.!]+$/, '')
    .trim()
    .toLowerCase();
  return normalized === 'step interrupted' || normalized === 'interrupted';
}

/**
 * One status row per interrupted segment (#207). The server can emit an assistant
 * `Step interrupted` text part *and* an idle outcome, while we also render the timed
 * execution marker. Collapse only exact banners inside a segment whose marker says
 * `interrupted`; source messages are untouched, and extra detail prose is preserved.
 */
function consolidateInterruptions(nodes: readonly TranscriptNode[]): TranscriptNode[] {
  return consolidateInterruptionsIndexed(
    nodes.map((node, messageIndex) => ({ node, messageIndex })),
  ).map((entry) => entry.node);
}

function consolidateInterruptionsIndexed(nodes: readonly IndexedNode[]): IndexedNode[] {
  const consolidated: IndexedNode[] = [];
  let segment: IndexedNode[] = [];
  const flush = (interrupted: boolean) => {
    for (const entry of segment) {
      if (!interrupted) {
        consolidated.push(entry);
        continue;
      }
      if (entry.node.kind === 'notice' && isInterruptionBanner(entry.node.text)) continue;
      if (entry.node.kind === 'text' && isInterruptionBanner(entry.node.text)) continue;
      consolidated.push(entry);
    }
    segment = [];
  };
  for (const entry of nodes) {
    if (entry.node.kind === 'execution') {
      flush(entry.node.segment.phase === 'interrupted');
      consolidated.push(entry);
    } else {
      segment.push(entry);
    }
  }
  flush(false);
  return consolidated;
}

type GroupNode = Extract<TranscriptNode, { kind: 'tool-group' }>;

/** Calls split across assistant messages still read as one uninterrupted activity segment. */
function mergeAdjacentGroups(
  nodes: readonly TranscriptNode[],
  options: FoldOptions,
): TranscriptNode[] {
  return mergeAdjacentGroupsIndexed(
    nodes.map((node, messageIndex) => ({ node, messageIndex })),
    options,
  ).map((entry) => entry.node);
}

function mergeAdjacentGroupsIndexed(
  nodes: readonly IndexedNode[],
  options: FoldOptions,
  cache?: MergeCache,
  tracker?: MergeTracker,
): IndexedNode[] {
  type IndexedGroup = Readonly<{ node: GroupNode; messageIndex: number }>;
  const merged: IndexedNode[] = [];
  let run: IndexedGroup[] = [];
  const flush = () => {
    const first = run[0];
    if (first === undefined) return;
    if (run.length === 1) {
      merged.push(first);
      run = [];
      return;
    }
    const groups = run.map((entry) => entry.node);
    const cacheKey = groups.map((group) => toolArrayKey(group.tools)).join('|');
    const cached = cache?.get(cacheKey);
    let group: GroupNode;
    if (cached !== undefined) {
      if (tracker !== undefined) tracker.reused += 1;
      group = cached;
    } else {
      const tools = groups.flatMap((entry) => entry.tools);
      const key = groupKey(tools);
      const live = liveToolLine(tools, options.mcpServers);
      group = {
        kind: 'tool-group',
        key,
        summary: summarizeTools(tools, options.mcpServers),
        running: groups.some((entry) => entry.running),
        ...(live === undefined ? {} : { live }),
        tools,
        expanded: groups.some((entry) => entry.expanded) || options.expandedGroups.has(key),
      };
      if (cache !== undefined) {
        cache.set(cacheKey, group);
        if (cache.size > mergeCacheLimit) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
      }
      if (tracker !== undefined) tracker.computed += 1;
    }
    merged.push({
      node: group,
      messageIndex: run[run.length - 1]?.messageIndex ?? first.messageIndex,
    });
    run = [];
  };
  for (const entry of nodes) {
    if (entry.node.kind === 'tool-group') {
      run.push({ node: entry.node, messageIndex: entry.messageIndex });
    } else {
      flush();
      merged.push(entry);
    }
  }
  flush();
  return merged;
}

function foldAssistant(
  message: Extract<TranscriptMessage, { kind: 'assistant' }>,
  options: FoldOptions,
  out: TranscriptNode[],
): void {
  let pending: ToolCall[] = [];
  let sawReasoningText = false;
  const needsExpansion = (tool: ToolCall) =>
    options.detailed ||
    tool.status === 'error' ||
    tool.executionError !== undefined ||
    tool.children?.some((child) => child.status === 'error') === true ||
    options.expandedDiffs?.has(tool.id) === true;
  const emitTool = (tool: ToolCall) => {
    out.push({
      kind: 'tool',
      key: tool.id,
      tool,
      category: classifyTool(tool.name),
      expanded: needsExpansion(tool),
      ...(options.expandedDiffs?.has(tool.id) === true ? { userExpanded: true } : {}),
    });
  };
  const emitGroup = (tools: ToolCall[]) => {
    const key = groupKey(tools);
    const live = liveToolLine(tools, options.mcpServers);
    out.push({
      kind: 'tool-group',
      key,
      summary: summarizeTools(tools, options.mcpServers),
      running: tools.some((tool) => tool.status === 'running' || tool.status === 'streaming'),
      ...(live === undefined ? {} : { live }),
      tools,
      expanded: options.expandedGroups.has(key),
    });
  };
  const flush = () => {
    if (pending.length === 0) return;
    if (options.detailed) {
      for (const tool of pending) emitTool(tool);
      pending = [];
      return;
    }
    // Split into inspection and edit segments; consecutive same-category runs fold.
    // A lone edit keeps its own row: the inline diff is the content the user asked
    // to see, not noise to fold. Runs of 2+ edits fold like other activity.
    let segment: ToolCall[] = [];
    let segmentEdit: boolean | undefined;
    const emitSegment = () => {
      if (segment.length === 0) return;
      if (segmentEdit === true && segment.length === 1) {
        emitTool(segment[0]!);
      } else {
        emitGroup(segment);
      }
      segment = [];
    };
    for (const tool of pending) {
      const isEdit = classifyTool(tool.name) === 'edit';
      if (segmentEdit !== undefined && isEdit !== segmentEdit) emitSegment();
      segmentEdit = isEdit;
      segment.push(tool);
    }
    emitSegment();
    pending = [];
  };
  message.parts.forEach((part, index) => {
    switch (part.kind) {
      case 'tool':
        if (isFoldable(part.tool, options.mcpServers ?? [])) {
          pending.push(part.tool);
          return;
        }
        flush();
        out.push({
          kind: 'tool',
          key: part.tool.id,
          tool: part.tool,
          category: classifyTool(part.tool.name),
          expanded: needsExpansion(part.tool),
          ...(options.expandedDiffs?.has(part.tool.id) === true ? { userExpanded: true } : {}),
        });
        return;
      case 'text': {
        // Canonical assistant text is never discarded in compact mode: a later reasoning,
        // tool or assistant step must not make already-visible prose disappear (issue #167).
        if (part.text.trim() === '') return;
        flush();
        out.push({ kind: 'text', key: `${message.id}:${index}`, text: part.text });
        return;
      }
      case 'reasoning':
        if (part.text.trim() !== '') sawReasoningText = true;
        // Live reasoning status is the throbber's job; the transcript only shows
        // authentic reasoning text, at the configured visibility.
        if (reasoningVisible(options) && part.text.trim() !== '') {
          flush();
          out.push({
            kind: 'reasoning',
            key: `${message.id}:${index}`,
            text: part.text,
            done: part.done,
          });
        }
        return;
      default:
        assertNever(part);
    }
  });
  flush();
  if (
    reasoningVisible(options) &&
    !sawReasoningText &&
    message.reasoningTokens !== undefined &&
    message.reasoningTokens > 0
  ) {
    out.push({
      kind: 'reasoning-unavailable',
      key: `${message.id}:reasoning`,
      tokens: message.reasoningTokens,
    });
  }
  if (message.error !== undefined) {
    out.push({ kind: 'notice', key: `${message.id}:error`, text: message.error, tone: 'error' });
  }
}

const verbs: Readonly<Record<ToolCategory, (count: number) => string>> = strings.transcript.tools;

/** Nested Code Mode operations replace their `execute` wrapper in activity summaries. */
function summaryEntries(tools: readonly ToolCall[]): readonly { name: string }[] {
  const entries: { name: string }[] = [];
  for (const tool of tools) {
    if (
      classifyTool(tool.name) === 'code' &&
      tool.children !== undefined &&
      tool.children.length > 0
    ) {
      entries.push(...tool.children.map((child) => ({ name: child.name })));
    } else {
      entries.push({ name: tool.name });
    }
  }
  return entries;
}

function callVerb(count: number, server: string | undefined): string {
  // A known server keeps its name; unknown external tools are never attributed to one.
  if (server === undefined) return strings.transcript.tools.externalCalls(count);
  return strings.transcript.tools.serverCalls(server, count);
}

/**
 * `Read 3 files, called lotus 4 times, ran 2 shell commands`, derived from data only.
 * MCP calls are counted per server; calls to a server that is not configured fall back to
 * a truthful external count instead of borrowing another server's name (issue #74).
 */
export function summarizeTools(
  tools: readonly ToolCall[],
  mcpServers: readonly string[] = [],
): string {
  // One ordered bucket list, in first-appearance order: the reference layout reads
  // "Reading 2 files, calling lotus 4 times, running 2 shell commands".
  const counts = new Map<string, { phrase: (count: number) => string; count: number }>();
  for (const tool of summaryEntries(tools)) {
    const identity = toolIdentity(tool.name, mcpServers);
    const key =
      identity.kind === 'builtin'
        ? `builtin:${identity.category}`
        : identity.kind === 'mcp'
          ? `mcp:${identity.server}`
          : 'external';
    const phrase =
      identity.kind === 'builtin'
        ? verbs[identity.category]
        : (count: number) => callVerb(count, identity.kind === 'mcp' ? identity.server : undefined);
    const bucket = counts.get(key);
    if (bucket === undefined) counts.set(key, { phrase, count: 1 });
    else bucket.count += 1;
  }
  return [...counts.values()]
    .map((bucket) => bucket.phrase(bucket.count))
    .map((phrase, index) =>
      index === 0 ? phrase : phrase.charAt(0).toLowerCase() + phrase.slice(1),
    )
    .join(', ');
}

/** Longest single-line tool name shown before it is clamped with an ellipsis. */
const liveToolNameMaxWidth = 48;

const liveArgumentKeys = ['command', 'filePath', 'path', 'pattern', 'url', 'query', 'description'];

const activityLabels: Readonly<Record<ToolCategory, Variations>> = strings.transcript.live;

/**
 * The one call to name beneath a collapsed group: the most recently started call that is
 * genuinely `running`/`streaming`. A finished call never qualifies, so a collapsed
 * historical group shows no fake live line (issue #75).
 */
export function activeTool(tools: readonly ToolCall[]): ToolCall | undefined {
  return tools
    .filter((tool) => tool.status === 'running' || tool.status === 'streaming')
    .toSorted((left, right) => right.startedAt - left.startedAt)[0];
}

/**
 * Index of the folded transcript node that owns a specific tool call (#135). A call inside a
 * folded group is confirmed under that group; an expanded single call under its own row.
 * `undefined` means the call is not in this window, so no confirmation may be attached —
 * never fall back to "the last tool-looking node" and mislabel an unrelated call.
 */
/** True when `node` is the tool or tool-group node that owns `toolID`. */
function nodeOwnsTool(node: TranscriptNode, toolID: string): boolean {
  return (
    (node.kind === 'tool' && node.tool.id === toolID) ||
    (node.kind === 'tool-group' && node.tools.some((tool) => tool.id === toolID))
  );
}

export function nodeIndexForTool(
  nodes: readonly TranscriptNode[],
  toolID: string,
): number | undefined {
  const index = nodes.findIndex(
    (node) =>
      (node.kind === 'tool' && node.tool.id === toolID) ||
      (node.kind === 'tool-group' && node.tools.some((tool) => tool.id === toolID)),
  );
  return index === -1 ? undefined : index;
}

/** A transient background confirmation bound to one tool call (#135). */
export type BackgroundNotice = Readonly<{ toolID: string; text: string }>;

/**
 * Inserts each confirmation immediately after the node that owns its tool ID. Notices for the
 * same node keep their input order; a notice whose tool is not in this window is dropped rather
 * than attached to an unrelated call. No "last tool-looking node" fallback (#135).
 */
/** Builds a transient background-notice node for one confirmed backgrounded tool (#135). */
function backgroundNoticeNode(notice: BackgroundNotice): TranscriptNode {
  return { kind: 'notice', key: `background:${notice.toolID}`, text: notice.text, tone: 'dim' };
}

export function attachBackgroundNotices(
  nodes: readonly TranscriptNode[],
  notices: readonly BackgroundNotice[],
): TranscriptNode[] {
  if (notices.length === 0) return [...nodes];
  const byIndex = new Map<number, TranscriptNode[]>();
  for (const notice of notices) {
    const index = nodeIndexForTool(nodes, notice.toolID);
    if (index === undefined) continue;
    const inserted = byIndex.get(index) ?? [];
    inserted.push({
      kind: 'notice',
      key: `background:${notice.toolID}`,
      text: notice.text,
      tone: 'dim',
    });
    byIndex.set(index, inserted);
  }
  if (byIndex.size === 0) return [...nodes];
  return nodes.flatMap((node, index) =>
    byIndex.has(index) ? [node, ...(byIndex.get(index) ?? [])] : [node],
  );
}

export type LiveTool = Readonly<{
  /** Safe single-line label: `$ tail -8 file`, `lotus: get_issue`, `Reading src/a.ts`. */
  text: string;
  /** Wall start of this exact call, so a contextual hint times the call, not the turn. */
  startedAt: number;
  /** True only for a shell command, the one kind of call that can be backgrounded. */
  shell: boolean;
}>;

/** A hint about a long-running call is meaningless before this much wall time. */
export const backgroundHintAfterMs = 10_000;

/**
 * Safe single-line label for an executing call. Arguments are clipped to their first line
 * and sanitized; the caller clips to the terminal width.
 */
export function liveToolLine(
  tools: readonly ToolCall[],
  mcpServers: readonly string[] = [],
  nowMs: number = Date.now(),
): LiveTool | undefined {
  const active = activeTool(tools);
  if (active === undefined) return undefined;
  if (classifyTool(active.name) === 'code' && active.children !== undefined) {
    const child = active.children
      .filter((entry) => entry.status === 'running' || entry.status === 'streaming')
      .at(-1);
    if (child !== undefined) {
      const identity = toolIdentity(child.name, mcpServers);
      if (identity.kind === 'mcp') {
        return {
          text: `${identity.server}: ${identity.tool}`,
          startedAt: active.startedAt,
          shell: false,
        };
      }
      return {
        text: truncatePrompt(sanitizeTerminalText(child.name), liveToolNameMaxWidth),
        startedAt: active.startedAt,
        shell: false,
      };
    }
  }
  const identity = toolIdentity(active.name, mcpServers);
  const shell = classifyTool(active.name) === 'shell';
  if (identity.kind === 'mcp')
    return { text: `${identity.server}: ${identity.tool}`, startedAt: active.startedAt, shell };
  const category = classifyTool(active.name);
  // Unknown external calls keep their own sanitized name so the user can tell what is
  // executing instead of only a generic verb, plus the first safe argument when available
  // (issue #114).
  if (identity.kind === 'external') {
    const name = truncatePrompt(
      (sanitizeTerminalText(active.name).split('\n')[0] ?? '').trim(),
      liveToolNameMaxWidth,
    );
    const firstLine = liveArgumentKeys
      .map((key) => active.input[key])
      .find((value): value is string => typeof value === 'string' && value.trim() !== '')
      ?.split('\n')[0]
      ?.trim();
    const arg =
      firstLine === undefined || firstLine === ''
        ? ''
        : ` ${truncatePrompt(sanitizeTerminalText(firstLine), liveToolNameMaxWidth)}`;
    return { text: name + arg, startedAt: active.startedAt, shell };
  }
  const verb = resolveVariation(activityLabels[category], nowMs) ?? '';
  const target = liveArgumentKeys
    .map((key) => active.input[key])
    .find((value): value is string => typeof value === 'string' && value.trim() !== '');
  const firstLine = target?.split('\n')[0]?.trim();
  const text =
    firstLine === undefined || firstLine === ''
      ? verb
      : category === 'shell'
        ? `$ ${firstLine}`
        : `${verb} ${firstLine}`;
  return { text, startedAt: active.startedAt, shell };
}

/**
 * Whether the live call has been running strictly longer than the threshold. Only a shell
 * call qualifies: the background action moves running tools, and the hint is contextual to
 * the command the user is waiting on (issue #76).
 */
export function backgroundHint(
  live: LiveTool | undefined,
  nowMs: number,
  thresholdMs: number = backgroundHintAfterMs,
): boolean {
  return live !== undefined && live.shell && nowMs - live.startedAt > thresholdMs;
}

const argumentKeys = ['filePath', 'path', 'pattern', 'command', 'url', 'query', 'description'];

/** Short one-line description of a call: `read src/app.ts`, `bash bun test`, `lotus: get_issue`. */
export function describeTool(tool: ToolCall, mcpServers: readonly string[] = []): string {
  const identity = toolIdentity(tool.name, mcpServers);
  const name = identity.kind === 'mcp' ? `${identity.server}: ${identity.tool}` : tool.name;
  for (const key of argumentKeys) {
    const value = tool.input[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const firstLine = value.split('\n')[0] ?? value;
      return `${name} ${firstLine}`;
    }
  }
  return name;
}

/** Nodes rendered per step; older ones stay folded behind "earlier messages" until paged to. */
export const transcriptWindowStep = 200;

/**
 * Keeps the newest `limit` nodes. Rendering cost then tracks the window, not the
 * session length; `hidden` drives the "earlier messages" marker.
 */
export function windowNodes<T>(
  nodes: readonly T[],
  limit: number,
): { visible: readonly T[]; hidden: number } {
  if (nodes.length <= limit) return { visible: nodes, hidden: 0 };
  return { visible: nodes.slice(nodes.length - limit), hidden: nodes.length - limit };
}

/**
 * A bounded reading window over loaded folded nodes. `mode: 'tail'` follows live output;
 * `mode: 'history'` keeps the same-capacity window anchored to `anchorKey`, so new tail
 * activity cannot replace the rows the reader is looking at. `start` is a cached positional
 * hint; `anchorKey` is the semantic source of truth and is re-resolved when history is
 * prepended or the projection changes (#355 repair, slow.txt task 2).
 */
export interface TranscriptViewport {
  readonly mode: 'tail' | 'history';
  readonly anchorKey: string | undefined;
  readonly start: number;
  readonly capacity: number;
}

/** Fresh tail viewport. Capacity never grows, no matter how far the reader travels. */
export function tailViewport(capacity: number = transcriptWindowStep): TranscriptViewport {
  return { mode: 'tail', anchorKey: undefined, start: 0, capacity: Math.max(1, capacity) };
}

/**
 * Re-resolves a history anchor when a prepend or projection change moved it. Only the
 * neighbourhood of the cached index is searched; the window is bounded, so the search is
 * bounded too. Missing anchors fall back to a clamped index rather than mounting history.
 */
function resolveViewportStart(view: TranscriptNodeView, viewport: TranscriptViewport): number {
  if (viewport.mode === 'tail') return Math.max(0, view.length - viewport.capacity);
  const capacity = Math.max(1, viewport.capacity);
  const upper = Math.max(0, view.length - capacity);
  const hint = Math.max(0, Math.min(upper, viewport.start));
  if (view.at(hint)?.key === viewport.anchorKey) return hint;
  if (viewport.anchorKey === undefined) return hint;
  const radius = capacity;
  for (let delta = 1; delta <= radius; delta += 1) {
    if (view.at(hint + delta)?.key === viewport.anchorKey) return hint + delta;
    if (hint - delta >= 0 && view.at(hint - delta)?.key === viewport.anchorKey) return hint - delta;
  }
  return hint;
}

/** Resolves a bounded viewport against the current folded-node view. */
export function viewportNodeView(
  view: TranscriptNodeView,
  viewport: TranscriptViewport,
): {
  visible: readonly TranscriptNode[];
  hidden: number;
  hiddenAfter: number;
  total: number;
  start: number;
} {
  const capacity = Math.max(1, viewport.capacity);
  const start = resolveViewportStart(view, viewport);
  const end = Math.min(view.length, start + capacity);
  const visible = view.range(start, end);
  return {
    visible,
    hidden: start,
    hiddenAfter: view.length - end,
    total: view.length,
    start,
  };
}

/** Tail-relative compatibility wrapper: `windowNodeView` still means "newest `limit` nodes". */
export function windowNodeView(
  view: TranscriptNodeView,
  limit: number,
): { visible: readonly TranscriptNode[]; hidden: number; total: number } {
  const windowed = viewportNodeView(view, tailViewport(limit));
  return { visible: windowed.visible, hidden: windowed.hidden, total: windowed.total };
}

/** `14:03:07 · 1.2s` for detailed tool rows; duration omitted while running. */
export function formatToolTiming(tool: ToolCall, formatClock: (at: number) => string): string {
  const started = formatClock(tool.startedAt);
  if (tool.completedAt === undefined) return started;
  const seconds = Math.max(0, tool.completedAt - tool.startedAt) / 1000;
  return `${started} · ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString()}s`;
}

export type PreviewKind = 'output' | 'shell' | 'diff' | 'code' | 'reasoning';

/** Process-wide detail budget, set once from config at startup (default 12 rows). */
let configuredPreviewRows = 12;

export function configurePreviewRows(rows: number): void {
  configuredPreviewRows = rows;
}

/**
 * Inline display rows per kind. Detailed mode is materially more generous than compact,
 * but both are bounded; the inspector is the route to full retained content (#219).
 */
export const previewBudgets: Readonly<
  Record<'compact' | 'detailed', Readonly<Record<PreviewKind, number>>>
> = {
  compact: { output: 12, shell: 20, diff: 16, code: 12, reasoning: 12 },
  detailed: { output: 48, shell: 60, diff: 64, code: 44, reasoning: 80 },
};

/** Hard ceiling for one inline item even when the user expands it. */
export const maxInlinePreviewRows = 100;

/**
 * `baseRows` is the compact output budget (12 by default); every other budget scales from
 * it, so one setting tunes detail without changing the shipped proportions.
 */
function scaleBudget(rows: number, baseRows: number): number {
  return Math.max(1, Math.min(maxInlinePreviewRows, Math.round((rows * baseRows) / 12)));
}

export function previewBudget(
  kind: PreviewKind,
  detailed: boolean,
  expanded = false,
  baseRows = configuredPreviewRows,
): number {
  if (expanded) return maxInlinePreviewRows;
  return scaleBudget(previewBudgets[detailed ? 'detailed' : 'compact'][kind] ?? 12, baseRows);
}

/**
 * Width-aware row budget: wrapped lines count as multiple rendered rows. Returns the text
 * that fits and how many rendered rows remain hidden. Never claims the source was
 * truncated; this is display clipping only.
 */
export function boundedPreview(
  text: string,
  maxRows: number,
  width: number,
): { text: string; hiddenRows: number } {
  const safeWidth = Math.max(1, width);
  const budget = Math.max(0, maxRows);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const shown: string[] = [];
  let rows = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const total = lineRows(line, safeWidth);
    if (rows + total <= budget) {
      shown.push(line);
      rows += total;
      continue;
    }
    const remaining = budget - rows;
    let hidden = 0;
    if (remaining > 0) {
      // An overlong first line is clipped to the remaining physical-row budget instead of
      // being shown whole: one minified payload must never cost thousands of rows (#228).
      const clipped = clipLineToCells(line, remaining * safeWidth);
      shown.push(clipped.text);
      hidden += Math.max(0, total - lineRows(clipped.text, safeWidth));
    } else {
      hidden += total;
    }
    for (let rest = index + 1; rest < lines.length; rest += 1) {
      hidden += lineRows(lines[rest] ?? '', safeWidth);
    }
    return { text: shown.join('\n'), hiddenRows: hidden };
  }
  return { text: shown.join('\n'), hiddenRows: 0 };
}

/** A short semantic label for a tool result; never inferred from a line's wording. */
export function semanticResultKind(tool: ToolCall): 'shell' | 'code' | 'json' | 'text' {
  const category = classifyTool(tool.name);
  if (category === 'code') return 'code';
  if (category === 'shell') return 'shell';
  if (tool.output !== undefined) {
    const trimmed = tool.output.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      return 'json';
    }
  }
  return 'text';
}

/**
 * Pretty-printed JSON for a preview, or `undefined` when the text is not valid JSON.
 * The original text stays authoritative and untouched for the inspector (#220).
 */
export function prettyJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    return JSON.stringify(parsed, undefined, 2);
  } catch {
    return undefined;
  }
}

/**
 * Which display budget a result uses. JSON stays in the ordinary output class; the
 * difference is presentation (pretty-printed), not row count (#220).
 */
export function semanticPreviewKind(tool: ToolCall): PreviewKind {
  const kind = semanticResultKind(tool);
  if (kind === 'shell') return 'shell';
  if (kind === 'code') return 'code';
  return 'output';
}

/** The text and budget kind to show for a result preview; never mutates the source. */
export function semanticPreview(tool: ToolCall): { text: string; kind: PreviewKind } {
  const text = tool.output ?? '';
  if (semanticResultKind(tool) === 'json') {
    return { text: prettyJson(text) ?? text, kind: 'output' };
  }
  return { text, kind: semanticPreviewKind(tool) };
}

/**
 * Tail-biased bound for diagnostics: keeps the last rows where an error usually is.
 * `hiddenRows` counts rows above the retained tail, not source truncation.
 */
export function boundedTailPreview(
  text: string,
  maxRows: number,
  width: number,
): { text: string; hiddenRows: number } {
  const safeWidth = Math.max(1, width);
  const budget = Math.max(0, maxRows);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const shown: string[] = [];
  let rows = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    const total = lineRows(line, safeWidth);
    if (rows + total <= budget) {
      shown.push(line);
      rows += total;
      continue;
    }
    let hidden = 0;
    for (let head = 0; head < index; head += 1) {
      hidden += lineRows(lines[head] ?? '', safeWidth);
    }
    if (shown.length === 0 && budget > 0) {
      // The diagnosis itself is one huge physical row: keep its tail, not the whole line.
      const clipped = clipLineTailToCells(line, budget * safeWidth);
      shown.push(clipped.text);
      hidden += Math.max(0, total - lineRows(clipped.text, safeWidth));
    } else {
      hidden += total;
    }
    return { text: shown.toReversed().join('\n'), hiddenRows: hidden };
  }
  return { text: shown.toReversed().join('\n'), hiddenRows: 0 };
}
