import { describe, expect, test } from 'bun:test';

import type { BackendEvent } from '../domain/backend-event.ts';
import { admitEvent, type EventAdmissionContext, type EventCommand } from './event-admission.ts';

const tokens = { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

function context(
  event: BackendEvent,
  overrides: Partial<EventAdmissionContext> = {},
): EventAdmissionContext {
  return {
    event,
    attached: undefined,
    routeMatchesHost: true,
    hasSession: () => true,
    requestTargets: () => [],
    ...overrides,
  };
}

function kinds(commands: readonly EventCommand[]): string[] {
  return commands.map((command) => command.kind);
}

describe('event admission dispatcher (#308)', () => {
  test("ignores connected and other hosts' catalogs", () => {
    expect(admitEvent(context({ kind: 'connected' }))).toEqual([]);
    expect(admitEvent(context({ kind: 'catalog-changed' }, { routeMatchesHost: false }))).toEqual(
      [],
    );
    expect(
      kinds(admitEvent(context({ kind: 'catalog-changed' }, { routeMatchesHost: true }))),
    ).toEqual(['reload-catalog']);
  });

  test('routes summary, revert and deletion events', () => {
    expect(admitEvent(context({ kind: 'session-changed', sessionID: 'a' }))).toEqual([
      { kind: 'schedule-summary', sessionID: 'a' },
    ]);
    expect(
      admitEvent(context({ kind: 'revert-changed', sessionID: 'a', action: 'staged' })),
    ).toEqual([{ kind: 'refresh-summary', sessionID: 'a' }]);
    expect(kinds(admitEvent(context({ kind: 'session-deleted', sessionID: 'a' })))).toEqual([
      'clear-job-rows',
      'forget-session',
    ]);
  });

  test('usage is admitted only for a listed session, with a stamp first', () => {
    const event: BackendEvent = { kind: 'usage', sessionID: 'a', cost: 3, tokens };
    expect(admitEvent(context(event, { hasSession: () => false }))).toEqual([]);
    expect(admitEvent(context(event))).toEqual([
      { kind: 'stamp-usage', sessionID: 'a' },
      { kind: 'set-usage', sessionID: 'a', cost: 3, tokens },
    ]);
  });

  test('an execution event stamps before effects and refreshes requests only after start', () => {
    const started = admitEvent(
      context({ kind: 'execution', sessionID: 'a', state: 'started' }, { attached: 'a' }),
    );
    expect(kinds(started)).toEqual([
      'stamp-execution',
      'set-running',
      'clear-backgrounded',
      'schedule-summary',
      'schedule-transcript',
    ]);
    expect(started[1]).toEqual({ kind: 'set-running', sessionID: 'a', running: true });

    const ended = admitEvent(context({ kind: 'execution', sessionID: 'a', state: 'succeeded' }));
    expect(kinds(ended)).toContain('mark-stale');
    expect(kinds(ended)).toContain('refresh-input-requests');
  });

  test('transcript hints refresh jobs only when attached and carrying a job hint', () => {
    const attached = context(
      { kind: 'transcript-changed', sessionID: 'a', jobs: true },
      { attached: 'a' },
    );
    const commands = admitEvent(attached);
    expect(commands).toContainEqual({
      kind: 'schedule-transcript',
      sessionID: 'a',
      refreshJobs: true,
    });
    expect(kinds(commands)).not.toContain('schedule-summary');

    const detached = admitEvent(
      context({ kind: 'transcript-changed', sessionID: 'a', jobProbe: true }),
    );
    expect(kinds(detached)).toEqual(['mark-stale']);

    const probe = admitEvent(
      context({ kind: 'transcript-changed', sessionID: 'a', jobProbe: true }, { attached: 'a' }),
    );
    expect(kinds(probe)).toContain('schedule-job-start-probe');
  });

  test('an unlisted session publishes a summary hint', () => {
    const commands = admitEvent(
      context({ kind: 'transcript-changed', sessionID: 'a' }, { hasSession: () => false }),
    );
    expect(kinds(commands)).toContain('schedule-summary');
  });

  test('inbox, request and goal events route to their owning buckets', () => {
    expect(admitEvent(context({ kind: 'inbox-changed', sessionID: 'a' }))).toEqual([]);
    expect(
      admitEvent(context({ kind: 'inbox-changed', sessionID: 'a' }, { attached: 'a' })),
    ).toEqual([{ kind: 'refresh-inbox', sessionID: 'a' }]);

    expect(
      admitEvent(
        context(
          { kind: 'input-requests-changed', sessionID: 'global' },
          { requestTargets: () => ['parent', 'child'] },
        ),
      ),
    ).toEqual([
      { kind: 'refresh-input-requests', sessionID: 'parent' },
      { kind: 'refresh-input-requests', sessionID: 'child' },
    ]);

    expect(admitEvent(context({ kind: 'goal-changed', sessionID: 'a', goal: null }))).toEqual([
      { kind: 'bump-goal-version', sessionID: 'a' },
      { kind: 'set-native-goal', sessionID: 'a', goal: null },
    ]);
  });

  test('request targets are computed lazily only for request events', () => {
    let calls = 0;
    const custom = context(
      { kind: 'session-changed', sessionID: 'a' },
      {
        requestTargets: () => {
          calls += 1;
          return [];
        },
      },
    );
    admitEvent(custom);
    expect(calls).toBe(0);
  });
});
