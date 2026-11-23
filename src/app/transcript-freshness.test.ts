import { describe, expect, test } from 'bun:test';

import {
  classifyTranscriptFailure,
  planResyncStaleFlags,
  type ResyncFreshnessInput,
  type TranscriptFailureInput,
} from './transcript-freshness.ts';

const keyOf = (server: string, session: string) => `${server}:${session}`;

function resyncInput(overrides: Partial<ResyncFreshnessInput> = {}): ResyncFreshnessInput {
  return {
    serverID: 'srv',
    keys: [keyOf('srv', 'a'), keyOf('srv', 'b')],
    attachedSessionID: 'a',
    committedBefore: new Map(),
    committedNow: () => 2,
    sessionServerOf: (key) => key.slice(0, 3),
    sessionIDOf: (key) => key.slice(4),
    ...overrides,
  };
}

function failureInput(overrides: Partial<TranscriptFailureInput> = {}): TranscriptFailureInput {
  return {
    key: 'srv ses',
    qualifiedKey: 'srv:ses',
    sessionID: 'ses',
    serverID: 'srv',
    current: true,
    hasTranscript: true,
    refreshJobs: false,
    dirtyJobs: false,
    retryable: true,
    nextAttempt: () => 1,
    ...overrides,
  };
}

function kinds(commands: readonly { kind: string }[]): string[] {
  return commands.map((command) => command.kind);
}

describe('transcript freshness: resync stale decision (#309)', () => {
  test('an attached session that committed a newer page stays fresh', () => {
    const commands = planResyncStaleFlags(
      resyncInput({
        committedBefore: new Map([[keyOf('srv', 'a'), 1]]),
        committedNow: () => 2,
      }),
    );
    expect(commands).toEqual([
      { kind: 'set-stale', key: keyOf('srv', 'a'), stale: false },
      { kind: 'set-stale', key: keyOf('srv', 'b'), stale: true },
    ]);
  });

  test('an attached session without a newer commit is stale', () => {
    expect(
      planResyncStaleFlags(
        resyncInput({
          committedBefore: new Map([[keyOf('srv', 'a'), 5]]),
          committedNow: () => 5,
        }),
      )[0],
    ).toEqual({ kind: 'set-stale', key: keyOf('srv', 'a'), stale: true });
  });

  test('a detached session is stale even when an old read landed during the resync', () => {
    expect(
      planResyncStaleFlags(resyncInput({ attachedSessionID: undefined })).map((c) => c.stale),
    ).toEqual([true, true]);
    expect(
      planResyncStaleFlags(resyncInput({ attachedSessionID: 'b' })).map((c) => c.stale),
    ).toEqual([true, false]);
  });

  test('transcripts on other hosts are never touched', () => {
    const commands = planResyncStaleFlags(
      resyncInput({ keys: [keyOf('srv', 'a'), keyOf('other', 'a')] }),
    );
    expect(commands).toEqual([{ kind: 'set-stale', key: keyOf('srv', 'a'), stale: false }]);
  });
});

describe('transcript freshness: failure classification (#309)', () => {
  test('a deleted session or removed host only resets the retry chain', () => {
    expect(kinds(classifyTranscriptFailure(failureInput({ current: false })))).toEqual([
      'reset-retries',
    ]);
  });

  test('a permanent failure marks stale, honors job hints and resets instead of retrying', () => {
    const commands = classifyTranscriptFailure(
      failureInput({ retryable: false, refreshJobs: true }),
    );
    expect(kinds(commands)).toEqual(['mark-stale', 'refresh-jobs', 'reset-retries']);
  });

  test('a transient failure schedules a bounded retry after the other effects', () => {
    const commands = classifyTranscriptFailure(failureInput({ dirtyJobs: true }));
    expect(kinds(commands)).toEqual(['mark-stale', 'refresh-jobs', 'schedule-retry']);
    expect(commands[2]).toEqual({
      kind: 'schedule-retry',
      key: 'srv ses',
      attempt: 1,
      sessionID: 'ses',
      serverID: 'srv',
      dirtyJobs: true,
    });
  });

  test('an exhausted retry budget keeps the stale marker but schedules nothing', () => {
    const commands = classifyTranscriptFailure(failureInput({ nextAttempt: () => undefined }));
    expect(kinds(commands)).toEqual(['mark-stale']);
  });

  test('a transient failure with no cached transcript emits only the retry', () => {
    expect(kinds(classifyTranscriptFailure(failureInput({ hasTranscript: false })))).toEqual([
      'schedule-retry',
    ]);
  });
});
