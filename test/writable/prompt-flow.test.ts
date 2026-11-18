import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { type DisposableService, startDisposableService } from './disposable-service.ts';
import { assistantText, waitFor, waitForIdleMarkers } from './wait-for.ts';

/**
 * Opt-in (`MARGARITA_LIVE_WRITE=1`): writes sessions, but only into a disposable service
 * started by this file. See docs/15-testing-acceptance.md ("Writable integration suite").
 */
const enabled = process.env['MARGARITA_LIVE_WRITE'] === '1';

describe.skipIf(!enabled)('writable service: prompt flow', () => {
  let service: DisposableService;
  beforeAll(async () => {
    service = await startDisposableService();
  }, 60_000);
  afterAll(async () => {
    await service.stop();
  });

  const newSession = () =>
    service.backend.createSession({ directory: service.workspace, model: service.modelRef });

  test('first prompt: the admitted inbox item becomes the user message and gets one reply', async () => {
    const session = await newSession();
    const admitted = await service.backend.prompt(session.id, { text: 'first', files: [] });
    expect(admitted).toMatchObject({ kind: 'user', text: 'first' });

    const messages = await waitForIdleMarkers(service.backend, session.id, 1);
    expect(messages.map((message) => message.kind)).toEqual(['user', 'assistant', 'idle']);
    expect(messages[0]).toMatchObject({ kind: 'user', id: admitted.id, text: 'first' });
    expect(assistantText(messages[1])).toBe('ok: first');
    expect(messages[2]).toMatchObject({ kind: 'idle', outcome: 'succeeded' });
    expect(await service.backend.listInbox(session.id)).toEqual([]);
    expect((await service.backend.activeSessionIDs()).has(session.id)).toBe(false);
  }, 30_000);

  test('queued second prompt waits in the inbox, then runs after the first turn', async () => {
    const session = await newSession();
    const first = await service.backend.prompt(session.id, { text: 'HOLD one', files: [] });
    await waitFor('session to be active', async () =>
      (await service.backend.activeSessionIDs()).has(session.id) ? true : undefined,
    );
    const second = await service.backend.prompt(session.id, {
      text: 'two',
      files: [],
      delivery: 'queue',
    });
    expect(second.delivery).toBe('queue');
    const inbox = await service.backend.listInbox(session.id);
    expect(inbox.map((item) => item.id)).toEqual([second.id]);

    service.model.release();
    // The server writes one idle marker per run, so both turns share the final one.
    const messages = await waitForIdleMarkers(service.backend, session.id, 1);
    expect(messages.map((message) => message.kind)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'idle',
    ]);
    expect(messages.filter((message) => message.kind === 'user').map((m) => m.id)).toEqual([
      first.id,
      second.id,
    ]);
    const replies = messages.filter((message) => message.kind === 'assistant').map(assistantText);
    expect(replies).toEqual(['workingok: HOLD one', 'ok: two']);
    expect(await service.backend.listInbox(session.id)).toEqual([]);
  }, 30_000);

  test('a queued follow-up can be cancelled before delivery and is never sent', async () => {
    const session = await newSession();
    await service.backend.prompt(session.id, { text: 'HOLD cancel-test', files: [] });
    await waitFor('session to be active', async () =>
      (await service.backend.activeSessionIDs()).has(session.id) ? true : undefined,
    );
    const queued = await service.backend.prompt(session.id, {
      text: 'never delivered',
      files: [],
      delivery: 'queue',
    });
    await service.backend.cancelQueued(session.id, queued.id);
    expect(await service.backend.listInbox(session.id)).toEqual([]);

    service.model.release();
    const messages = await waitForIdleMarkers(service.backend, session.id, 1);
    expect(messages.some((message) => message.kind === 'user' && message.id === queued.id)).toBe(
      false,
    );
    expect(service.model.requests.some((request) => request.userText === 'never delivered')).toBe(
      false,
    );
  }, 30_000);

  test('delivery of a queued item can be changed to steer', async () => {
    const session = await newSession();
    await service.backend.prompt(session.id, { text: 'HOLD steer-test', files: [] });
    await waitFor('session to be active', async () =>
      (await service.backend.activeSessionIDs()).has(session.id) ? true : undefined,
    );
    const queued = await service.backend.prompt(session.id, {
      text: 'redirect',
      files: [],
      delivery: 'queue',
    });
    await service.backend.changeDelivery(session.id, queued.id, 'steer');
    const changed = await service.backend.listInbox(session.id);
    expect(changed.find((item) => item.id === queued.id)?.delivery ?? 'delivered').not.toBe(
      'queue',
    );

    service.model.release();
    const messages = await waitFor('steered message delivery', async () => {
      const all = await waitForIdleMarkers(service.backend, session.id, 1);
      return all.some((message) => message.kind === 'user' && message.id === queued.id)
        ? all
        : undefined;
    });
    expect(messages.filter((message) => message.kind === 'user')).toHaveLength(2);
  }, 30_000);

  test('interrupting a running turn ends it as interrupted', async () => {
    const session = await newSession();
    await service.backend.prompt(session.id, { text: 'HOLD interrupt-test', files: [] });
    await waitFor('session to be active', async () =>
      (await service.backend.activeSessionIDs()).has(session.id) ? true : undefined,
    );
    expect(await service.backend.interrupt(session.id)).toBe(true);
    const messages = await waitForIdleMarkers(service.backend, session.id, 1);
    const marker = messages.findLast((message) => message.kind === 'idle');
    expect(marker).toMatchObject({ kind: 'idle', outcome: 'interrupted' });
    expect((await service.backend.activeSessionIDs()).has(session.id)).toBe(false);
  }, 30_000);

  test('a provider failure surfaces as a failed turn', async () => {
    const session = await newSession();
    await service.backend.prompt(session.id, { text: 'FAIL please', files: [] });
    const messages = await waitForIdleMarkers(service.backend, session.id, 1);
    const marker = messages.findLast((message) => message.kind === 'idle');
    const errored = messages.some((message) => message.kind === 'assistant' && message.error);
    expect(marker?.kind === 'idle' && marker.outcome === 'failed').toBe(true);
    expect(errored || marker?.kind === 'idle').toBe(true);
  }, 30_000);
});
