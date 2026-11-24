import type { ExecutionMarker } from './execution-segment.ts';
import { executionMarkers } from './execution-segment.ts';
import type { TranscriptMessage } from './transcript.ts';

/**
 * Incremental execution-marker derivation (#349).
 *
 * Canonical transcripts are append-mostly: a streamed delta replaces the open turn, and an
 * older-page load prepends history. Closed segments (ended by an `idle` message) are immutable
 * derivations, so only the segment at or after the first changed message needs to be rescanned.
 * The pure `executionMarkers()` remains the correctness reference and is used for a full reset.
 *
 * The caller owns one projector per transcript and supplies an explicit change boundary; it
 * must not share an instance across sessions.
 */

export type MarkerChange =
  /** Unknown/external replacement: rescan the whole transcript. */
  | Readonly<{ kind: 'reset' }>
  /** Only `running` changed; the open tail may appear/disappear. */
  | Readonly<{ kind: 'tail' }>
  /** Canonical messages before `firstChangedIndex` are unchanged object identities. */
  | Readonly<{ kind: 'replace'; firstChangedIndex: number }>
  /** `prependCount` older messages were inserted; the previous array is now a suffix. */
  | Readonly<{ kind: 'prepend'; prependCount: number }>;

export type MarkerProjectionStats = Readonly<{
  /** Messages fed to the pure derivation for this projection. */
  messagesScanned: number;
  /** Markers rebuilt from those messages. */
  segmentsRescanned: number;
  /** Markers carried over verbatim from the previous projection. */
  segmentsReused: number;
  /** Messages before the rescanned suffix whose derivations were reused. */
  messagesReused: number;
}>;

export type ExecutionMarkerProjection = Readonly<{
  markers: readonly ExecutionMarker[];
  stats: MarkerProjectionStats;
}>;

export interface ExecutionMarkerProjector {
  project(
    messages: readonly TranscriptMessage[],
    running: boolean,
    change: MarkerChange,
  ): ExecutionMarkerProjection;
  lastStats(): MarkerProjectionStats | undefined;
}

function fullProjection(
  messages: readonly TranscriptMessage[],
  running: boolean,
): ExecutionMarkerProjection {
  const markers = executionMarkers(messages, running);
  return {
    markers,
    stats: {
      messagesScanned: messages.length,
      segmentsRescanned: markers.length,
      segmentsReused: 0,
      messagesReused: 0,
    },
  };
}

/** Index of the last `idle` at or before `limit`, or -1. */
function lastIdleAtOrBefore(messages: readonly TranscriptMessage[], limit: number): number {
  for (let index = Math.min(limit, messages.length - 1); index >= 0; index -= 1) {
    if (messages[index]?.kind === 'idle') return index;
  }
  return -1;
}

/** Index of the first `idle` at or after `start`, or -1. */
function firstIdleAtOrAfter(messages: readonly TranscriptMessage[], start: number): number {
  for (let index = Math.max(0, start); index < messages.length; index += 1) {
    if (messages[index]?.kind === 'idle') return index;
  }
  return -1;
}

function indexEnds(
  messages: readonly TranscriptMessage[],
  markers: readonly ExecutionMarker[],
): number[] {
  const ids = new Map(messages.map((message, index) => [message.id, index] as const));
  return markers.map((marker) => ids.get(marker.afterMessageId) ?? -1);
}

/**
 * Creates a stateful projector. `change` must truthfully describe how `messages` differs from
 * the previous call: `replace` may only claim an unchanged prefix when the objects are the same.
 */
export function createExecutionMarkerProjector(): ExecutionMarkerProjector {
  let previousMessages: readonly TranscriptMessage[] = [];
  let previousMarkers: readonly ExecutionMarker[] = [];
  /** Index in `previousMessages` where each marker's segment ends (the `afterMessageId`). */
  let previousEnds: readonly number[] = [];
  let stats: MarkerProjectionStats | undefined;

  function commit(
    messages: readonly TranscriptMessage[],
    markers: readonly ExecutionMarker[],
    ends: readonly number[],
    projectionStats: MarkerProjectionStats,
  ): ExecutionMarkerProjection {
    previousMessages = messages;
    previousMarkers = markers;
    previousEnds = ends;
    stats = projectionStats;
    return { markers, stats: projectionStats };
  }

  function full(
    messages: readonly TranscriptMessage[],
    running: boolean,
  ): ExecutionMarkerProjection {
    const projection = fullProjection(messages, running);
    return commit(
      messages,
      projection.markers,
      indexEnds(messages, projection.markers),
      projection.stats,
    );
  }

  function tail(
    messages: readonly TranscriptMessage[],
    running: boolean,
  ): ExecutionMarkerProjection {
    const closedBoundary = lastIdleAtOrBefore(previousMessages, previousMessages.length - 1) + 1;
    const reusedMarkers: ExecutionMarker[] = [];
    const reusedEnds: number[] = [];
    for (let index = 0; index < previousMarkers.length; index += 1) {
      const marker = previousMarkers[index];
      const end = previousEnds[index];
      if (marker === undefined || end === undefined || end >= closedBoundary) break;
      reusedMarkers.push(marker);
      reusedEnds.push(end);
    }
    const suffix = executionMarkers(messages.slice(closedBoundary), running);
    const markers = [...reusedMarkers, ...suffix];
    const ends = [
      ...reusedEnds,
      ...indexEnds(messages.slice(closedBoundary), suffix).map((end) => end + closedBoundary),
    ];
    return commit(messages, markers, ends, {
      messagesScanned: messages.length - closedBoundary,
      segmentsRescanned: suffix.length,
      segmentsReused: reusedMarkers.length,
      messagesReused: closedBoundary,
    });
  }

  function project(
    messages: readonly TranscriptMessage[],
    running: boolean,
    change: MarkerChange,
  ): ExecutionMarkerProjection {
    if (change.kind === 'reset' || previousMessages.length === 0) return full(messages, running);
    if (change.kind === 'tail') return tail(messages, running);

    if (change.kind === 'prepend') {
      const prependCount = Math.max(0, change.prependCount);
      if (prependCount === 0) return tail(messages, running);
      const junction = firstIdleAtOrAfter(messages, prependCount);
      if (junction < 0) return full(messages, running);

      const prefix = executionMarkers(messages.slice(0, junction + 1), false);
      const reusedMarkers: ExecutionMarker[] = [];
      const reusedEnds: number[] = [];
      for (let index = 0; index < previousMarkers.length; index += 1) {
        const marker = previousMarkers[index];
        const end = previousEnds[index];
        if (marker === undefined || end === undefined) break;
        const shifted = end + prependCount;
        if (shifted <= junction) continue;
        // The previous open marker's phase/activity belongs to the old `running` value. The
        // caller will re-derive it below with the current value instead of freezing it.
        if (marker.phase === 'running') continue;
        reusedMarkers.push(marker);
        reusedEnds.push(shifted);
      }
      const suffixStart = Math.max(
        junction + 1,
        reusedEnds.length === 0 ? junction + 1 : Math.max(...reusedEnds) + 1,
      );
      const suffix = executionMarkers(messages.slice(suffixStart), running);
      const markers = [...prefix, ...reusedMarkers, ...suffix];
      const ends = [
        ...indexEnds(messages.slice(0, junction + 1), prefix),
        ...reusedEnds,
        ...indexEnds(messages.slice(suffixStart), suffix).map((end) => end + suffixStart),
      ];
      return commit(messages, markers, ends, {
        messagesScanned: junction + 1 + (messages.length - suffixStart),
        segmentsRescanned: prefix.length + suffix.length,
        segmentsReused: reusedMarkers.length,
        messagesReused: Math.max(0, suffixStart - (junction + 1)),
      });
    }

    const firstChanged = Math.max(0, Math.min(messages.length, change.firstChangedIndex));
    const reuseThroughIndex = lastIdleAtOrBefore(messages, firstChanged - 1);
    const suffixStart = reuseThroughIndex + 1;
    const reusedMarkers: ExecutionMarker[] = [];
    const reusedEnds: number[] = [];
    for (let index = 0; index < previousMarkers.length; index += 1) {
      const marker = previousMarkers[index];
      const end = previousEnds[index];
      if (marker === undefined || end === undefined) break;
      if (end > reuseThroughIndex || end >= firstChanged) break;
      reusedMarkers.push(marker);
      reusedEnds.push(end);
    }
    const suffix = executionMarkers(messages.slice(suffixStart), running);
    const markers = [...reusedMarkers, ...suffix];
    const ends = [
      ...reusedEnds,
      ...indexEnds(messages.slice(suffixStart), suffix).map((end) => end + suffixStart),
    ];
    return commit(messages, markers, ends, {
      messagesScanned: messages.length - suffixStart,
      segmentsRescanned: suffix.length,
      segmentsReused: reusedMarkers.length,
      messagesReused: suffixStart,
    });
  }

  return { project, lastStats: () => stats };
}
