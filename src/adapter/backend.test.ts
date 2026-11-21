import { describe, expect, test } from 'bun:test';

import { ClientError } from '@opencode/client';

import {
  BackendError,
  type BackendErrorKind,
  resolveOlderPage,
  toBackendError,
} from './backend.ts';

/** Declared errors from the SDK look like `Object.assign(new Error(msg), body)`. */
function declared(tag: string, message = `${tag} message`): Error {
  const error = new Error(message);
  error.name = tag;
  Object.assign(error, { _tag: tag });
  return error;
}

describe('toBackendError', () => {
  test('maps declared error tags onto kinds', () => {
    const cases: Array<[string, BackendErrorKind]> = [
      ['SessionNotFoundError', 'not-found'],
      ['PermissionNotFoundError', 'not-found'],
      ['MessageNotFoundError', 'not-found'],
      ['AgentNotFoundError', 'not-found'],
      ['ProviderNotFoundError', 'not-found'],
      ['FileNotFoundError', 'not-found'],
      ['ProjectNotFoundError', 'not-found'],
      ['ConflictError', 'conflict'],
      ['SessionBusyError', 'conflict'],
      ['FormAlreadySettledError', 'conflict'],
      ['UnauthorizedError', 'unauthorized'],
      ['ForbiddenError', 'unauthorized'],
      ['InvalidRequestError', 'invalid'],
      ['InvalidCursorError', 'invalid'],
      ['FormInvalidAnswerError', 'invalid'],
      ['UnsupportedModelError', 'invalid'],
      ['InstructionEntryValueTooLargeError', 'invalid'],
      ['ServiceUnavailableError', 'transport'],
      ['RpcError', 'transport'],
      ['RpcInternalError', 'transport'],
      ['UnknownError', 'unknown'],
      ['CommandExecutionError', 'unknown'],
      ['ProviderRequestError', 'unknown'],
      ['WorktreeError', 'unknown'],
    ];
    for (const [tag, kind] of cases) {
      const mapped = toBackendError('op', declared(tag));
      expect(mapped.kind, tag).toBe(kind);
      expect(mapped.message).toContain('op');
    }
  });

  test('preserves the declared message instead of the tag', () => {
    const mapped = toBackendError('permission.reply', declared('SessionNotFoundError', 'nope'));
    expect(mapped.message).toBe('permission.reply: nope');
  });

  test('maps ClientError transport failures to transport', () => {
    const cause = new ClientError('Transport', { cause: new Error('socket hang up') });
    expect(toBackendError('session.list', cause).kind).toBe('transport');
  });

  test('maps UnexpectedStatus by HTTP status', () => {
    const cases: Array<[number, BackendErrorKind]> = [
      [400, 'invalid'],
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [404, 'not-found'],
      [409, 'conflict'],
      [422, 'invalid'],
      [500, 'unknown'],
      [502, 'transport'],
      [503, 'transport'],
      [504, 'transport'],
    ];
    for (const [status, kind] of cases) {
      const cause = new ClientError('UnexpectedStatus', {
        cause: { status },
        detail: String(status),
      });
      expect(toBackendError('op', cause).kind, String(status)).toBe(kind);
    }
  });

  test('unrecognized ClientError reasons and plain errors stay unknown', () => {
    expect(toBackendError('op', new ClientError('MalformedResponse')).kind).toBe('unknown');
    expect(toBackendError('op', new ClientError('UnsupportedContentType')).kind).toBe('unknown');
    expect(toBackendError('op', new TypeError('boom')).kind).toBe('unknown');
    expect(toBackendError('op', 'string failure').kind).toBe('unknown');
  });

  test('passes BackendError through unchanged', () => {
    const original = new BackendError('conflict', 'op', 'msg');
    expect(toBackendError('other', original)).toBe(original);
  });
});

function olderPage(dataLength: number, next?: string) {
  return {
    data: Array.from({ length: dataLength }, (_, index) => index),
    cursor: next === undefined ? {} : { next },
  };
}

describe('resolveOlderPage (issue #125)', () => {
  test('a server token on a short page is not proof of earlier history', async () => {
    expect(await resolveOlderPage(olderPage(2, 'cursor'), 120, async () => 0)).toEqual({
      hasEarlier: false,
    });
  });

  test('no token means no earlier history', async () => {
    expect(await resolveOlderPage(olderPage(120), 120, async () => 1)).toEqual({
      hasEarlier: false,
    });
  });

  test('an exactly-full page needs a confirmed lookahead', async () => {
    expect(await resolveOlderPage(olderPage(120, 'cursor'), 120, async () => 0)).toEqual({
      hasEarlier: false,
    });
    expect(await resolveOlderPage(olderPage(120, 'cursor'), 120, async () => 1)).toEqual({
      olderCursor: 'cursor',
      hasEarlier: true,
    });
  });

  test('a failed lookahead is unknown but keeps a retryable cursor (#144)', async () => {
    const result = await resolveOlderPage(olderPage(120, 'cursor'), 120, async () => {
      throw new Error('offline');
    });
    // No claim that history exists (no #125 phantom banner), but the token survives so a
    // transient failure cannot permanently hide real history.
    expect(result).toEqual({ olderCursor: 'cursor', hasEarlier: false, retryable: true });
  });
});
