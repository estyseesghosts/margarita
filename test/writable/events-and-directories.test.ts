import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BackendEvent } from '../../src/domain/backend-event.ts';
import { type DisposableService, startDisposableService } from './disposable-service.ts';
import { allMessages, assistantText, waitFor, waitForIdleMarkers } from './wait-for.ts';

/** Opt-in (`MARGARITA_LIVE_WRITE=1`); runs against a disposable service only. */
const enabled = process.env['MARGARITA_LIVE_WRITE'] === '1';

/** Collects normalized events from one subscription until `stop()`. */
function collectEvents(service: DisposableService) {
  const abort = new AbortController();
  const events: BackendEvent[] = [];
  const done = (async () => {
    for await (const event of service.backend.events(abort.signal)) events.push(event);
  })();
  return {
    events,
    stop: async () => {
      abort.abort();
      await done;
    },
  };
}

describe.skipIf(!enabled)('writable service: event stream and project directories', () => {
  let service: DisposableService;
  beforeAll(async () => {
    service = await startDisposableService();
  }, 60_000);
  afterAll(async () => {
    await service.stop();
  });

  const newSession = (directory = service.workspace) =>
    service.backend.createSession({ directory, model: service.modelRef });

  test('a turn produces correlated execution, transcript and inbox events for its session', async () => {
    const subscription = collectEvents(service);
    await waitFor('stream to connect', async () =>
      subscription.events.some((event) => event.kind === 'connected') ? true : undefined,
    );
    const session = await newSession();
    const other = await newSession();
    await service.backend.prompt(session.id, { text: 'streamed', files: [] });
    await waitForIdleMarkers(service.backend, session.id, 1);
    await waitFor('execution to succeed', async () =>
      subscription.events.some(
        (event) =>
          event.kind === 'execution' &&
          event.sessionID === session.id &&
          event.state === 'succeeded',
      )
        ? true
        : undefined,
    );
    await subscription.stop();

    const mine = subscription.events.filter(
      (event) => 'sessionID' in event && event.sessionID === session.id,
    );
    expect(mine.some((event) => event.kind === 'inbox-changed')).toBe(true);
    expect(mine.some((event) => event.kind === 'transcript-changed')).toBe(true);
    const execution = mine.filter((event) => event.kind === 'execution').map((e) => e.state);
    expect(execution[0]).toBe('started');
    expect(execution.at(-1)).toBe('succeeded');
    // Nothing for the idle session leaks into this turn's events.
    expect(
      subscription.events.some(
        (event) =>
          'sessionID' in event && event.sessionID === other.id && event.kind === 'execution',
      ),
    ).toBe(false);
  }, 30_000);

  test('the stream is live-only: work done while disconnected is recovered by re-reading', async () => {
    const session = await newSession();
    const first = collectEvents(service);
    await waitFor('stream to connect', async () =>
      first.events.some((event) => event.kind === 'connected') ? true : undefined,
    );
    await first.stop();

    // Disconnected: this turn runs and finishes while nobody listens.
    await service.backend.prompt(session.id, { text: 'while away', files: [] });
    await waitForIdleMarkers(service.backend, session.id, 1);

    const second = collectEvents(service);
    await waitFor('stream to reconnect', async () =>
      second.events.some((event) => event.kind === 'connected') ? true : undefined,
    );
    // No replay of the missed turn...
    await Bun.sleep(300);
    expect(
      second.events.some(
        (event) =>
          'sessionID' in event && event.sessionID === session.id && event.kind === 'execution',
      ),
    ).toBe(false);
    // ...so a resync from the canonical state shows it, and new work streams normally.
    const history = await allMessages(service.backend, session.id);
    expect(assistantText(history.findLast((message) => message.kind === 'assistant'))).toBe(
      'ok: while away',
    );
    await service.backend.prompt(session.id, { text: 'after reconnect', files: [] });
    await waitFor('post-reconnect execution event', async () =>
      second.events.some(
        (event) =>
          event.kind === 'execution' && event.sessionID === session.id && event.state === 'started',
      )
        ? true
        : undefined,
    );
    await waitForIdleMarkers(service.backend, session.id, 1);
    await second.stop();
  }, 30_000);

  test('sessions and file search are scoped to the project directory they were created in', async () => {
    const alpha = join(service.workspace, 'alpha');
    const beta = join(service.workspace, 'beta');
    await mkdir(alpha, { recursive: true });
    await mkdir(beta, { recursive: true });
    await writeFile(join(alpha, 'only-in-alpha.txt'), 'a');
    await writeFile(join(beta, 'only-in-beta.txt'), 'b');

    const inAlpha = await newSession(alpha);
    const inBeta = await newSession(beta);
    expect(inAlpha.directory).not.toBe(inBeta.directory);

    const alphaSessions = await service.backend.listSessions({ directory: alpha, limit: 50 });
    const alphaIDs = alphaSessions.sessions.map((session) => session.id);
    expect(alphaIDs).toContain(inAlpha.id);
    expect(alphaIDs).not.toContain(inBeta.id);

    const alphaFiles = await service.backend.findProjectFiles(alpha, 'only-in', 20);
    const betaFiles = await service.backend.findProjectFiles(beta, 'only-in', 20);
    expect(alphaFiles.some((path) => path.includes('only-in-alpha'))).toBe(true);
    expect(alphaFiles.some((path) => path.includes('only-in-beta'))).toBe(false);
    expect(betaFiles.some((path) => path.includes('only-in-beta'))).toBe(true);
    expect(betaFiles.some((path) => path.includes('only-in-alpha'))).toBe(false);
  }, 30_000);
});
