import type { TranscriptMessage } from './transcript.ts';

/**
 * One complete agent response: the assistant's public text across a single execution.
 * An execution can span several assistant messages and tool calls; steering prompts in
 * the middle do not divide it. Only the server's own `idle` record closes an execution.
 */
export type CompletedResponse = Readonly<{
  /** Stable identity of the execution: the message that grounded its start. */
  id: string;
  /** Assistant Markdown in transcript order; reasoning and tool payloads are excluded. */
  text: string;
  /** The server-confirmed end of the execution. */
  completedAt: number;
  /** The prompt (or shell command) that opened the execution, when it is loaded. */
  prompt?: string;
}>;

export type LastCompleteResponse =
  | Readonly<{
      ok: true;
      response: CompletedResponse;
      /** A later execution has not completed; the previous response was copied. */
      incompleteTail: boolean;
    }>
  | Readonly<{ ok: false; reason: 'none' | 'history-incomplete' }>;

export type CompleteResponseOptions = Readonly<{
  /** The server still holds messages older than the loaded window. */
  historyIncomplete?: boolean;
}>;

type SegmentOutcome = 'succeeded' | 'failed' | 'interrupted';

type Segment = {
  id: string;
  /** The segment began at a message we observed as the execution's start. */
  grounded: boolean;
  prompt?: string;
  texts: string[];
  outcome?: SegmentOutcome;
  completedAt?: number;
};

/**
 * Every provably complete agent response in order.
 *
 * Completeness is deliberately stricter than the display markers: a segment counts only
 * when it began at a user prompt or user shell command in the loaded history AND ended
 * with a succeeded `idle`. `executionMarkers()` also reports a completed phase for an
 * assistant message with a completion timestamp and for any segment that did work; those
 * fallbacks exist so the transcript can draw a marker, not to prove a response is whole.
 */
export function completeResponses(messages: readonly TranscriptMessage[]): CompletedResponse[] {
  return scanSegments(messages)
    .filter((segment) => isComplete(segment))
    .map((segment) => responseOf(segment));
}

/**
 * The newest complete response, skipping an unfinished or failed latest execution. The
 * caller gets the honest reason when the loaded window cannot prove any complete response.
 */
export function lastCompleteResponse(
  messages: readonly TranscriptMessage[],
  options: CompleteResponseOptions = {},
): LastCompleteResponse {
  const segments = scanSegments(messages);
  const complete = segments.filter((segment) => isComplete(segment));
  const chosen = complete.at(-1);
  if (chosen === undefined) {
    return {
      ok: false,
      reason: options.historyIncomplete === true ? 'history-incomplete' : 'none',
    };
  }
  return {
    ok: true,
    response: responseOf(chosen),
    incompleteTail: segments.at(-1)?.id !== chosen.id,
  };
}

function beginSegment(id: string, grounded: boolean, prompt?: string): Segment {
  return {
    id,
    grounded,
    texts: [],
    ...(prompt === undefined ? {} : { prompt }),
  };
}

function scanSegments(messages: readonly TranscriptMessage[]): Segment[] {
  const segments: Segment[] = [];
  let open: Segment | undefined;

  for (const message of messages) {
    switch (message.kind) {
      case 'user':
        // A prompt while an execution is open is steering or a queued follow-up: it stays
        // in the same execution and never becomes its own boundary.
        open ??= beginSegment(message.id, true, message.text);
        break;
      case 'shell':
        open ??= beginSegment(message.id, true, message.command);
        break;
      case 'assistant': {
        open ??= beginSegment(message.id, false);
        for (const part of message.parts) {
          if (part.kind !== 'text') continue;
          if (part.text.trim() === '') continue;
          open.texts.push(part.text);
        }
        break;
      }
      case 'idle':
        if (open === undefined) break;
        open.outcome = message.outcome;
        open.completedAt = message.createdAt;
        segments.push(open);
        open = undefined;
        break;
      case 'compaction':
      case 'agent-switched':
      case 'model-switched':
      case 'note':
        // Decoration never starts an execution and never splits a response.
        break;
      default:
        break;
    }
  }
  // An unclosed execution is a real tail fact even though it can never be a response: the
  // caller must be able to say that a newer run has not completed yet.
  if (open !== undefined) segments.push(open);
  return segments;
}

function isComplete(segment: Segment): boolean {
  return (
    segment.grounded &&
    segment.outcome === 'succeeded' &&
    segment.completedAt !== undefined &&
    segment.texts.length > 0 &&
    joinAssistantText(segment.texts).trim() !== ''
  );
}

function responseOf(segment: Segment): CompletedResponse {
  return {
    id: segment.id,
    text: joinAssistantText(segment.texts),
    completedAt: segment.completedAt ?? 0,
    ...(segment.prompt === undefined ? {} : { prompt: segment.prompt }),
  };
}

/**
 * Joins a segment's assistant messages with the smallest paragraph break, preserving each
 * part's Markdown byte for byte (including indentation and trailing hard-break spaces).
 */
function joinAssistantText(parts: readonly string[]): string {
  let text = '';
  for (const part of parts) {
    if (text === '') {
      text = part;
      continue;
    }
    const separator = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    text += separator + part;
  }
  return text;
}
