/**
 * Explicit submission admission transaction (#312).
 *
 * A prompt write has an ambiguous outcome: a connection failure after the request may or may
 * not have been accepted. That outcome must never be retried blindly, must never clear the
 * originating draft, and must never retarget a route the user left during the await. This
 * module owns those decisions as pure functions over explicit inputs. The controller only
 * supplies observed gate and transport state, then executes the returned commands against
 * its store, backend, history and notices.
 */
import { BackendError, type BackendErrorKind } from '../adapter/backend.ts';
import type { Attachment } from '../domain/attachment.ts';
import type { Route } from './app-state.ts';
import { errorText } from './error-text.ts';

/** Why a submission was refused before any transport write. */
export type AdmissionBlock = 'in-flight' | 'model-unconfirmed' | 'agent-unconfirmed';

/** The observed result of the awaited transport write. */
export type SendOutcome =
  | { kind: 'declined' }
  | { kind: 'accepted' }
  | { kind: 'transport-unknown' }
  | { kind: 'failed'; message: string; errorKind: BackendErrorKind };

/** Terminal outcome of one admission transaction. */
export type AdmissionOutcome = 'blocked' | 'declined' | 'admitted' | 'unknown' | 'failed';

/** One observable effect of an admission, in order. */
export type AdmissionCommand =
  | { kind: 'log-accepted' }
  | { kind: 'log-failed'; errorKind: BackendErrorKind }
  | {
      kind: 'remember-prompt';
      text: string;
      directory: string;
      serverID: string;
      historyGeneration: number;
    }
  | { kind: 'clear-composer'; text: string; sentAttachments: readonly Attachment[] }
  | { kind: 'show-notice'; message: string }
  | { kind: 'schedule-transcript'; sessionID: string }
  | { kind: 'refresh-inbox'; sessionID: string; serverID: string };

/** Gate state observed from the owning lock and the model/agent confirmation owners. */
export interface AdmissionGateState {
  readonly alreadyAdmitting: boolean;
  readonly modelBlocked: boolean;
  readonly agentBlocked: boolean;
}

/** Everything the outcome decision needs, captured explicitly before or after the await. */
export interface AdmissionContext {
  readonly serverID: string;
  readonly sessionID: string;
  readonly text: string;
  readonly directory: string;
  readonly historyGeneration: number;
  /** Whether the route still points at the originating session when the write resolves. */
  readonly routeIsOrigin: boolean;
  /** Message for an ambiguous transport write; never an invitation to retry. */
  readonly transportNotice: string;
  readonly sentAttachments: readonly Attachment[];
}

/** First blocking reason, in the same precedence the facade checks today. */
export function admissionBlock(gate: AdmissionGateState): AdmissionBlock | null {
  if (gate.alreadyAdmitting) return 'in-flight';
  if (gate.modelBlocked) return 'model-unconfirmed';
  if (gate.agentBlocked) return 'agent-unconfirmed';
  return null;
}

/** Normalizes a thrown value into the two failure categories with distinct policies. */
export function classifySendError(error: unknown): SendOutcome {
  if (error instanceof BackendError && error.kind === 'transport') {
    return { kind: 'transport-unknown' };
  }
  return {
    kind: 'failed',
    message: errorText(error),
    errorKind: error instanceof BackendError ? error.kind : 'unknown',
  };
}

/** True only when the route still names the session the prompt originated from. */
export function isOriginRoute(route: Route, serverID: string, sessionID: string): boolean {
  return (
    route.kind === 'conversation' && route.serverID === serverID && route.sessionID === sessionID
  );
}

/**
 * Decides the terminal outcome and the ordered effects of one send result.
 * An unknown write refreshes server state and preserves the draft; it never produces a
 * second prompt. A confirmed failure only reports the diagnostic. Both preserve the draft.
 */
export function resolveAdmission(
  context: AdmissionContext,
  outcome: SendOutcome,
): { outcome: AdmissionOutcome; commands: AdmissionCommand[] } {
  switch (outcome.kind) {
    case 'declined':
      return { outcome: 'declined', commands: [] };
    case 'accepted': {
      const commands: AdmissionCommand[] = [{ kind: 'log-accepted' }];
      if (context.text.trim() !== '') {
        commands.push({
          kind: 'remember-prompt',
          text: context.text,
          directory: context.directory,
          serverID: context.serverID,
          historyGeneration: context.historyGeneration,
        });
      }
      if (context.routeIsOrigin) {
        commands.push({
          kind: 'clear-composer',
          text: context.text,
          sentAttachments: context.sentAttachments,
        });
      }
      return { outcome: 'admitted', commands };
    }
    case 'transport-unknown': {
      const commands: AdmissionCommand[] = [
        { kind: 'log-failed', errorKind: 'transport' },
        { kind: 'show-notice', message: context.transportNotice },
      ];
      if (context.routeIsOrigin) {
        commands.push(
          { kind: 'schedule-transcript', sessionID: context.sessionID },
          { kind: 'refresh-inbox', sessionID: context.sessionID, serverID: context.serverID },
        );
      }
      return { outcome: 'unknown', commands };
    }
    case 'failed':
      return {
        outcome: 'failed',
        commands: [
          { kind: 'log-failed', errorKind: outcome.errorKind },
          { kind: 'show-notice', message: outcome.message },
        ],
      };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

/** Pure draft-clearance rule: preserve newer text, remove only the sent attachments. */
export function composerClearance(
  currentText: string,
  submittedText: string,
  sentAttachmentIDs: readonly string[],
): { clearText: boolean; sentIDs: ReadonlySet<string> } {
  return { clearText: currentText === submittedText, sentIDs: new Set(sentAttachmentIDs) };
}
