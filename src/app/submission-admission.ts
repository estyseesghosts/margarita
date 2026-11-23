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

/**
 * Immutable identity of the draft a prompt came from, captured before any await
 * (#324). The revision distinguishes the acknowledged payload from newer edits.
 */
export interface SubmissionOrigin {
  readonly serverID: string;
  readonly sessionID: string;
  readonly draftKey: string;
  readonly draftRevision: number;
  readonly text: string;
  readonly sentAttachmentIDs: readonly string[];
}

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
  | {
      kind: 'clear-parked-draft';
      key: string;
      revision: number;
      text: string;
      sentAttachmentIDs: readonly string[];
    }
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
  /** Captured before validation and the RPC; never derived from the current route. */
  readonly origin: SubmissionOrigin;
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
      } else {
        // The user navigated away: reconcile the parked origin draft, never the
        // composer of the route currently on screen (#324).
        commands.push({
          kind: 'clear-parked-draft',
          key: context.origin.draftKey,
          revision: context.origin.draftRevision,
          text: context.origin.text,
          sentAttachmentIDs: context.origin.sentAttachmentIDs,
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

/**
 * Clearance for a parked origin draft (#324). Text is removed only when the
 * captured revision still matches: a matching string alone cannot distinguish
 * the acknowledged payload from a newer edit that happens to reuse it. Sent
 * attachment IDs are removed regardless, because those bytes were acknowledged.
 */
export function parkedDraftClearance(
  currentText: string,
  currentRevision: number,
  origin: Pick<SubmissionOrigin, 'draftRevision' | 'text' | 'sentAttachmentIDs'>,
): { clearText: boolean; sentIDs: ReadonlySet<string> } {
  return {
    clearText: currentRevision === origin.draftRevision && currentText === origin.text,
    sentIDs: new Set(origin.sentAttachmentIDs),
  };
}

/**
 * Content-free label for a local effect (#334). Diagnostics must be able to say
 * which optional post-write step failed without ever echoing the prompt or an
 * attachment body.
 */
export function localEffectLabel(command: AdmissionCommand): string {
  switch (command.kind) {
    case 'remember-prompt':
      return 'history';
    case 'clear-composer':
    case 'clear-parked-draft':
      return 'draft';
    case 'show-notice':
      return 'notice';
    case 'schedule-transcript':
      return 'transcript refresh';
    case 'refresh-inbox':
      return 'inbox refresh';
    case 'log-accepted':
    case 'log-failed':
      return 'diagnostics';
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

/** Reports a post-acknowledgment failure as a local sync failure, never a send failure. */
export function localFailureNotice(effect: string, error: unknown): string {
  return `The prompt was sent, but the local ${effect} update failed: ${errorText(error)}`;
}
