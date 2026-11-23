import { describe, expect, test } from 'bun:test';

import { BackendError } from '../../src/adapter/backend.ts';
import { composerFrom } from '../../src/domain/composer.ts';
import type { FormRequest } from '../../src/domain/form.ts';
import { sessionKey } from '../../src/domain/server-identity.ts';
import type { SessionSummary } from '../../src/domain/session.ts';
import { assertNoCalls, collidingSession, createHarness, deferred, settle } from './harness.ts';
import { FakeScheduler } from './scheduler.ts';

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

  test('a successful prompt clears only its origin draft after a route change (#324)', async () => {
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
    expect(harness.controller.state.composer.text).toBe('');
    // The unrelated remote draft is not the acknowledgement's business.
    harness.controller.openSession(harness.sessionID, 'remote');
    await settle();
    expect(harness.controller.state.composer.text).toBe('newer remote text');
    harness.dispose();
  });

  test('a newer edit to the parked origin draft survives the acknowledgement (#324)', async () => {
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
    harness.controller.openSession(harness.sessionID, 'local');
    await settle();
    harness.controller.setComposer(composerFrom('newer local edit'));
    harness.controller.openSession(harness.sessionID, 'remote');
    await settle();
    gate.resolve();
    await sent;
    await settle();

    harness.controller.openSession(harness.sessionID, 'local');
    await settle();
    expect(harness.controller.state.composer.text).toBe('newer local edit');
    harness.dispose();
  });

  test('a same-route edit restored to the submitted text keeps its newer revision (#324)', async () => {
    const harness = await createHarness();
    harness.controller.openSession(harness.sessionID, 'local');
    await harness.settle();
    const gate = deferred();
    const backend = harness.backend('local');
    const original = backend.prompt.bind(backend);
    backend.prompt = async (sessionID, draft) => {
      const result = await original(sessionID, draft);
      await gate.promise;
      return result;
    };
    harness.controller.setComposer(composerFrom('submitted text'));
    const sent = harness.controller.submit();
    await harness.settle(2);

    // Edit away and back to the exact submitted string. Each write bumps the draft revision,
    // so a later acknowledgement must not treat this as the unchanged submitted draft.
    harness.controller.setComposer(composerFrom('newer text'));
    harness.controller.setComposer(composerFrom('submitted text'));
    gate.resolve();
    await sent;
    await harness.settle();

    // Text survives because the revision no longer matches the acknowledged origin.
    expect(harness.controller.state.composer.text).toBe('submitted text');
    // The newer edit history also survives: undo reaches the intermediate text.
    harness.controller.undo();
    expect(harness.controller.state.composer.text).toBe('newer text');
    harness.dispose();
  });

  test('an unchanged active-origin draft clears exactly once on acknowledgement (#324)', async () => {
    const harness = await createHarness();
    harness.controller.openSession(harness.sessionID, 'local');
    await harness.settle();
    harness.controller.setComposer(composerFrom('submitted text'));
    const sent = harness.controller.submit();
    await sent;
    await harness.settle();
    expect(harness.controller.state.composer.text).toBe('');
    harness.dispose();
  });
});

describe('time-driven behavior under an injected scheduler (#326)', () => {
  test('a transcript backoff retry fires only when virtual time is advanced', async () => {
    const harness = await createHarness();
    harness.controller.openSession(harness.sessionID, 'local');
    await harness.settle();
    const backend = harness.backend('local');
    const real = backend.listMessages.bind(backend);
    let attempts = 0;
    backend.listMessages = async (...args) => {
      attempts += 1;
      if (attempts === 1) throw new BackendError('transport', 'message.list', 'offline');
      return real(...args);
    };

    harness.emit('local', [{ kind: 'transcript-changed', sessionID: harness.sessionID }], false);
    await harness.settle();
    const key = harness.sessionID;
    expect(attempts).toBe(1);
    expect(harness.controller.state.transcripts[key]?.stale).toBe(true);
    expect(harness.scheduler.pendingCount()).toBeGreaterThan(0);

    harness.scheduler.advanceBy(1);
    await harness.settle();
    expect(attempts).toBe(2);
    expect(harness.controller.state.transcripts[key]?.stale).toBe(false);
    harness.dispose();
  });

  test('an ancestry deadline expires only when virtual time reaches it', async () => {
    const scheduler = new FakeScheduler();
    const harness = await createHarness({ scheduler });
    const backend = harness.backend('local');
    const childForm: FormRequest = {
      id: 'form_child',
      sessionID: 'ses_child',
      title: 'child question',
      fields: [
        { kind: 'text', key: 'answer', title: 'Answer', required: false, hidden: false, when: [] },
      ],
    };
    backend.forms = [childForm];
    const realGet = backend.getSession.bind(backend);
    backend.getSession = async (sessionID) => {
      if (sessionID === 'ses_child') return new Promise<SessionSummary>(() => {});
      return realGet(sessionID);
    };

    harness.controller.openSession(harness.sessionID, 'local');
    await harness.settle();
    expect(harness.controller.state.forms[harness.sessionID] ?? []).toHaveLength(0);

    const start = scheduler.now();
    scheduler.advanceBy(49);
    await harness.settle();
    expect(harness.controller.currentRequestError()?.forms).toBeUndefined();
    scheduler.advanceBy(1);
    // The timeout resolves the verifier; its second publication batch needs a longer
    // microtask drain before the observable store write lands.
    await harness.settle(20);
    expect(harness.controller.currentRequestError()?.forms).toContain('timed out');
    expect(scheduler.now()).toBe(start + 50);
    harness.dispose();
  });

  test('dispose cancels every timer the controller still owns', async () => {
    const harness = await createHarness();
    harness.controller.showNotice('still on screen', 'dim');
    expect(harness.scheduler.pendingCount()).toBeGreaterThan(0);
    harness.dispose();
    expect(harness.scheduler.pendingCount()).toBe(0);
  });

  test('a pending summary coalescing timer is cancelled on dispose (#326)', async () => {
    const harness = await createHarness();
    harness.controller.openSession(harness.sessionID, 'local');
    await harness.settle();
    const before = harness.scheduler.pendingCount();
    // session-changed schedules a debounced summary refresh through the injected scheduler.
    harness.emit('local', [{ kind: 'session-changed', sessionID: harness.sessionID }], false);
    await harness.settle();
    expect(harness.scheduler.pendingCount()).toBeGreaterThan(before);
    harness.dispose();
    expect(harness.scheduler.pendingCount()).toBe(0);
  });

  test('a pending summary timer for a deleted lifetime cannot fire after teardown (#326)', async () => {
    const harness = await createHarness();
    harness.controller.openSession(harness.sessionID, 'local');
    await harness.settle();
    harness.emit('local', [{ kind: 'session-changed', sessionID: harness.sessionID }], false);
    await harness.settle();
    expect(harness.scheduler.pendingCount()).toBeGreaterThan(0);

    // Deleting the session retires its owned summary timer, so advancing past its due time
    // must not issue a stale getSession RPC (refreshSummary calls the backend before its
    // own epoch check) or write a page for a replacement lifetime (#326, #333).
    const marks = harness.marks();
    harness.emit('local', [{ kind: 'session-deleted', sessionID: harness.sessionID }], false);
    await harness.settle();
    harness.scheduler.advanceBy(1000);
    await harness.settle();
    assertNoCalls(
      harness.callsSince(marks),
      (call) => call.name === 'getSession',
      'deleted summary timer',
    );
    harness.dispose();
  });

  test('a deleted lifetime cannot run its deferred dirty follow-up (#333)', async () => {
    const harness = await createHarness();
    harness.controller.openSession(harness.sessionID, 'local');
    await harness.settle();
    const backend = harness.backend('local');
    const gate = deferred<Awaited<ReturnType<typeof backend.listMessages>>>();
    // Count explicitly: a FakeBackend method override does not record calls, so callsSince()
    // cannot observe a read held open by this override.
    let heldCalls = 0;
    backend.listMessages = () => {
      heldCalls += 1;
      return gate.promise;
    };

    // Two hints while the first read is held: the second coalesces into a dirty follow-up.
    harness.emit('local', [{ kind: 'transcript-changed', sessionID: harness.sessionID }], false);
    await harness.settle();
    harness.emit('local', [{ kind: 'transcript-changed', sessionID: harness.sessionID }], false);
    await harness.settle();
    gate.resolve({ messages: [] });
    await harness.settle();
    const afterRead = heldCalls;
    // The read settled but its 80ms follow-up is now owned by a tracked, cancellable timer.
    expect(harness.scheduler.pendingCount()).toBeGreaterThan(0);

    // Delete the session while the follow-up is held, then advance past its due time.
    harness.emit('local', [{ kind: 'session-deleted', sessionID: harness.sessionID }], false);
    await harness.settle();
    harness.scheduler.advanceBy(200);
    await harness.settle();
    expect(heldCalls).toBe(afterRead);
    harness.dispose();
  });

  test('dispose settles a pending dirty-follow-up so its awaiter does not hang (#333)', async () => {
    const harness = await createHarness();
    harness.controller.openSession(harness.sessionID, 'local');
    await harness.settle();
    const backend = harness.backend('local');
    const gate = deferred<Awaited<ReturnType<typeof backend.listMessages>>>();
    backend.listMessages = () => gate.promise;

    harness.emit('local', [{ kind: 'transcript-changed', sessionID: harness.sessionID }], false);
    await harness.settle();
    harness.emit('local', [{ kind: 'transcript-changed', sessionID: harness.sessionID }], false);
    await harness.settle();
    gate.resolve({ messages: [] });
    await harness.settle();
    expect(harness.scheduler.pendingCount()).toBeGreaterThan(0);

    harness.dispose();
    expect(harness.scheduler.pendingCount()).toBe(0);
    harness.scheduler.advanceBy(200);
    await harness.settle();
    expect(backend.calls.filter((call) => call.name === 'listMessages')).toHaveLength(1);
  });
});

describe('partial session index failures (#341)', () => {
  test('a failed activity read keeps discovered sessions and last-known running state', async () => {
    const harness = await createHarness();
    harness.emit(
      'local',
      [{ kind: 'execution', sessionID: harness.sessionID, state: 'started' }],
      false,
    );
    await harness.settle();
    const runningKey = sessionKey({ serverID: 'local', sessionID: harness.sessionID });
    expect(harness.controller.state.running[runningKey]).toBe(true);

    // Discover a new session, then fail only the activity capability.
    harness.backend('local').sessions.push(collidingSession('local', 'ses_new', 'new session'));
    harness.backend('local').activeSessionIDs = async () => {
      throw new BackendError('transport', 'session.active', 'activity offline');
    };

    await harness.controller.loadSessions();
    await harness.settle();

    // The list and cursor survive; the activity failure is not a session-list failure.
    expect(
      harness.controller.state.sessions[sessionKey({ serverID: 'local', sessionID: 'ses_new' })]
        ?.title,
    ).toBe('new session');
    expect(harness.controller.state.serverPages['local']?.error).toBeUndefined();
    // Running evidence is stale/unknown, never "every session stopped" (#341).
    expect(harness.controller.state.running[runningKey]).toBe(true);
    harness.dispose();
  });

  test('one host’s failed activity read does not stale another host’s running evidence', async () => {
    const harness = await createHarness();
    harness.emit(
      'local',
      [{ kind: 'execution', sessionID: harness.sessionID, state: 'started' }],
      false,
    );
    harness.emit(
      'remote',
      [{ kind: 'execution', sessionID: harness.sessionID, state: 'started' }],
      false,
    );
    await harness.settle();
    const localKey = sessionKey({ serverID: 'local', sessionID: harness.sessionID });
    const remoteKey = sessionKey({ serverID: 'remote', sessionID: harness.sessionID });
    expect(harness.controller.state.running[localKey]).toBe(true);
    expect(harness.controller.state.running[remoteKey]).toBe(true);

    // Identical raw session IDs: only the local host's activity endpoint fails.
    harness.backend('local').activeSessionIDs = async () => {
      throw new BackendError('transport', 'session.active', 'activity offline');
    };
    // Remote activity succeeds with an empty set, so its older turn becomes idle.
    await harness.controller.loadSessions();
    await harness.settle();

    expect(harness.controller.state.running[localKey]).toBe(true);
    expect(harness.controller.state.running[remoteKey]).toBeUndefined();
    harness.dispose();
  });

  test('a bounded activity-only retry recovers without refetching the session list', async () => {
    const harness = await createHarness();
    harness.emit(
      'local',
      [{ kind: 'execution', sessionID: harness.sessionID, state: 'started' }],
      false,
    );
    await harness.settle();
    const runningKey = sessionKey({ serverID: 'local', sessionID: harness.sessionID });
    const backend = harness.backend('local');
    let listCalls = 0;
    const originalList = backend.listSessions.bind(backend);
    backend.listSessions = async (query) => {
      listCalls += 1;
      return originalList(query);
    };
    let activityCalls = 0;
    backend.activeSessionIDs = async () => {
      activityCalls += 1;
      if (activityCalls === 1) throw new BackendError('transport', 'session.active', 'offline');
      return new Set();
    };

    await harness.controller.loadSessions();
    await harness.settle();
    const afterLoad = listCalls;
    expect(activityCalls).toBe(1);
    expect(harness.controller.state.running[runningKey]).toBe(true);

    // Advance past the 250 ms retry: only activity is re-read, never the whole list.
    harness.scheduler.advanceBy(300);
    await harness.settle();
    expect(activityCalls).toBe(2);
    expect(listCalls).toBe(afterLoad);
    expect(harness.controller.state.running[runningKey]).toBeUndefined();
    harness.dispose();
  });

  test('a list failure with activity succeeding preserves cached sessions and the error', async () => {
    const harness = await createHarness();
    const sessionKeyLocal = sessionKey({ serverID: 'local', sessionID: harness.sessionID });
    harness.emit(
      'local',
      [{ kind: 'execution', sessionID: harness.sessionID, state: 'started' }],
      false,
    );
    await harness.settle();
    expect(harness.controller.state.sessions[sessionKeyLocal]).toBeDefined();

    harness.backend('local').listSessions = async () => {
      throw new BackendError('transport', 'session.list', 'list offline');
    };
    await harness.controller.loadSessions();
    await harness.settle();

    // No fabricated rows, the previously confirmed session survives, and the listing error
    // remains visible while running evidence is left alone (#341 trap 2).
    expect(harness.controller.state.sessions[sessionKeyLocal]).toBeDefined();
    expect(harness.controller.state.serverPages['local']?.error).toContain('list offline');
    expect(harness.controller.state.running[sessionKeyLocal]).toBe(true);
    harness.dispose();
  });

  test('a failed second page is a host failure, not a partial list published as complete', async () => {
    const harness = await createHarness();
    harness.backend('local').listSessions = async (query) => {
      if (query?.cursor === undefined)
        return {
          sessions: [collidingSession('local', 'ses_page1', 'page one')],
          nextCursor: 'page-2',
        };
      throw new BackendError('transport', 'session.list', 'page 2 offline');
    };

    await harness.controller.loadSessions();
    await harness.settle();

    // The incomplete listing is not committed; the prior host failure/empty page stays visible.
    expect(
      harness.controller.state.sessions[sessionKey({ serverID: 'local', sessionID: 'ses_page1' })],
    ).toBeUndefined();
    expect(harness.controller.state.serverPages['local']?.error).toContain('page 2 offline');
    harness.dispose();
  });

  test('an SSE execution newer than a slow activity snapshot wins over its empty set', async () => {
    const harness = await createHarness();
    const backend = harness.backend('local');
    const gate = deferred<Set<string>>();
    backend.activeSessionIDs = () => gate.promise;

    const load = harness.controller.loadSessions();
    await harness.settle();
    // Stamp a running turn after the snapshot boundary but before activity resolves.
    harness.emit(
      'local',
      [{ kind: 'execution', sessionID: harness.sessionID, state: 'started' }],
      false,
    );
    await harness.settle();
    gate.resolve(new Set());
    await load;
    await harness.settle();

    // reconcileRunning refuses to clear a flag newer than its snapshot (#341 trap 3).
    expect(
      harness.controller.state.running[
        sessionKey({ serverID: 'local', sessionID: harness.sessionID })
      ],
    ).toBe(true);
    harness.dispose();
  });

  test('dispose cancels a pending activity retry so no stale running flags are published', async () => {
    const harness = await createHarness();
    harness.backend('local').activeSessionIDs = async () => {
      throw new BackendError('transport', 'session.active', 'offline');
    };
    await harness.controller.loadSessions();
    await harness.settle();
    expect(harness.scheduler.pendingCount()).toBeGreaterThan(0);

    harness.dispose();
    expect(harness.scheduler.pendingCount()).toBe(0);
  });
});
