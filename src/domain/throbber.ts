import { classifyTool, type ToolCategory, type TranscriptMessage } from './transcript.ts';

/** Inline activity indicator for the active assistant turn (docs/21-throbber.md). */
export const orbitFrames = ['◜', '◝', '◞', '◟'] as const;
export const asciiFrames = ['-', '\\', '|', '/'] as const;
export const frameIntervalMs = 150;
export const shimmerPeriodMs = 1800;
const verbRotationMs = 20_000;

const decorativeVerbs = [
  'Thinking',
  'Tinkering',
  'Pondering',
  'Untangling',
  'Mulling',
  'Noodling',
] as const;

export type ThrobberPhase = 'running' | 'completed' | 'interrupted' | 'failed';

export type ThrobberFacts = Readonly<{
  phase: ThrobberPhase;
  startedAt: number;
  completedAt?: number;
  /** Reported output tokens only; undefined when the server has not reported usage yet. */
  outputTokens?: number;
  /** A label derived from real agent state (e.g. the running tool category), if known. */
  activity?: string;
}>;

export function frameAt(elapsedMs: number, ascii: boolean): string {
  const frames = ascii ? asciiFrames : orbitFrames;
  const index = Math.floor(Math.max(0, elapsedMs) / frameIntervalMs) % frames.length;
  return frames[index] ?? frames[0];
}

/** Stable per-turn verb that rotates slowly; never claims a specific operation. */
export function verbAt(seed: number, elapsedMs: number): string {
  const step = Math.floor(Math.max(0, elapsedMs) / verbRotationMs);
  const index = Math.abs(seed + step) % decorativeVerbs.length;
  return decorativeVerbs[index] ?? 'Thinking';
}

/** Highlight intensity in [0,1] for each character of `length`, given time in the shimmer cycle. */
export function shimmerWeights(length: number, nowMs: number): number[] {
  if (length <= 0) return [];
  const span = length + 6;
  const head = ((nowMs % shimmerPeriodMs) / shimmerPeriodMs) * span - 3;
  return Array.from({ length }, (_, index) => Math.max(0, 1 - Math.abs(index - head) / 3));
}

/** One decimal for the indicator: `63.6k`, `1.2M`, `950`. */
export function compactTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${trimZero((count / 1000).toFixed(1))}k`;
  return `${trimZero((count / 1_000_000).toFixed(1))}M`;
}

function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export type ThrobberLine = Readonly<{
  /** Text that receives the shimmer, e.g. `Thinking…`. Empty for completed turns. */
  label: string;
  /** Dimmed, static metadata. */
  meta: string;
  animated: boolean;
}>;

/** Text content of the indicator; the view adds glyph and colour. Shortens for narrow widths. */
export function describeThrobber(
  facts: ThrobberFacts,
  now: number,
  width: number,
  formatTime: (at: number) => string,
): ThrobberLine {
  const tokens =
    facts.outputTokens === undefined ? undefined : `${compactTokens(facts.outputTokens)} tokens`;
  if (facts.phase === 'running') {
    const elapsed = now - facts.startedAt;
    const label = `${facts.activity ?? verbAt(facts.startedAt, elapsed)}…`;
    const parts = [formatElapsed(elapsed), ...(tokens === undefined ? [] : [`↓ ${tokens}`])];
    return {
      label,
      meta: fit(label, `(${parts.join(' · ')})`, width, `(${parts[0]})`),
      animated: true,
    };
  }
  const status =
    facts.phase === 'completed'
      ? `Finished at ${formatTime(facts.completedAt ?? now)}`
      : facts.phase === 'interrupted'
        ? 'Interrupted'
        : 'Failed';
  const full = tokens === undefined ? status : `${status} · ${tokens}`;
  return { label: '', meta: fit('', full, width, status), animated: false };
}

function fit(label: string, meta: string, width: number, shorter: string): string {
  // glyph + space + label + space + meta
  if (2 + label.length + 1 + meta.length <= width) return meta;
  if (2 + label.length + 1 + shorter.length <= width) return shorter;
  return '';
}

export const tips = [
  'Press Shift+Tab to switch agents',
  'Press Ctrl+O to show tool details',
  'Press Ctrl+C to interrupt the running turn',
  'Press Alt+Enter to steer instead of queueing',
  'Press F1 for all key bindings',
] as const;

/** At most one tip per turn, shown only on long turns and only on some of them. */
export function tipFor(seed: number, elapsedMs: number): string | undefined {
  if (elapsedMs < 30_000 || seed % 3 !== 0) return undefined;
  return tips[Math.abs(seed) % tips.length];
}

const activityByCategory: Readonly<Record<ToolCategory, string>> = {
  read: 'Reading',
  search: 'Searching',
  edit: 'Editing',
  shell: 'Running',
  web: 'Fetching',
  delegate: 'Delegating',
  other: 'Working',
};

/**
 * Indicator facts for the latest turn, derived only from canonical messages and the
 * server's running flag. Returns undefined when there is no turn to describe.
 */
export function latestTurn(
  messages: readonly TranscriptMessage[],
  running: boolean,
): ThrobberFacts | undefined {
  const userIndex = messages.findLastIndex((message) => message.kind === 'user');
  const user = messages[userIndex];
  if (user === undefined) return undefined;
  const after = messages.slice(userIndex + 1);
  const assistant = after.findLast((message) => message.kind === 'assistant');
  if (running) {
    const lastPart = assistant?.kind === 'assistant' ? assistant.parts.at(-1) : undefined;
    const compacting = after.some(
      (message) => message.kind === 'compaction' && message.state === 'running',
    );
    const activity = compacting
      ? 'Compacting conversation'
      : lastPart?.kind === 'tool' && lastPart.tool.status !== 'completed'
        ? activityByCategory[classifyTool(lastPart.tool.name)]
        : lastPart?.kind === 'reasoning' && !lastPart.done
          ? 'Thinking'
          : undefined;
    return {
      phase: 'running',
      startedAt: user.createdAt,
      ...(activity === undefined ? {} : { activity }),
    };
  }
  const idle = after.findLast((message) => message.kind === 'idle');
  if (idle === undefined && assistant === undefined) return undefined;
  const failed =
    (idle?.kind === 'idle' && idle.outcome === 'failed') ||
    (assistant?.kind === 'assistant' && assistant.error !== undefined);
  const phase: ThrobberPhase =
    idle?.kind === 'idle' && idle.outcome === 'interrupted'
      ? 'interrupted'
      : failed
        ? 'failed'
        : 'completed';
  const completedAt =
    idle?.createdAt ?? (assistant?.kind === 'assistant' ? assistant.completedAt : undefined);
  return {
    phase,
    startedAt: user.createdAt,
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}
