import { describe, expect, test } from 'bun:test';

import { normalizeEvent } from './backend-event.ts';

describe('normalizeEvent', () => {
  test('usage events carry cost and tokens', () => {
    expect(
      normalizeEvent({
        type: 'session.usage.updated',
        data: {
          sessionID: 's',
          cost: 0.5,
          tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 4, write: 0 } },
        },
      }),
    ).toEqual({
      kind: 'usage',
      sessionID: 's',
      cost: 0.5,
      tokens: { input: 10, output: 2, reasoning: 1, cacheRead: 4, cacheWrite: 0 },
    });
  });
  test('malformed usage is dropped rather than zeroing totals', () => {
    expect(
      normalizeEvent({ type: 'session.usage.updated', data: { sessionID: 's', cost: 'x' } }),
    ).toBeUndefined();
  });
  test('execution failures keep the server message', () => {
    expect(
      normalizeEvent({
        type: 'session.execution.failed',
        data: { sessionID: 's', error: { message: 'boom' } },
      }),
    ).toEqual({ kind: 'execution', sessionID: 's', state: 'failed', error: 'boom' });
  });
  test('streaming events mark the transcript dirty without requesting jobs (#284)', () => {
    expect(
      normalizeEvent({ type: 'session.text.delta', data: { sessionID: 's', delta: 'x' } }),
    ).toEqual({ kind: 'transcript-changed', sessionID: 's' });
    expect(normalizeEvent({ type: 'session.tool.progress', data: { sessionID: 's' } })).toEqual({
      kind: 'transcript-changed',
      sessionID: 's',
    });
  });

  test('shell/completion events also reconcile server job lists (#284)', () => {
    expect(normalizeEvent({ type: 'session.shell.started', data: { sessionID: 's' } })).toEqual({
      kind: 'transcript-changed',
      sessionID: 's',
      jobs: true,
    });
    expect(normalizeEvent({ type: 'session.step.ended', data: { sessionID: 's' } })).toEqual({
      kind: 'transcript-changed',
      sessionID: 's',
      jobs: true,
    });
  });
  test('permission events', () => {
    expect(normalizeEvent({ type: 'permission.asked', data: { sessionID: 's' } })).toEqual({
      kind: 'input-requests-changed',
      sessionID: 's',
    });
  });
  test('nested form.created events keep the owning session (#208)', () => {
    expect(
      normalizeEvent({
        type: 'form.created',
        data: { form: { id: 'f1', sessionID: 'ses_child', title: 'Q', fields: [] } },
      }),
    ).toEqual({ kind: 'input-requests-changed', sessionID: 'ses_child' });
    expect(
      normalizeEvent({ type: 'form.created', data: { form: { id: 'f1', title: 'Q' } } }),
    ).toBeUndefined();
    expect(normalizeEvent({ type: 'form.created', data: {} })).toBeUndefined();
  });
  test('older flat form.created events still resolve their session', () => {
    expect(
      normalizeEvent({ type: 'form.created', data: { id: 'f1', sessionID: 'ses_a' } }),
    ).toEqual({ kind: 'input-requests-changed', sessionID: 'ses_a' });
  });
  test('form settlements accept flat and nested payloads', () => {
    expect(
      normalizeEvent({ type: 'form.replied', data: { id: 'f1', sessionID: 'ses_a' } }),
    ).toEqual({ kind: 'input-requests-changed', sessionID: 'ses_a' });
    expect(
      normalizeEvent({
        type: 'form.cancelled',
        data: { form: { id: 'f1', sessionID: 'global' } },
      }),
    ).toEqual({ kind: 'input-requests-changed', sessionID: 'global' });
  });
  test('reconnect marker and unknown events', () => {
    expect(normalizeEvent({ type: 'server.connected', data: {} })).toEqual({ kind: 'connected' });
    expect(normalizeEvent({ type: 'pty.created', data: { sessionID: 's' } })).toBeUndefined();
    expect(normalizeEvent(null)).toBeUndefined();
    expect(normalizeEvent({ type: 'session.text.delta' })).toBeUndefined();
  });
});
