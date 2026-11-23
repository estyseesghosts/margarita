/**
 * Pure event-to-command admission for one host (#308).
 *
 * Server events are hints, never authoritative state. This service owns the
 * decisions about which hints matter for the viewed route, which session is
 * attached, and the exact ordered effects each event implies. It returns plain
 * commands; the owning controller executes them against its store, backend and
 * notices. That separation lets the admission rules be tested without a mounted
 * controller, a backend or the Solid store.
 */
import type { BackendEvent } from '../domain/backend-event.ts';
import type { NativeGoal } from '../domain/native-goal.ts';
import type { TokenUsage } from '../domain/session.ts';

/** One observable effect an admitted event produces, in order. */
export type EventCommand =
  | { kind: 'reload-catalog' }
  | { kind: 'schedule-summary'; sessionID: string }
  | { kind: 'refresh-summary'; sessionID: string }
  | { kind: 'clear-job-rows'; sessionID: string }
  | { kind: 'forget-session'; sessionID: string }
  | { kind: 'stamp-usage'; sessionID: string }
  | { kind: 'set-usage'; sessionID: string; cost: number; tokens: TokenUsage }
  | { kind: 'stamp-execution'; sessionID: string }
  | { kind: 'set-running'; sessionID: string; running: boolean }
  | { kind: 'clear-backgrounded'; sessionID: string }
  | { kind: 'schedule-transcript'; sessionID: string; refreshJobs: boolean }
  | { kind: 'mark-stale'; sessionID: string }
  | { kind: 'schedule-job-start-probe'; sessionID: string }
  | { kind: 'refresh-input-requests'; sessionID: string }
  | { kind: 'refresh-inbox'; sessionID: string }
  | { kind: 'bump-goal-version'; sessionID: string }
  | { kind: 'set-native-goal'; sessionID: string; goal: NativeGoal | null };

/** Read-only context the admission decision needs; all host-specific values are explicit. */
export interface EventAdmissionContext {
  readonly event: BackendEvent;
  /** Attached conversation on this host, read from the current route. */
  readonly attached: string | undefined;
  /** Whether this host owns the viewed route; only then may a catalog event reload it. */
  readonly routeMatchesHost: boolean;
  /** Whether a session is in the loaded index. */
  readonly hasSession: (sessionID: string) => boolean;
  /** Buckets a request event must refresh; lazy because only that event needs it. */
  readonly requestTargets: () => readonly string[];
}

/** Routes one event into an ordered list of effects; no state or backend access. */
export function admitEvent(context: EventAdmissionContext): EventCommand[] {
  const { event, attached } = context;
  const sessionID = 'sessionID' in event ? event.sessionID : '';
  switch (event.kind) {
    case 'connected':
      return [];
    case 'catalog-changed':
      return context.routeMatchesHost ? [{ kind: 'reload-catalog' }] : [];
    case 'revert-changed':
      // Immediate reconcile, not debounced: opens recovery for a stage we did not make.
      return [{ kind: 'refresh-summary', sessionID }];
    case 'session-changed':
      return [{ kind: 'schedule-summary', sessionID }];
    case 'session-deleted':
      return [
        { kind: 'clear-job-rows', sessionID },
        { kind: 'forget-session', sessionID },
      ];
    case 'usage':
      // Only a listed session can display usage; the stamp keeps an earlier
      // summary snapshot from rolling the fresh value back (#272).
      return context.hasSession(sessionID)
        ? [
            { kind: 'stamp-usage', sessionID },
            { kind: 'set-usage', sessionID, cost: event.cost, tokens: event.tokens },
          ]
        : [];
    case 'execution': {
      const commands: EventCommand[] = [
        { kind: 'stamp-execution', sessionID },
        { kind: 'set-running', sessionID, running: event.state === 'started' },
        { kind: 'clear-backgrounded', sessionID },
        { kind: 'schedule-summary', sessionID },
      ];
      if (attached === sessionID) {
        commands.push({ kind: 'schedule-transcript', sessionID, refreshJobs: true });
      } else {
        commands.push({ kind: 'mark-stale', sessionID });
      }
      if (event.state !== 'started') commands.push({ kind: 'refresh-input-requests', sessionID });
      return commands;
    }
    case 'transcript-changed': {
      const commands: EventCommand[] = [];
      if (!context.hasSession(sessionID)) commands.push({ kind: 'schedule-summary', sessionID });
      if (attached === sessionID) {
        commands.push({
          kind: 'schedule-transcript',
          sessionID,
          refreshJobs: event.jobs === true || event.jobProbe === true,
        });
        if (event.jobProbe === true) commands.push({ kind: 'schedule-job-start-probe', sessionID });
      } else {
        commands.push({ kind: 'mark-stale', sessionID });
      }
      return commands;
    }
    case 'inbox-changed':
      return attached === sessionID ? [{ kind: 'refresh-inbox', sessionID }] : [];
    case 'input-requests-changed':
      return context
        .requestTargets()
        .map((target) => ({ kind: 'refresh-input-requests', sessionID: target }));
    case 'goal-changed':
      return [
        { kind: 'bump-goal-version', sessionID },
        { kind: 'set-native-goal', sessionID, goal: event.goal },
      ];
    default:
      return [];
  }
}
