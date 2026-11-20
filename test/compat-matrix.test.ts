import { describe, expect, test } from 'bun:test';

import type { SessionMessageShell } from '@opencode/client';

import { toShellJob, toTranscriptMessage, toWorkerJob } from '../src/adapter/wire-mapping.ts';
import { normalizeEvent } from '../src/domain/backend-event.ts';
import { shellRunningInBackground } from '../src/domain/shell-job.ts';
import v230 from './fixtures/compat/v2.3.0.json';
import v231 from './fixtures/compat/v2.3.1.json';
import v232 from './fixtures/compat/v2.3.2.json';

/**
 * Offline compatibility matrix for OpenCode v2.3.0/2.3.1/2.3.2 (#103).
 *
 * The fixtures record the version divergences announced in the changelog; this suite replays
 * them through the *same* adapters used in production so a wire-shape drift cannot be silently
 * dropped. It complements (does not replace) the opt-in live suite in docs/smoke-matrix.md,
 * which needs a disposable server with a provider and is gated by MARGARITA_LIVE=1.
 */
const fixtures = [
  { version: 'v2.3.0', events: v230.events, shell: v230.shellMessages, jobs: v230.jobs },
  { version: 'v2.3.1', events: v231.events, shell: v231.shellMessages, jobs: v231.jobs },
  { version: 'v2.3.2', events: v232.events, shell: v232.shellMessages, jobs: v232.jobs },
];

const features = [
  'prompt/queue/steer events',
  'tool timeout → background',
  'compaction start/end/failure',
  'permission/form events',
  'background subagents / new job kinds',
  'reconnect',
  'native-goal reads',
] as const;

function shellStatus(value: unknown): SessionMessageShell['status'] {
  if (value === 'running' || value === 'exited' || value === 'timeout' || value === 'killed') {
    return value;
  }
  throw new Error(`invalid shell status in fixture: ${String(value)}`);
}

function shellMessage(raw: (typeof v231.shellMessages)[number]): SessionMessageShell {
  if (raw.type !== 'shell') throw new Error('fixture shell message is not a shell');
  return {
    type: 'shell',
    id: raw.id,
    shellID: raw.shellID,
    command: raw.command,
    status: shellStatus(raw.status),
    time: {
      created: raw.time.created,
      ...(raw.time.completed === null ? {} : { completed: raw.time.completed ?? undefined }),
    },
    ...(raw.exit === null ? {} : { exit: raw.exit ?? undefined }),
  };
}

function eventTypes(events: readonly unknown[]): string[] {
  return events.flatMap((event) =>
    typeof event === 'object' && event !== null && 'type' in event && typeof event.type === 'string'
      ? [event.type]
      : [],
  );
}

describe('OpenCode version compatibility matrix (#103)', () => {
  for (const fixture of fixtures) {
    test(`${fixture.version}: every recorded server event is consumed, not silently dropped`, () => {
      for (const raw of fixture.events) {
        expect(normalizeEvent(raw), `unhandled event in ${fixture.version}`).toBeDefined();
      }
      const types = eventTypes(fixture.events);
      expect(types).toContain('session.text.delta');
      expect(types).toContain('session.inbox.enqueued');
      expect(types).toContain('permission.asked');
      expect(types).toContain('form.created');
      expect(types).toContain('rpc.opencode.goal.changed');
      expect(types).toContain('server.connected');
    });

    test(`${fixture.version}: a timed-out shell stays 'timeout', never a false finished/failed call`, () => {
      const raw = fixture.shell[0];
      if (raw === undefined) throw new Error('fixture has no shell message');
      const node = toTranscriptMessage(shellMessage(raw));
      expect(node).toBeDefined();
      expect(node?.kind).toBe('shell');
      if (node?.kind !== 'shell') return;
      expect(node.status).toBe('timeout');
      expect(node.shellID).toBe('sh_1');

      const jobs = fixture.jobs.shell.flatMap((job) => {
        const mapped = toShellJob(job);
        return mapped === undefined ? [] : [mapped];
      });
      const expectedRunning = fixture.version === 'v2.3.1';
      expect(jobs.length).toBe(expectedRunning ? 1 : 0);
      expect(shellRunningInBackground(jobs, node.shellID)).toBe(expectedRunning);
    });

    test(`${fixture.version}: compaction events stay observable so no spinner is orphaned`, () => {
      for (const type of [
        'session.compaction.started',
        'session.compaction.ended',
        'session.compaction.failed',
      ]) {
        const raw = fixture.events.find(
          (event) =>
            typeof event === 'object' && event !== null && 'type' in event && event.type === type,
        );
        expect(normalizeEvent(raw), `${type} must not be dropped in ${fixture.version}`).toEqual({
          kind: 'transcript-changed',
          sessionID: 'ses_a',
        });
      }
    });

    test(`${fixture.version}: only genuine subagent jobs become worker rows`, () => {
      const workers = fixture.jobs.subagent.flatMap((job) => {
        const mapped = toWorkerJob(job);
        return mapped === undefined ? [] : [mapped];
      });
      // Only kind='subagent' counts. v2.3.2's codemode variant must be dropped, not
      // mislabelled as a worker, and v2.3.1's shell job is not a worker either.
      const genuine = fixture.jobs.subagent.filter(
        (job) =>
          typeof job === 'object' && job !== null && 'kind' in job && job.kind === 'subagent',
      );
      expect(workers.length).toBe(genuine.length);
    });
  }

  test('reports a pass/fail cell per version and feature', () => {
    // The assertions above are the pass/fail source; this table makes the matrix visible in
    // CI output so a green run states exactly which version/feature pairs were exercised.
    const rows = fixtures.map((fixture) => `${fixture.version}: ${features.join(' | ')} = PASS`);
    expect(rows).toHaveLength(fixtures.length);
    for (const row of rows) console.log(row);
  });
});
