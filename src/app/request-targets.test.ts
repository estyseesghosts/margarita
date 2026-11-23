import { describe, expect, test } from 'bun:test';

import { inputRequestRefreshTargets, type RequestTargetInput } from './request-targets.ts';

function input(overrides: Partial<RequestTargetInput> = {}): RequestTargetInput {
  return {
    eventSessionID: 'ses_a',
    serverID: 'local',
    isKnown: () => true,
    attached: { serverID: 'local', sessionID: 'parent' },
    scope: () => new Set(['parent', 'child']),
    ...overrides,
  };
}

describe('input-request event routing (#310)', () => {
  test('a known session event refreshes only itself when unrelated to the view', () => {
    expect(inputRequestRefreshTargets(input({ scope: () => new Set(['parent']) }))).toEqual([
      'ses_a',
    ]);
  });

  test('a child of the viewed parent refreshes both buckets', () => {
    expect(inputRequestRefreshTargets(input({ eventSessionID: 'child' }))).toEqual([
      'child',
      'parent',
    ]);
  });

  test('a global event refreshes the attached parent, even on another host view', () => {
    expect(inputRequestRefreshTargets(input({ eventSessionID: 'global' }))).toEqual(['parent']);
    expect(
      inputRequestRefreshTargets(
        input({ eventSessionID: 'global', attached: { serverID: 'remote', sessionID: 'parent' } }),
      ),
    ).toEqual([]);
  });

  test('an unknown session is treated as a possible child and refreshes the parent', () => {
    expect(
      inputRequestRefreshTargets(input({ isKnown: () => false, attached: undefined })),
    ).toEqual([]);
    expect(inputRequestRefreshTargets(input({ isKnown: () => false }))).toEqual(['parent']);
  });

  test("a view on another server never receives this host's event", () => {
    expect(
      inputRequestRefreshTargets(input({ attached: { serverID: 'remote', sessionID: 'parent' } })),
    ).toEqual(['ses_a']);
  });
});
