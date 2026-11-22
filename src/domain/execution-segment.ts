import { assertNever } from './session.ts';
import { classifyTool, type ToolCategory, type TranscriptMessage } from './transcript.ts';

/**
 * Execution markers: the lifecycle of one agent turn, derived purely from canonical
 * messages. OpenCode appends an `idle` message at the end of every execution (succeeded,
 * failed, interrupted), which includes prompts steered in mid-execution — a segment
 * therefore spans multiple user messages and model steps. An `idle` message ends it;
 * an Assistant completed without an idle is an approved (transient) end; a bare chain of
 * queued user messages that produced no model output produces no marker.
 */

export type ExecutionPhase = 'running' | 'completed' | 'failed' | 'interrupted';

export type ExecutionMarker = Readonly<{
  /** Stable identifier: the first user message of the segment, or the first message seen. */
  id: string;
  /** The marker renders after this message id (the segment's total extent). */
  afterMessageId: string;
  phase: ExecutionPhase;
  startedAt: number;
  completedAt?: number;
  /** Reported wall time the run actually took; never queue dwell. */
  durationMs?: number;
  /** While running: a truthful activity derived from agent state. */
  activity?: string;
}>;

const activityByCategory: Readonly<Record<ToolCategory, string>> = {
  read: 'Reading',
  search: 'Searching',
  edit: 'Editing',
  shell: 'Running',
  code: 'Running script',
  web: 'Fetching',
  delegate: 'Delegating',
  other: 'Working',
};

/** A call that has not settled yet; its status genuinely means "working right now". */
function isToolActive(status: string): boolean {
  return status === 'running' || status === 'streaming';
}

type SegmentAccum = {
  id: string;
  segStartedAt?: number;
  assistantCreated?: number;
  assistantCompleted?: number;
  toolCategory?: ToolCategory;
  /** The most recently seen call, kept so the live activity follows a genuinely running one. */
  lastTool?: { category: ToolCategory; status: string; startedAt: number };
  reasoningOpen: boolean;
  compacting: boolean;
  worked: boolean;
  idle?: { at: number; outcome: 'succeeded' | 'failed' | 'interrupted' };
  lastMessageId: string;
};

function startSegment(message: TranscriptMessage): SegmentAccum {
  return {
    id: message.id,
    segStartedAt: message.createdAt,
    reasoningOpen: false,
    compacting: false,
    worked: false,
    lastMessageId: message.id,
  };
}

/** One marker per segment, in transcript order. Keyed at creation time by nothing but order. */
export function executionMarkers(
  messages: readonly TranscriptMessage[],
  running: boolean,
): ExecutionMarker[] {
  const markers: ExecutionMarker[] = [];
  let accum: SegmentAccum | undefined;

  const closeSegment = (isLast: boolean) => {
    if (accum === undefined) return;
    const marker = markerFrom(accum, isLast && running);
    if (marker !== undefined) markers.push(marker);
    accum = undefined;
  };

  for (const message of messages) {
    switch (message.kind) {
      case 'user':
        if (accum === undefined) accum = startSegment(message);
        accum.lastMessageId = message.id;
        break;
      case 'shell':
        if (accum === undefined) accum = startSegment(message);
        accum.lastMessageId = message.id;
        accum.toolCategory = 'shell';
        accum.lastTool = {
          category: 'shell',
          status: message.status,
          startedAt: message.createdAt,
        };
        accum.worked = true;
        break;
      case 'assistant': {
        if (accum === undefined) accum = startSegment(message);
        accum.lastMessageId = message.id;
        accum.assistantCreated ??= message.createdAt;
        if (message.completedAt !== undefined) accum.assistantCompleted = message.completedAt;
        accum.worked = true;
        // Model output after a compaction means the compaction is over.
        accum.compacting = false;
        for (const part of message.parts) {
          if (part.kind === 'tool') {
            accum.toolCategory = classifyTool(part.tool.name);
            accum.lastTool = {
              category: accum.toolCategory,
              status: part.tool.status,
              startedAt: part.tool.startedAt,
            };
            accum.reasoningOpen = false;
          } else if (part.kind === 'reasoning') {
            accum.reasoningOpen = !part.done;
          }
        }
        break;
      }
      case 'compaction':
        if (accum === undefined) accum = startSegment(message);
        accum.lastMessageId = message.id;
        // Each compaction record replaces the previous status: completed/failed ends it.
        accum.compacting = message.state === 'running';
        accum.worked = true;
        break;
      case 'idle':
        if (accum === undefined) accum = startSegment(message);
        accum.idle = { at: message.createdAt, outcome: message.outcome };
        accum.lastMessageId = message.id;
        closeSegment(false);
        break;
      case 'agent-switched':
      case 'model-switched':
      case 'note':
        if (accum !== undefined) accum.lastMessageId = message.id;
        break;
      default:
        assertNever(message);
    }
  }
  if (accum !== undefined) closeSegment(true);
  return markers;
}

function markerFrom(accum: SegmentAccum, isRunning: boolean): ExecutionMarker | undefined {
  const startedAt = accum.assistantCreated ?? accum.segStartedAt;
  if (accum.idle !== undefined) {
    const outcome = accum.idle.outcome;
    return {
      id: accum.id,
      afterMessageId: accum.lastMessageId,
      phase: outcome === 'succeeded' ? 'completed' : outcome,
      ...(startedAt === undefined ? { startedAt: accum.idle.at } : { startedAt }),
      completedAt: accum.idle.at,
      ...(startedAt === undefined ? {} : { durationMs: Math.max(0, accum.idle.at - startedAt) }),
    };
  }
  if (isRunning) {
    let activity: string | undefined;
    if (accum.compacting) activity = 'Compacting conversation';
    // A finished call must not keep labelling the turn: only a genuinely running tool
    // names the phase, otherwise the throbber's own verb stands in (issue #75).
    else if (accum.lastTool !== undefined && isToolActive(accum.lastTool.status))
      activity = activityByCategory[accum.lastTool.category];
    else if (accum.reasoningOpen) activity = 'Thinking';
    return {
      id: accum.id,
      afterMessageId: accum.lastMessageId,
      phase: 'running',
      startedAt: startedAt ?? 0,
      ...(activity === undefined ? {} : { activity }),
    };
  }
  if (accum.assistantCompleted !== undefined) {
    const started = accum.assistantCreated ?? startedAt ?? accum.assistantCompleted;
    return {
      id: accum.id,
      afterMessageId: accum.lastMessageId,
      phase: 'completed',
      startedAt: started,
      completedAt: accum.assistantCompleted,
      durationMs: Math.max(0, accum.assistantCompleted - started),
    };
  }
  if (accum.worked) {
    const fallback = startedAt ?? 0;
    return {
      id: accum.id,
      afterMessageId: accum.lastMessageId,
      phase: 'completed',
      startedAt: fallback,
    };
  }
  // Bare queued user message that never produced model output: no marker.
  return undefined;
}
