import type { ExecutionMarker } from './execution-segment.ts';
import type { ModelSelection } from './model-ref.ts';
import { sanitizeTerminalText } from './sanitize-text.ts';
import { assertNever, type TokenUsage } from './session.ts';
import { truncatePrompt } from './sticky-prompt.ts';
import { clipLineTailToCells, clipLineToCells, lineRows } from './text-width.ts';
import type { WorkerJob } from './worker.ts';

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
  completeness: SourceCompleteness;
}>;

/** What the bounded transcript cache can offer when retrieval is unavailable. */
export function cachedToolResult(tool: ToolCall): ToolResultPayload {
  return {
    ...(tool.output === undefined ? {} : { text: tool.output }),
    ...(tool.diff === undefined ? {} : { diff: tool.diff }),
    files: tool.files ?? [],
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
      return 'complete';
    case 'frontend-elided':
      return 'preview only — the middle was elided by this client';
    case 'server-truncated':
      return 'truncated by the server';
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

export type ToolCategory =
  'read' | 'search' | 'edit' | 'shell' | 'code' | 'web' | 'delegate' | 'other';

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

export type FoldOptions = Readonly<{
  detailed: boolean;
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
}>;

const categoryByName: Readonly<Record<string, ToolCategory>> = {
  read: 'read',
  view: 'read',
  list: 'search',
  ls: 'search',
  glob: 'search',
  grep: 'search',
  search: 'search',
  codesearch: 'search',
  edit: 'edit',
  write: 'edit',
  patch: 'edit',
  apply_patch: 'edit',
  multiedit: 'edit',
  bash: 'shell',
  shell: 'shell',
  // Code Mode is a script host, not a shell; nested calls carry the real activity (#217).
  execute: 'code',
  webfetch: 'web',
  websearch: 'web',
  fetch: 'web',
  task: 'delegate',
  agent: 'delegate',
  subagent: 'delegate',
};

const builtinCategories = new Set(Object.keys(categoryByName));

/**
 * What one call is. Built-ins are matched by name. OpenCode v2 registers MCP tools as
 * `<normalizedName(server)>_<normalizedName(tool)>`, so a configured server's flattened
 * prefix recovers the server; a call matching no configured server stays honestly
 * external instead of being attributed to one (issue #74).
 */
export type ToolIdentity =
  | Readonly<{ kind: 'builtin'; category: ToolCategory }>
  | Readonly<{ kind: 'mcp'; server: string; tool: string }>
  | Readonly<{ kind: 'external' }>;

/** The flattened registry namespace for an MCP server name (upstream `normalizedName`). */
export function mcpNamespace(server: string): string {
  return server.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** The longest matching configured server prefix wins; servers `a` and `a_b` stay distinct. */
export function toolIdentity(name: string, mcpServers: readonly string[] = []): ToolIdentity {
  const builtin = categoryByName[name.toLowerCase()];
  if (builtin !== undefined) return { kind: 'builtin', category: builtin };
  const matched = mcpServers
    .flatMap((server) => {
      const namespace = mcpNamespace(server);
      return [
        { server, prefix: `${namespace}_` },
        // Code Mode reports nested calls with a qualified `<server>.<tool>` name.
        { server, prefix: `${namespace}.` },
      ];
    })
    .filter((entry) => entry.prefix.length > 1 && name.startsWith(entry.prefix))
    .toSorted((left, right) => right.prefix.length - left.prefix.length)[0];
  if (matched === undefined) return { kind: 'external' };
  return { kind: 'mcp', server: matched.server, tool: name.slice(matched.prefix.length) };
}

export function classifyTool(name: string): ToolCategory {
  return categoryByName[name.toLowerCase()] ?? 'other';
}

/**
 * Every call that visibly happened folds into the activity group, MCP calls included. A
 * call to a server that is not configured still folds, so its summary can say it was an
 * external tool. Anything mutating the user's focus (failures) never folds, so a failed
 * MCP call keeps its error visible (issue #74).
 */
function isFoldable(tool: ToolCall, mcpServers: readonly string[]): boolean {
  if (tool.status === 'error' || tool.executionError !== undefined) return false;
  if (tool.children?.some((child) => child.status === 'error') === true) return false;
  if (builtinCategories.has(tool.name.toLowerCase())) {
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
  /**
   * Every canonical assistant text part is user-visible prose. Whether text matters is not
   * decidable from its length, newline count, or whether a later step was appended (issue
   * #167): short status notes, warnings and intermediate results are all meaningful. The
   * fold therefore never discards canonical text — only repetitive tool calls collapse.
   * Tools still group, reasoning stays hidden in compact mode, and chronology is preserved.
   */
  /** Emits the marker for the message just appended, if the segment boundary falls there. */
  function appendBoundaryMarker(messageId: string) {
    const marker = options.markers?.get(messageId);
    if (marker !== undefined) {
      out.push({
        kind: 'execution',
        key: `seg:${marker.id}`,
        segment: marker,
      });
    }
  }

  for (const message of messages) {
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
        out.push({ kind: 'meta', key: message.id, text: `agent → ${message.agent}` });
        break;
      case 'model-switched':
        out.push({
          kind: 'meta',
          key: message.id,
          text: `model → ${message.model.modelID}${message.model.variant === undefined ? '' : ` · ${message.model.variant}`}`,
        });
        break;
      case 'idle':
        if (message.outcome === 'failed') {
          out.push({
            kind: 'notice',
            key: message.id,
            text: `Run failed${message.error === undefined ? '' : `: ${message.error}`}`,
            tone: 'error',
          });
        } else if (message.outcome === 'interrupted') {
          out.push({ kind: 'notice', key: message.id, text: 'Interrupted', tone: 'warn' });
        }
        break;
      case 'compaction':
        // A running compaction is the throbber's job ("Compacting conversation…");
        // only the terminal states earn a one-off transcript notice.
        if (message.state === 'running') break;
        out.push({
          kind: 'notice',
          key: message.id,
          text: message.state === 'failed' ? 'Compaction failed' : 'Conversation compacted',
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
    appendBoundaryMarker(message.id);
  }
  const consolidated = consolidateInterruptions(out);
  return options.detailed ? consolidated : mergeAdjacentGroups(consolidated, options);
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
  const consolidated: TranscriptNode[] = [];
  let segment: TranscriptNode[] = [];
  const flush = (interrupted: boolean) => {
    for (const node of segment) {
      if (!interrupted) {
        consolidated.push(node);
        continue;
      }
      if (node.kind === 'notice' && isInterruptionBanner(node.text)) continue;
      if (node.kind === 'text' && isInterruptionBanner(node.text)) continue;
      consolidated.push(node);
    }
    segment = [];
  };
  for (const node of nodes) {
    if (node.kind === 'execution') {
      flush(node.segment.phase === 'interrupted');
      consolidated.push(node);
    } else {
      segment.push(node);
    }
  }
  flush(false);
  return consolidated;
}

type GroupNode = Extract<TranscriptNode, { kind: 'tool-group' }>;

/** Calls split across assistant messages still read as one uninterrupted activity segment. */
function mergeAdjacentGroups(nodes: TranscriptNode[], options: FoldOptions): TranscriptNode[] {
  const merged: TranscriptNode[] = [];
  let run: GroupNode[] = [];
  const flush = () => {
    const first = run[0];
    if (first === undefined) return;
    if (run.length === 1) {
      merged.push(first);
    } else {
      const tools = run.flatMap((group) => group.tools);
      const key = groupKey(tools);
      const live = liveToolLine(tools, options.mcpServers);
      merged.push({
        kind: 'tool-group',
        key,
        summary: summarizeTools(tools, options.mcpServers),
        running: run.some((group) => group.running),
        ...(live === undefined ? {} : { live }),
        tools,
        expanded: run.some((group) => group.expanded) || options.expandedGroups.has(key),
      });
    }
    run = [];
  };
  for (const node of nodes) {
    if (node.kind === 'tool-group') {
      run.push(node);
    } else {
      flush();
      merged.push(node);
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
        // authentic reasoning text, and only in detailed mode.
        if (options.detailed && part.text.trim() !== '') {
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
    options.detailed &&
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

const verbs: Readonly<Record<ToolCategory, (count: number) => string>> = {
  read: (count) => `Read ${count} ${count === 1 ? 'file' : 'files'}`,
  search: (count) => `Searched for ${count} ${count === 1 ? 'pattern' : 'patterns'}`,
  edit: (count) => `Edited ${count} ${count === 1 ? 'file' : 'files'}`,
  shell: (count) => `Ran ${count} shell ${count === 1 ? 'command' : 'commands'}`,
  code: (count) => `Ran ${count} code ${count === 1 ? 'script' : 'scripts'}`,
  web: (count) => `Fetched ${count} ${count === 1 ? 'page' : 'pages'}`,
  delegate: (count) => `Delegated ${count} ${count === 1 ? 'task' : 'tasks'}`,
  other: (count) => `Ran ${count} other ${count === 1 ? 'tool' : 'tools'}`,
};

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
  const times = `${count} ${count === 1 ? 'time' : 'times'}`;
  // A known server keeps its name; unknown external tools are never attributed to one.
  if (server === undefined) return `Called ${count} external ${count === 1 ? 'tool' : 'tools'}`;
  return `Called ${server} ${times}`;
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

const activityLabels: Readonly<Record<ToolCategory, string>> = {
  read: 'Reading',
  search: 'Searching',
  edit: 'Editing',
  shell: 'Running',
  code: 'Running script',
  web: 'Fetching',
  delegate: 'Delegating',
  other: 'Working',
};

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
  const verb = activityLabels[category];
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

/** `14:03:07 · 1.2s` for detailed tool rows; duration omitted while running. */
export function formatToolTiming(tool: ToolCall, formatClock: (at: number) => string): string {
  const started = formatClock(tool.startedAt);
  if (tool.completedAt === undefined) return started;
  const seconds = Math.max(0, tool.completedAt - tool.startedAt) / 1000;
  return `${started} · ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString()}s`;
}

export type PreviewKind = 'output' | 'shell' | 'diff' | 'code' | 'reasoning';

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

export function previewBudget(kind: PreviewKind, detailed: boolean, expanded = false): number {
  if (expanded) return maxInlinePreviewRows;
  return previewBudgets[detailed ? 'detailed' : 'compact'][kind];
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
