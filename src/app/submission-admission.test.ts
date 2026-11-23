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
  isOriginRoute,
  resolveAdmission,
  type SendOutcome,
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
    const result = resolve({ kind: 'accepted' }, { sentAttachments: sent });
    expect(result.outcome).toBe('admitted');
    expect(result.kinds).toEqual(['log-accepted', 'remember-prompt', 'clear-composer']);
    expect(result.commands[1]).toEqual({
      kind: 'remember-prompt',
      text: 'please fix this',
      directory: '/work',
      serverID: 'srv',
      historyGeneration: 7,
    });
    expect(result.commands[2]).toEqual({
      kind: 'clear-composer',
      text: 'please fix this',
      sentAttachments: sent,
    });
  });

  test('a whitespace-only draft is not written to history', () => {
    expect(resolve({ kind: 'accepted' }, { text: '   \n' }).kinds).toEqual([
      'log-accepted',
      'clear-composer',
    ]);
  });

  test('a route change during the send preserves the originating draft', () => {
    const result = resolve({ kind: 'accepted' }, { routeIsOrigin: false });
    expect(result.outcome).toBe('admitted');
    expect(result.kinds).not.toContain('clear-composer');
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
});
