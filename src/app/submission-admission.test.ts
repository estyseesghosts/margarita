import { describe, expect, test } from 'bun:test';

import { BackendError } from '../adapter/backend.ts';
import type { Attachment } from '../domain/attachment.ts';
import type { Route } from './app-state.ts';
import {
  admissionBlock,
  type AdmissionContext,
  type AdmissionGateState,
  type AdmissionOutcome,
  classifySendError,
  composerClearance,
  failedPromptRecovery,
  isOriginRoute,
  localEffectLabel,
  localFailureNotice,
  parkedDraftClearance,
  resolveAdmission,
  type SendOutcome,
  type SubmissionOrigin,
} from './submission-admission.ts';

const originRoute: Route = { kind: 'conversation', serverID: 'srv', sessionID: 'ses' };

function attachment(id: string): Attachment {
  return { id, name: `${id}.png`, mime: 'image/png', data: 'AA==', size: 3 };
}

function context(overrides: Partial<AdmissionContext> = {}): AdmissionContext {
  return {
    serverID: 'srv',
    sessionID: 'ses',
    text: 'please fix this',
    directory: '/work',
    historyGeneration: 7,
    routeIsOrigin: true,
    transportNotice: 'Delivery unknown. Check the transcript before resending.',
    sentAttachments: [],
    origin: {
      serverID: 'srv',
      sessionID: 'ses',
      draftKey: 'server:srv/session:ses',
      draftRevision: 3,
      text: 'please fix this',
      sentAttachmentIDs: [],
    } satisfies SubmissionOrigin,
    ...overrides,
  };
}

function resolve(
  outcome: SendOutcome,
  overrides: Partial<AdmissionContext> = {},
): {
  outcome: AdmissionOutcome;
  kinds: string[];
  commands: ReturnType<typeof resolveAdmission>['commands'];
} {
  const result = resolveAdmission(context(overrides), outcome);
  return {
    outcome: result.outcome,
    kinds: result.commands.map((command) => command.kind),
    commands: result.commands,
  };
}

function gate(overrides: Partial<AdmissionGateState> = {}): AdmissionGateState {
  return { alreadyAdmitting: false, modelBlocked: false, agentBlocked: false, ...overrides };
}

describe('submission admission state machine (#312)', () => {
  test('the triple guard reports the first blocking reason', () => {
    expect(admissionBlock(gate())).toBeNull();
    expect(admissionBlock(gate({ agentBlocked: true }))).toBe('agent-unconfirmed');
    expect(admissionBlock(gate({ modelBlocked: true, agentBlocked: true }))).toBe(
      'model-unconfirmed',
    );
    expect(
      admissionBlock(gate({ alreadyAdmitting: true, modelBlocked: true, agentBlocked: true })),
    ).toBe('in-flight');
  });

  test('a transport failure is unknown, other failures carry a kind and message', () => {
    expect(classifySendError(new BackendError('transport', 'session.prompt', 'offline'))).toEqual({
      kind: 'transport-unknown',
    });
    expect(classifySendError(new BackendError('conflict', 'session.prompt', 'busy'))).toEqual({
      kind: 'failed',
      message: 'session.prompt: busy',
      errorKind: 'conflict',
    });
    expect(classifySendError(new Error('plain'))).toEqual({
      kind: 'failed',
      message: 'plain',
      errorKind: 'unknown',
    });
  });

  test('route ownership is checked against the originating host and session', () => {
    expect(isOriginRoute(originRoute, 'srv', 'ses')).toBe(true);
    expect(isOriginRoute(originRoute, 'other', 'ses')).toBe(false);
    expect(isOriginRoute(originRoute, 'srv', 'other')).toBe(false);
    expect(isOriginRoute({ kind: 'overview' }, 'srv', 'ses')).toBe(false);
  });

  test('a declined send produces no effects', () => {
    expect(resolve({ kind: 'declined' })).toEqual({
      outcome: 'declined',
      kinds: [],
      commands: [],
    });
  });

  test('an accepted send logs, records history and clears the acknowledged draft in order', () => {
    const sent = [attachment('a1')];
    const result = resolve(
      { kind: 'accepted' },
      {
        sentAttachments: sent,
        origin: {
          serverID: 'srv',
          sessionID: 'ses',
          draftKey: 'server:srv/session:ses',
          draftRevision: 3,
          text: 'please fix this',
          sentAttachmentIDs: ['a1'],
        },
      },
    );
    expect(result.outcome).toBe('admitted');
    expect(result.kinds).toEqual(['log-accepted', 'remember-prompt', 'clear-composer']);
    expect(result.commands[1]).toEqual({
      kind: 'remember-prompt',
      text: 'please fix this',
      directory: '/work',
      serverID: 'srv',
      historyGeneration: 7,
    });
    // Active-origin clearance carries the immutable identity, exactly like the parked path.
    expect(result.commands[2]).toEqual({
      kind: 'clear-composer',
      key: 'server:srv/session:ses',
      revision: 3,
      text: 'please fix this',
      sentAttachmentIDs: ['a1'],
    });
  });

  test('a whitespace-only draft is not written to history', () => {
    expect(resolve({ kind: 'accepted' }, { text: '   \n' }).kinds).toEqual([
      'log-accepted',
      'clear-composer',
    ]);
  });

  test('a route change during the send reconciles the parked origin draft only (#324)', () => {
    const sent = [attachment('a1')];
    const origin: SubmissionOrigin = {
      serverID: 'srv',
      sessionID: 'ses',
      draftKey: 'server:srv/session:ses',
      draftRevision: 3,
      text: 'please fix this',
      sentAttachmentIDs: ['a1'],
    };
    const result = resolve(
      { kind: 'accepted' },
      { routeIsOrigin: false, origin, sentAttachments: sent },
    );
    expect(result.outcome).toBe('admitted');
    expect(result.kinds).toEqual(['log-accepted', 'remember-prompt', 'clear-parked-draft']);
    expect(result.commands[2]).toEqual({
      kind: 'clear-parked-draft',
      key: 'server:srv/session:ses',
      revision: 3,
      text: 'please fix this',
      sentAttachmentIDs: ['a1'],
    });
    const unknown = resolve(
      { kind: 'transport-unknown' },
      { routeIsOrigin: false, origin, sentAttachments: sent },
    );
    expect(unknown.kinds).not.toContain('clear-parked-draft');
  });

  test('an unknown write preserves the draft and refreshes only the originating session', () => {
    const result = resolve({ kind: 'transport-unknown' });
    expect(result.outcome).toBe('unknown');
    expect(result.kinds).toEqual([
      'log-failed',
      'show-notice',
      'schedule-transcript',
      'refresh-inbox',
    ]);
    expect(result.commands).not.toContainEqual({ kind: 'show-notice', message: '' });
    expect(result.commands[1]).toEqual({
      kind: 'show-notice',
      message: 'Delivery unknown. Check the transcript before resending.',
    });
    expect(result.kinds).not.toContain('clear-composer');
    expect(result.kinds).not.toContain('remember-prompt');

    const moved = resolve({ kind: 'transport-unknown' }, { routeIsOrigin: false });
    expect(moved.kinds).toEqual(['log-failed', 'show-notice']);
  });

  test('a confirmed failure reports only the diagnostic and never retries or clears', () => {
    const result = resolve({
      kind: 'failed',
      message: 'session.prompt: busy',
      errorKind: 'conflict',
    });
    expect(result.outcome).toBe('failed');
    expect(result.commands).toEqual([
      { kind: 'log-failed', errorKind: 'conflict' },
      { kind: 'show-notice', message: 'session.prompt: busy' },
    ]);
  });

  test('draft clearance preserves newer text but always removes sent attachments', () => {
    expect(composerClearance('newer text', 'submitted', ['a1'])).toEqual({
      clearText: false,
      sentIDs: new Set(['a1']),
    });
    expect(composerClearance('submitted', 'submitted', ['a1', 'a2'])).toEqual({
      clearText: true,
      sentIDs: new Set(['a1', 'a2']),
    });
    expect(composerClearance('submitted', 'submitted', []).sentIDs.size).toBe(0);
  });

  test('parked draft clearance requires the captured revision, not just matching text (#324)', () => {
    const origin = {
      draftRevision: 3,
      text: 'please fix this',
      sentAttachmentIDs: ['a1'],
    };
    expect(parkedDraftClearance('please fix this', 3, origin)).toEqual({
      clearText: true,
      sentIDs: new Set(['a1']),
    });
    expect(parkedDraftClearance('please fix this', 4, origin)).toEqual({
      clearText: false,
      sentIDs: new Set(['a1']),
    });
    expect(parkedDraftClearance('newer edit', 3, origin).clearText).toBe(false);
  });

  test('failed first-prompt parking reconciles instead of duplicating text or files (#339)', () => {
    // Navigation parks the exact envelope; recovery must be a no-op for already-present data.
    expect(failedPromptRecovery('hello', 'hello', ['a1'], ['a1'])).toEqual({
      text: undefined,
      missingAttachmentIDs: [],
      disposition: 'already-present',
    });
    // A newer edit containing the original is preserved without a second copy.
    expect(failedPromptRecovery('hello world', 'hello', ['a1'], ['a1'])).toEqual({
      text: undefined,
      missingAttachmentIDs: [],
      disposition: 'already-present',
    });
    // An empty parked draft receives the text once and only genuinely new attachment IDs.
    expect(failedPromptRecovery('', 'hello', ['a1'], ['a1', 'a2'])).toEqual({
      text: 'hello',
      missingAttachmentIDs: ['a2'],
      disposition: 'merged',
    });
    // Attachment IDs with a shared basename are deduplicated by stable ID, never by name.
    expect(failedPromptRecovery('hello', 'hello', ['a1'], ['a1', 'a2'])).toEqual({
      text: undefined,
      missingAttachmentIDs: ['a2'],
      disposition: 'already-present',
    });
    expect(failedPromptRecovery('', '', [], [])).toEqual({
      text: undefined,
      missingAttachmentIDs: [],
      disposition: 'already-present',
    });
    // A divergent newer edit keeps its content; the original is exposed separately.
    expect(failedPromptRecovery('newer text', 'hello', ['a2'], ['a1', 'a2'])).toEqual({
      text: 'hello',
      missingAttachmentIDs: ['a1'],
      disposition: 'divergent',
    });
  });

  test('local effect failures are reported without prompt content (#334)', () => {
    expect(
      localEffectLabel({
        kind: 'remember-prompt',
        text: 'SECRET',
        directory: '/work',
        serverID: 'srv',
        historyGeneration: 1,
      }),
    ).toBe('history');
    expect(
      localEffectLabel({
        kind: 'clear-composer',
        key: 'server:srv/session:ses',
        revision: 3,
        text: 'SECRET',
        sentAttachmentIDs: [],
      }),
    ).toBe('draft');
    expect(localEffectLabel({ kind: 'show-notice', message: 'SECRET' })).toBe('notice');
    const notice = localFailureNotice('history', new Error('disk full'));
    expect(notice).toContain('prompt was sent');
    expect(notice).toContain('disk full');
    expect(notice).not.toContain('SECRET');
  });
});
