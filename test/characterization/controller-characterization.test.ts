import { describe, expect, test } from 'bun:test';

import { composerFrom } from '../../src/domain/composer.ts';
import { assertNoCalls, createHarness, deferred, settle } from './harness.ts';

describe('characterization harness (#306)', () => {
  test('a deferred settles only when the test releases it', async () => {
    const gate = deferred<number>();
    let finished = false;
    const work = gate.promise.then((value) => {
      finished = true;
      return value;
    });
    await settle(2);
    expect(finished).toBe(false);
    gate.resolve(7);
    expect(await work).toBe(7);
    expect(finished).toBe(true);
  });

  test('call marks slice only the RPCs made after them, per owning host', async () => {
    const harness = await createHarness();
    const marks = harness.marks();
    harness.controller.openSession(harness.sessionID, 'local');
    await settle();
    const calls = harness.callsSince(marks);
    expect(calls.some((call) => call.serverID === 'local' && call.name === 'listMessages')).toBe(
      true,
    );
    assertNoCalls(calls, (call) => call.serverID === 'remote', 'opening a local session');
    harness.dispose();
  });
});

describe('production behavior through the characterization harness (#306)', () => {
  test('identical session IDs on two hosts never cross ownership', async () => {
    const harness = await createHarness();
    harness.controller.openSession(harness.sessionID, 'local');
    await settle();
    expect(harness.controller.state.route).toMatchObject({
      kind: 'conversation',
      serverID: 'local',
    });
    expect(harness.controller.currentView()?.session?.title).toBe('local session');

    harness.controller.openSession(harness.sessionID, 'remote');
    await settle();
    expect(harness.controller.state.route).toMatchObject({
      kind: 'conversation',
      serverID: 'remote',
    });
    expect(harness.controller.currentView()?.session?.title).toBe('remote session');
    harness.dispose();
  });

  test('a second Enter during one admission cannot duplicate the prompt', async () => {
    const harness = await createHarness();
    harness.controller.openSession(harness.sessionID, 'local');
    await settle();
    const gate = deferred();
    const backend = harness.backend('local');
    const original = backend.prompt.bind(backend);
    backend.prompt = async (sessionID, draft) => {
      const result = await original(sessionID, draft);
      await gate.promise;
      return result;
    };
    harness.controller.setComposer(composerFrom('billable prompt'));
    const marks = harness.marks();
    const first = harness.controller.submit();
    const second = harness.controller.submit();
    await settle(20);
    expect(
      harness
        .callsSince(marks)
        .filter((call) => call.name === 'prompt' && call.serverID === 'local'),
    ).toHaveLength(1);
    gate.resolve();
    await Promise.all([first, second]);
    await settle();
    expect(
      harness
        .callsSince(marks)
        .filter((call) => call.name === 'prompt' && call.serverID === 'local'),
    ).toHaveLength(1);
    harness.dispose();
  });

  test('navigating away during a prompt leaves the originating draft intact', async () => {
    const harness = await createHarness();
    harness.controller.openSession(harness.sessionID, 'local');
    await settle();
    const gate = deferred();
    const backend = harness.backend('local');
    const original = backend.prompt.bind(backend);
    backend.prompt = async (sessionID, draft) => {
      const result = await original(sessionID, draft);
      await gate.promise;
      return result;
    };
    harness.controller.setComposer(composerFrom('origin text'));
    const sent = harness.controller.submit();
    await settle(2);

    harness.controller.openSession(harness.sessionID, 'remote');
    await settle();
    harness.controller.setComposer(composerFrom('newer remote text'));
    gate.resolve();
    await sent;
    await settle();

    harness.controller.openSession(harness.sessionID, 'local');
    await settle();
    expect(harness.controller.state.composer.text).toBe('origin text');
    harness.dispose();
  });
});
