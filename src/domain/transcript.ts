import type { ExecutionMarker } from './execution-segment.ts';
import type { ModelSelection } from './model-ref.ts';
import { assertNever } from './session.ts';

/** Frontend projection of server messages; adapters map wire types into these. */
export type ToolStatus = 'streaming' | 'running' | 'completed' | 'error';

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
  error?: string;
  startedAt: number;
  completedAt?: number;
}>;

export type AssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string; done: boolean }
  | { kind: 'tool'; tool: ToolCall };

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
      error?: string;
    }
  | {
      kind: 'shell';
      id: string;
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

export type ToolCategory = 'read' | 'search' | 'edit' | 'shell' | 'web' | 'delegate' | 'other';

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
  | { kind: 'tool'; key: string; tool: ToolCall; category: ToolCategory; expanded: boolean }
  | {
      kind: 'tool-group';
      key: string;
      summary: string;
      running: boolean;
      tools: readonly ToolCall[];
      expanded: boolean;
    }
  | {
      kind: 'shell';
      key: string;
      command: string;
      status: string;
      exitCode?: number;
      output?: string;
      outputTruncated?: 'server';
    }
  | { kind: 'notice'; key: string; text: string; tone: 'dim' | 'error' | 'warn' }
  | { kind: 'meta'; key: string; text: string }
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
  execute: 'shell',
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
    .map((server) => ({ server, prefix: `${mcpNamespace(server)}_` }))
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
  if (tool.status === 'error') return false;
  if (builtinCategories.has(tool.name.toLowerCase())) {
    const category = classifyTool(tool.name);
    return (
      category === 'read' ||
      category === 'search' ||
      category === 'web' ||
      category === 'shell' ||
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
  // Brief progress notes fold into the activity group across a working run; the last
  // assistant message of each user turn carries that turn's answer, so its text never folds
  // away. A turn ends at the next user message (the server writes one idle marker per run,
  // so idle markers cannot delimit turns).
  const answerMessages = new Set<TranscriptMessage>();
  let turnAnswer: TranscriptMessage | undefined;
  for (const message of messages) {
    if (message.kind === 'user') {
      if (turnAnswer !== undefined) answerMessages.add(turnAnswer);
      turnAnswer = undefined;
    } else if (message.kind === 'assistant') {
      turnAnswer = message;
    }
  }
  if (turnAnswer !== undefined) answerMessages.add(turnAnswer);
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
        foldAssistant(message, options, out, answerMessages.has(message));
        break;
      case 'shell':
        out.push({
          kind: 'shell',
          key: message.id,
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
  return options.detailed ? out : mergeAdjacentGroups(out, options);
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
      merged.push({
        kind: 'tool-group',
        key,
        summary: summarizeTools(tools, options.mcpServers),
        running: run.some((group) => group.running),
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
  /** The newest assistant message's prose is the user-visible answer; never folded away. */
  keepsText: boolean,
): void {
  let pending: ToolCall[] = [];
  let sawReasoningText = false;
  const emitTool = (tool: ToolCall) => {
    out.push({
      kind: 'tool',
      key: tool.id,
      tool,
      category: classifyTool(tool.name),
      expanded:
        options.detailed || tool.status === 'error' || options.expandedDiffs?.has(tool.id) === true,
    });
  };
  const emitGroup = (tools: ToolCall[]) => {
    const key = groupKey(tools);
    out.push({
      kind: 'tool-group',
      key,
      summary: summarizeTools(tools, options.mcpServers),
      running: tools.some((tool) => tool.status === 'running' || tool.status === 'streaming'),
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
          expanded:
            options.detailed ||
            part.tool.status === 'error' ||
            options.expandedDiffs?.has(part.tool.id) === true,
        });
        return;
      case 'text': {
        const trimmed = part.text.trim();
        if (trimmed === '') return;
        // Brief progress notes interleaved with tool activity fold into the group; the
        // latest assistant message keeps its prose so the final reply never disappears.
        if (!options.detailed && !keepsText && trimmed.length <= 80 && !trimmed.includes('\n')) {
          return;
        }
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
  web: (count) => `Fetched ${count} ${count === 1 ? 'page' : 'pages'}`,
  delegate: (count) => `Delegated ${count} ${count === 1 ? 'task' : 'tasks'}`,
  other: (count) => `Ran ${count} other ${count === 1 ? 'tool' : 'tools'}`,
};

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
  for (const tool of tools) {
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
