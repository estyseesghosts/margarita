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
  | { kind: 'meta'; key: string; text: string };

export type FoldOptions = Readonly<{
  detailed: boolean;
  /** Group keys the user expanded individually; see `groupKey`. */
  expandedGroups: ReadonlySet<string>;
  /** Tool IDs whose oversized inline diff the user expanded; see `clampDiffPatch`. */
  expandedDiffs?: ReadonlySet<string>;
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
};

export function classifyTool(name: string): ToolCategory {
  return categoryByName[name.toLowerCase()] ?? 'other';
}

/** Only quiet, inspection-style tools are folded; anything mutating stays visible. */
function isFoldable(tool: ToolCall): boolean {
  if (tool.status === 'error') return false;
  const category = classifyTool(tool.name);
  return category === 'read' || category === 'search' || category === 'web' || category === 'shell';
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
    switch (message.kind) {
      case 'user':
        out.push({
          kind: 'user',
          key: message.id,
          text: message.text,
          attachments: message.attachments,
        });
        break;
      case 'assistant':
        foldAssistant(message, options, out);
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
        summary: summarizeTools(tools),
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
): void {
  let pending: ToolCall[] = [];
  let sawReasoningText = false;
  const flush = () => {
    if (pending.length === 0) return;
    if (options.detailed) {
      for (const tool of pending) {
        out.push({
          kind: 'tool',
          key: tool.id,
          tool,
          category: classifyTool(tool.name),
          expanded: options.detailed,
        });
      }
    } else {
      const key = groupKey(pending);
      out.push({
        kind: 'tool-group',
        key,
        summary: summarizeTools(pending),
        running: pending.some((tool) => tool.status === 'running' || tool.status === 'streaming'),
        tools: pending,
        expanded: options.expandedGroups.has(key),
      });
    }
    pending = [];
  };
  message.parts.forEach((part, index) => {
    switch (part.kind) {
      case 'tool':
        if (isFoldable(part.tool)) {
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
      case 'text':
        if (part.text.trim() === '') return;
        flush();
        out.push({ kind: 'text', key: `${message.id}:${index}`, text: part.text });
        return;
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

/** `Read 3 files, searched for 2 patterns, ran 1 shell command`, derived from data only. */
export function summarizeTools(tools: readonly ToolCall[]): string {
  const counts = new Map<ToolCategory, number>();
  for (const tool of tools) {
    const category = classifyTool(tool.name);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count], index) => {
      const phrase = verbs[category](count);
      return index === 0 ? phrase : phrase.charAt(0).toLowerCase() + phrase.slice(1);
    })
    .join(', ');
}

const argumentKeys = ['filePath', 'path', 'pattern', 'command', 'url', 'query', 'description'];

/** Short one-line description of a call: `read src/app.ts`, `bash bun test`. */
export function describeTool(tool: ToolCall): string {
  for (const key of argumentKeys) {
    const value = tool.input[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const firstLine = value.split('\n')[0] ?? value;
      return `${tool.name} ${firstLine}`;
    }
  }
  return tool.name;
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
