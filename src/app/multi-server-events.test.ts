import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { BackendError, type PromptDraft } from '../adapter/backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import { composerFrom } from '../domain/composer.ts';
import type { SessionSummary } from '../domain/session.ts';
import { AppController } from './controller.ts';

const localID = 'local';
const remoteID = 'srv_1';
const sessionID = 'ses_same';

function session(serverID: string): SessionSummary {
  return {
    id: sessionID,
    serverID,
    projectID: 'p',
    directory: '/work/lotus',
    createdAt: 0,
    updatedAt: 1,
    archived: false,
  };
}

function permission(action: string) {
  return {
    id: 'per_same',
    sessionID,
    action,
    resources: [],
    save: [],
  };
}

function form(serverID: string) {
  return {
    id: 'form_same',
    sessionID,
    title: `form-${serverID}`,
    fields: [],
  };
}

function userMessage(id: string, text: string) {
  return { kind: 'user', id, createdAt: 1, text, attachments: [] } as const;
}

function harness() {
  const local = new FakeBackend();
  const remote = new FakeBackend();
  local.serverID = localID;
  remote.serverID = remoteID;
  local.sessions = [session(localID)];
  remote.sessions = [session(remoteID)];
  local.permissions = [permission('local-act')];
  remote.permissions = [permission('remote-act')];
  local.forms = [form('local')];
  remote.forms = [form('remote')];
  local.goals = {
    [sessionID]: {
      id: 'goal_local',
      objective: 'local goal',
      status: 'active',
      rounds: 1,
      maxRounds: 10,
    },
  };
  remote.goals = {
    [sessionID]: {
      id: 'goal_remote',
      objective: 'remote goal',
      status: 'active',
      rounds: 2,
      maxRounds: 10,
    },
  };
  // Count listSessions per host without touching FakeBackend's default behavior.
  const counters = { localList: 0, remoteList: 0, localGet: 0, remoteGet: 0 };
  local.listSessionsHook = async () => {
    counters.localList += 1;
    return { sessions: local.sessions };
  };
  remote.listSessionsHook = async () => {
    counters.remoteList += 1;
    return { sessions: remote.sessions };
  };
  const realLocalGet = local.getSession.bind(local);
  local.getSession = async (id: string) => {
    counters.localGet += 1;
    return realLocalGet(id);
  };
  const realRemoteGet = remote.getSession.bind(remote);
  remote.getSession = async (id: string) => {
    counters.remoteGet += 1;
    return realRemoteGet(id);
  };
  const controller = new AppController({
    backend: local,
    backendFor: (serverID: string) => (serverID === remoteID ? remote : local),
    serverIDs: () => [localID, remoteID],
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/lotus',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    requestExit: () => {},
  });
  return { controller, local, remote, counters };
}

async function flush(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
}

const remoteKey = `server:${remoteID}/session:${sessionID}`;

/** Both hosts own `ses_same`; each gets its own queued item under its own key. */
function viewHarness() {
  const { controller, local, remote } = harness();
  local.inbox = [
    { id: 'in_same', kind: 'user', delivery: 'queue', text: 'local queued', createdAt: 1 },
  ];
  local.inboxSession = { in_same: sessionID };
  remote.inbox = [
    { id: 'in_same', kind: 'user', delivery: 'queue', text: 'remote queued', createdAt: 2 },
    { id: 'in_extra', kind: 'user', delivery: 'queue', text: 'remote extra', createdAt: 3 },
  ];
  remote.inboxSession = { in_same: sessionID, in_extra: sessionID };
  return { controller, local, remote };
}

describe('server identity through SSE events (issue #63)', () => {
  test('B-only events while A is selected never touch A’s rows, transcript or badge', async () => {
    const { controller, local, remote, counters } = harness();
    local.messages = { [sessionID]: [userMessage('m_local', 'local text')] };
    remote.messages = { [sessionID]: [userMessage('m_remote', 'remote text')] };
    await controller.bootstrap();
    controller.openSession(sessionID, localID);
    await flush();
    const localGet = counters.localGet;
    const remoteGet = counters.remoteGet;
    expect(controller.state.transcripts[sessionID]?.messages.map((m) => m.id)).toEqual(['m_local']);

    // B emits execution, input-request, goal and transcript events for the same IDs.
    controller.onEvents(
      remoteID,
      [
        { kind: 'execution', sessionID, state: 'started' },
        { kind: 'input-requests-changed', sessionID },
        {
          kind: 'goal-changed',
          sessionID,
          goal: { id: 'goal_b', objective: 'b goal', status: 'active', rounds: 1, maxRounds: 5 },
        },
        { kind: 'transcript-changed', sessionID },
        { kind: 'session-changed', sessionID },
      ],
      false,
    );
    // The debounced summary refresh fires after 150ms; let it land.
    await Bun.sleep(200);
    await flush();

    // Execution: only the remote row flips running.
    expect(controller.state.running[remoteKey]).toBe(true);
    expect(controller.state.running[sessionID]).not.toBe(true);
    // Input requests: only the remote prompt/form maps are refreshed from the remote host.
    expect(controller.state.permissions[remoteKey]?.map((p) => p.action)).toEqual(['remote-act']);
    expect(controller.state.forms[remoteKey]?.map((f) => f.id)).toEqual(['form_same']);
    expect(controller.state.permissions[sessionID]?.map((p) => p.action)).toEqual(['local-act']);
    expect(controller.state.forms[sessionID]?.map((f) => f.id)).toEqual(['form_same']);
    // Goal: the remote reading landed under the remote key only.
    expect(controller.state.nativeGoals[remoteKey]).toMatchObject({
      status: 'verified',
      goal: { id: 'goal_b' },
    });
    expect(controller.state.nativeGoals[sessionID]).toMatchObject({
      status: 'verified',
      goal: { id: 'goal_local' },
    });
    // Transcript: the attached local transcript is untouched, not marked stale.
    expect(controller.state.transcripts[sessionID]?.stale).not.toBe(true);
    expect(controller.state.transcripts[remoteKey]).toBeUndefined();
    // Summary refresh came from the remote backend only.
    expect(counters.remoteGet).toBe(remoteGet + 1);
    expect(counters.localGet).toBe(localGet);
    // The launch badge is not driven by a remote stream.
    expect(controller.state.stream).not.toBe('reconnecting');
    controller.dispose();
  });

  test('an A-only execution while B is attached marks A stale and leaves B alone', async () => {
    const { controller, local, remote, counters } = harness();
    local.messages = { [sessionID]: [userMessage('m_local', 'local text')] };
    remote.messages = { [sessionID]: [userMessage('m_remote', 'remote text')] };
    await controller.bootstrap();
    // A gets attached first so its transcript cache exists, then B is opened.
    controller.openSession(sessionID, localID);
    await flush();
    controller.openSession(sessionID, remoteID);
    await flush();
    expect(controller.state.transcripts[sessionID]?.stale).not.toBe(true);
    const remoteGet = counters.remoteGet;
    let localPermissionCalls = 0;
    const realListPermissions = local.listPermissions.bind(local);
    local.listPermissions = async (id: string) => {
      localPermissionCalls += 1;
      return realListPermissions(id);
    };
    let remotePermissionCalls = 0;
    const realRemotePermissions = remote.listPermissions.bind(remote);
    remote.listPermissions = async (id: string) => {
      remotePermissionCalls += 1;
      return realRemotePermissions(id);
    };

    controller.onEvents(localID, [{ kind: 'execution', sessionID, state: 'started' }], false);
    controller.onEvents(localID, [{ kind: 'transcript-changed', sessionID }], false);
    controller.onEvents(localID, [{ kind: 'input-requests-changed', sessionID }], false);
    await flush();

    expect(controller.state.running[sessionID]).toBe(true);
    expect(controller.state.running[remoteKey]).not.toBe(true);
    // A's cached transcript got marked stale; B's attached transcript is untouched.
    expect(controller.state.transcripts[sessionID]?.stale).toBe(true);
    expect(controller.state.transcripts[remoteKey]?.stale).not.toBe(true);
    // A's permission refresh came from the local host; the remote was not asked.
    expect(localPermissionCalls).toBeGreaterThan(0);
    expect(remote.calls.filter((call) => call.name === 'listPermissions').length).toBe(
      remotePermissionCalls,
    );
    expect(counters.remoteGet).toBe(remoteGet);
    controller.dispose();
  });

  test('a session-deleted event from B removes only B’s colliding row', async () => {
    const { controller } = harness();
    await controller.bootstrap();
    controller.openSession(sessionID, localID);
    await flush();

    controller.onEvents(remoteID, [{ kind: 'session-deleted', sessionID }], false);
    await flush();

    expect(controller.state.sessions[remoteKey]).toBeUndefined();
    expect(controller.state.sessions[sessionID]).toBeDefined();
    expect(controller.state.route).toEqual({ kind: 'conversation', serverID: localID, sessionID });
    controller.dispose();
  });

  test('a B reconnect resyncs B only; A does not reload and stays fresh', async () => {
    const { controller, local, remote, counters } = harness();
    local.messages = { [sessionID]: [userMessage('m_local', 'local text')] };
    remote.messages = { [sessionID]: [userMessage('m_remote', 'remote text')] };
    local.active = new Set([sessionID]);
    await controller.bootstrap();
    controller.openSession(sessionID, localID);
    await flush();
    const before = { ...counters };

    controller.onEvents(remoteID, [], true);
    await flush();
    await flush();

    // B reloaded once more; A did not hit the network at all.
    expect(counters.localList).toBe(before.localList);
    expect(counters.localGet).toBe(before.localGet);
    expect(counters.remoteList).toBe(before.remoteList + 1);
    // A's rows, transcript and running badge survived the remote reconnect untouched.
    expect(controller.state.sessions[sessionID]).toBeDefined();
    expect(controller.state.transcripts[sessionID]?.stale).not.toBe(true);
    expect(controller.state.running[sessionID]).toBe(true);
    expect(controller.state.stream).not.toBe('reconnecting');
    controller.dispose();
  });

  test('a B reconnect while attached on B refetches B’s conversation and marks nothing stale', async () => {
    const { controller, local, remote } = harness();
    local.messages = { [sessionID]: [userMessage('m_local', 'local text')] };
    remote.messages = { [sessionID]: [userMessage('m_remote', 'remote text')] };
    await controller.bootstrap();
    controller.openSession(sessionID, remoteID);
    await flush();
    const localMessageCalls = local.calls.filter((call) => call.name === 'listMessages').length;
    const remoteMessageCalls = remote.calls.filter((call) => call.name === 'listMessages').length;

    controller.onEvents(remoteID, [], true);
    await flush();
    await flush();

    expect(local.calls.filter((call) => call.name === 'listMessages').length).toBe(
      localMessageCalls,
    );
    expect(remote.calls.filter((call) => call.name === 'listMessages').length).toBe(
      remoteMessageCalls + 1,
    );
    expect(controller.state.transcripts[remoteKey]?.stale).not.toBe(true);
    controller.dispose();
  });

  test('a goal push from B for a colliding ID wins only on B’s key, whichever side is open', async () => {
    const { controller, counters } = harness();
    await controller.bootstrap();
    // A attached first: the local reading lands on the bare key.
    controller.openSession(sessionID, localID);
    await flush();
    expect(controller.state.nativeGoals[sessionID]).toMatchObject({
      status: 'verified',
      goal: { id: 'goal_local' },
    });

    controller.onEvents(
      remoteID,
      [
        {
          kind: 'goal-changed',
          sessionID,
          goal: { id: 'goal_b', objective: 'b', status: 'complete', rounds: 3, maxRounds: 5 },
        },
      ],
      false,
    );
    await flush();
    expect(controller.state.nativeGoals[remoteKey]).toMatchObject({
      status: 'verified',
      goal: { id: 'goal_b', status: 'complete' },
    });
    // The attached A view still shows the local goal; nothing from B leaked into it.
    expect(controller.state.nativeGoals[sessionID]).toMatchObject({
      status: 'verified',
      goal: { id: 'goal_local' },
    });
    expect(counters.remoteGet).toBe(0); // push only; no getGoal round-trip needed
    controller.dispose();
  });
});

describe('qualified state keys (issue #64)', () => {
  test('interleaved A/B traffic, then delete only B: A survives whole, with no raw keys', async () => {
    const { controller, local, remote } = harness();
    // Different transcripts, goals, permissions, forms and running state per host.
    remote.permissions = [];
    remote.forms = [];
    local.messages = { [sessionID]: [userMessage('m_local', 'A text')] };
    remote.messages = { [sessionID]: [userMessage('m_remote', 'B text')] };
    local.active = new Set([sessionID]);
    remote.active = new Set([sessionID]);

    await controller.bootstrap();

    // Open both repeatedly, alternating.
    for (const serverID of [localID, remoteID, localID, remoteID] as const) {
      controller.openSession(sessionID, serverID);
      await flush();
    }
    expect(controller.state.transcripts[sessionID]?.messages.map((message) => message.id)).toEqual([
      'm_local',
    ]);
    expect(controller.state.transcripts[remoteKey]?.messages.map((message) => message.id)).toEqual([
      'm_remote',
    ]);
    // Statuses classify independently per host.
    const localSummary = controller.state.sessions[sessionID];
    const remoteSummary = controller.state.sessions[remoteKey];
    if (localSummary === undefined || remoteSummary === undefined)
      throw new Error('expected both summaries to be cached');
    expect(controller.statusOf(localSummary)).toBe('needs-input');
    expect(controller.statusOf(remoteSummary)).toBe('working');

    // Interleave events from both hosts.
    controller.onEvents(remoteID, [{ kind: 'execution', sessionID, state: 'started' }], false);
    controller.onEvents(localID, [{ kind: 'input-requests-changed', sessionID }], false);
    controller.onEvents(localID, [{ kind: 'execution', sessionID, state: 'succeeded' }], false);
    controller.onEvents(remoteID, [{ kind: 'transcript-changed', sessionID }], false);
    controller.onEvents(localID, [{ kind: 'session-changed', sessionID }], false);
    await Bun.sleep(200);
    await flush();

    expect(controller.state.running[remoteKey]).toBe(true);
    expect(controller.state.running[sessionID]).not.toBe(true);

    // Attach A and delete only B.
    controller.openSession(sessionID, localID);
    await flush();
    controller.onEvents(remoteID, [{ kind: 'session-deleted', sessionID }], false);
    await flush();

    // A keeps every trace: row, transcript, goal, permission, form, route.
    expect(controller.state.route).toEqual({ kind: 'conversation', serverID: localID, sessionID });
    expect(controller.state.sessions[sessionID]).toBeDefined();
    expect(controller.state.transcripts[sessionID]?.messages.map((message) => message.id)).toEqual([
      'm_local',
    ]);
    expect(controller.state.nativeGoals[sessionID]).toMatchObject({
      status: 'verified',
      goal: { id: 'goal_local' },
    });
    expect(controller.state.permissions[sessionID]?.map((prompt) => prompt.action)).toEqual([
      'local-act',
    ]);
    expect(controller.state.forms[sessionID]).toHaveLength(1);

    // B left nothing behind in any state map.
    expect(controller.state.sessions[remoteKey]).toBeUndefined();
    expect(controller.state.transcripts[remoteKey]).toBeUndefined();
    expect(controller.state.nativeGoals[remoteKey]).toBeUndefined();
    expect(controller.state.permissions[remoteKey]).toBeUndefined();
    expect(controller.state.forms[remoteKey]).toBeUndefined();
    expect(controller.state.running[remoteKey]).toBeUndefined();
    expect(controller.state.openedAt[remoteKey]).toBeUndefined();
    expect(controller.state.inbox[remoteKey]).toBeUndefined();
    expect(controller.state.awaitingSteer[remoteKey]).toBeUndefined();

    // No orphan raw-key entries anywhere: only A's bare key carries the ID now.
    const qualifying = (map: Record<string, unknown>) =>
      Object.keys(map)
        .filter((key) => key.includes(sessionID))
        .toSorted();
    expect(qualifying(controller.state.sessions)).toEqual([sessionID]);
    expect(qualifying(controller.state.transcripts)).toEqual([sessionID]);
    expect(qualifying(controller.state.nativeGoals)).toEqual([sessionID]);
    expect(qualifying(controller.state.permissions)).toEqual([sessionID]);
    expect(qualifying(controller.state.forms)).toEqual([sessionID]);
    expect(qualifying(controller.state.inbox)).toEqual([sessionID]);
    controller.dispose();
  });

  test('remote transcript pages, goals and expansion never fall back to bare keys', async () => {
    const { controller, remote } = harness();
    remote.messages = { [sessionID]: [userMessage('m_remote', 'B text')] };
    await controller.bootstrap();

    controller.openSession(sessionID, remoteID);
    await flush();

    // Every byte of remote state lives under the qualified key.
    expect(controller.state.transcripts[sessionID]).toBeUndefined();
    expect(controller.state.transcripts[remoteKey]?.messages[0]?.id).toBe('m_remote');
    controller.toggleGroup('group:t9');
    expect(Object.keys(controller.state.expandedGroups)).toEqual([`${remoteKey} group:t9`]);
    controller.toggleGroup('group:t9');
    expect(controller.state.expandedGroups[`${remoteKey} group:t9`]).toBeUndefined();

    // Opening the same ID on the local side never sees the remote bytes.
    controller.openSession(sessionID, localID);
    await flush();
    expect(controller.state.transcripts[sessionID]?.messages.map((m) => m.id)).not.toContain(
      'm_remote',
    );
    controller.dispose();
  });
});

describe('server-qualified conversation views (issue #78)', () => {
  test('queue, goal, steer intent and execution differ per host for a colliding id', async () => {
    const { controller } = viewHarness();
    await controller.bootstrap();

    controller.openSession(sessionID, localID);
    await flush();
    const localView = controller.currentView();
    expect(localView?.serverID).toBe(localID);
    expect(localView?.key).toBe(sessionID);
    expect(localView?.queued.map((item) => item.text)).toEqual(['local queued']);
    expect(localView?.nativeGoal?.status).toBe('verified');

    controller.openSession(sessionID, remoteID);
    await flush();
    const remoteView = controller.currentView();
    expect(remoteView?.serverID).toBe(remoteID);
    expect(remoteView?.key).toBe(remoteKey);
    expect(remoteView?.queued.map((item) => item.text)).toEqual(['remote queued', 'remote extra']);
    // The goal reading follows the selected host, not the launch one.
    const remoteGoal = remoteView?.nativeGoal;
    expect(remoteGoal?.status === 'verified' ? remoteGoal.goal.id : undefined).toBe('goal_remote');

    // Switching back restores A's view verbatim: no cross-host bleed.
    controller.openSession(sessionID, localID);
    await flush();
    expect(controller.currentView()?.queued.map((item) => item.text)).toEqual(['local queued']);
    const localGoal = controller.currentView()?.nativeGoal;
    expect(localGoal?.status === 'verified' ? localGoal.goal.id : undefined).toBe('goal_local');

    controller.dispose();
  });

  test('queue cancellation and steering address only the displayed host', async () => {
    const { controller, local, remote } = viewHarness();
    await controller.bootstrap();
    // Both hosts carry the SAME inbox item ID, so a bare-id lookup would be ambiguous.
    controller.openSession(sessionID, localID);
    await flush();
    controller.openSession(sessionID, remoteID);
    await flush();

    await controller.cancelQueued('in_same');
    expect(remote.calls.filter((call) => call.name === 'cancelQueued')).toHaveLength(1);
    expect(local.calls.filter((call) => call.name === 'cancelQueued')).toHaveLength(0);
    // Neither host's queue leaked: A keeps its item, B's was consumed by the cancel.
    expect(controller.state.inbox[sessionID]?.map((item) => item.id)).toEqual(['in_same']);
    expect(controller.state.inbox[remoteKey]?.map((item) => item.id)).toEqual(['in_extra']);

    await controller.promoteQueued('in_extra');
    expect(remote.calls.filter((call) => call.name === 'changeDelivery')).toHaveLength(1);
    expect(local.calls.filter((call) => call.name === 'changeDelivery')).toHaveLength(0);

    // An item that belongs to the other host is never acted on from here.
    await controller.promoteQueued('not_queued_here');
    expect(remote.calls.filter((call) => call.name === 'changeDelivery')).toHaveLength(1);
    controller.dispose();
  });
});

/** A remote with no prompts/forms, so a busy turn reads as `working`, not `waiting`. */
function idleRemote() {
  const { controller, remote } = harness();
  remote.permissions = [];
  remote.forms = [];
  return { controller, remote };
}

describe('stale running flags clear on refresh (issue #80)', () => {
  test('a dropped completion is reconciled to idle; Enter is no longer implicitly queued', async () => {
    const { controller, remote } = idleRemote();
    remote.active = new Set([sessionID]);
    await controller.bootstrap();
    controller.openSession(sessionID, remoteID);
    await flush();
    // The host reports the session running: the snapshot says working.
    expect(controller.state.running[remoteKey]).toBe(true);
    expect(controller.currentView()?.execution.state).toBe('working');

    // The completion event is lost during a disconnect; the reconnect's complete active set
    // no longer contains it.
    remote.active = new Set<string>();
    controller.onEvents(remoteID, [], true);
    await flush();
    await flush();

    expect(controller.state.running[remoteKey]).toBeUndefined();
    expect(controller.currentView()?.execution.state).toBe('idle');
    // The dot is recomputed from the same execution selector, so it is idle too.
    const summary = controller.state.sessions[remoteKey];
    if (summary === undefined) throw new Error('expected the remote summary to be cached');
    expect(controller.statusOf(summary)).toBe('idle');

    // Enter is a plain prompt delivery now: no implicit queue/steer override.
    controller.setComposer(composerFrom('after recovery'));
    await controller.submit();
    const prompt = remote.calls.filter((call) => call.name === 'prompt').at(-1);
    expect(prompt?.args[1]).toMatchObject({ text: 'after recovery' });
    expect(prompt?.args[1]).not.toMatchObject({ delivery: defaultConfig.input.enterWhileRunning });
    controller.dispose();
  });

  test('a failed remote refresh preserves B’s cached status and never touches A', async () => {
    const { controller, local, remote } = harness();
    local.active = new Set([sessionID]);
    remote.active = new Set([sessionID]);
    await controller.bootstrap();
    expect(controller.state.running[sessionID]).toBe(true);
    expect(controller.state.running[remoteKey]).toBe(true);

    // B becomes unreachable: its listing throws, so its refresh proves nothing.
    let down = true;
    remote.listSessionsHook = async () => {
      if (down) throw new BackendError('transport', 'session.list', 'down');
      return { sessions: remote.sessions };
    };
    controller.onEvents(remoteID, [], true);
    await flush();
    await flush();

    // B keeps its cached running flag (nothing was proven idle), A is untouched.
    expect(controller.state.running[remoteKey]).toBe(true);
    expect(controller.state.running[sessionID]).toBe(true);

    // When B answers again with the real active set it converges.
    down = false;
    controller.onEvents(remoteID, [], true);
    await flush();
    await flush();
    expect(controller.state.running[remoteKey]).toBe(true);
    expect(controller.state.running[sessionID]).toBe(true);
    controller.dispose();
  });

  test('a snapshot never overwrites an execution event that arrived while it was in flight', async () => {
    const { controller, remote } = harness();
    remote.active = new Set<string>();
    await controller.bootstrap();
    expect(controller.state.running[remoteKey]).not.toBe(true);

    // The snapshot's active set is captured before the turn starts, then the event lands
    // before the (slow) listing resolves.
    const hold = Promise.withResolvers<void>();
    remote.listSessionsHook = async () => {
      await hold.promise;
      return { sessions: remote.sessions };
    };
    const refresh = controller.loadSessions(remoteID);
    controller.onEvents(remoteID, [{ kind: 'execution', sessionID, state: 'started' }], false);
    await flush();
    expect(controller.state.running[remoteKey]).toBe(true);
    hold.resolve();
    await refresh;
    await flush();

    // The stale snapshot said idle, but the newer event wins.
    expect(controller.state.running[remoteKey]).toBe(true);

    // The inverse: a completion event during a snapshot that still reports running.
    remote.active = new Set([sessionID]);
    const holdCompletion = Promise.withResolvers<void>();
    remote.listSessionsHook = async () => {
      await holdCompletion.promise;
      return { sessions: remote.sessions };
    };
    const second = controller.loadSessions(remoteID);
    controller.onEvents(remoteID, [{ kind: 'execution', sessionID, state: 'succeeded' }], false);
    await flush();
    expect(controller.state.running[remoteKey]).not.toBe(true);
    holdCompletion.resolve();
    await second;
    await flush();
    expect(controller.state.running[remoteKey]).not.toBe(true);
    controller.dispose();
  });

  test('paginated refresh reconciles the same active set as a full resync', async () => {
    const { controller, remote } = idleRemote();
    remote.active = new Set([sessionID]);
    // Always offers another page, so a full load stays incomplete and pagination applies.
    remote.listSessionsHook = async () => ({
      sessions: remote.sessions,
      nextCursor: 'more',
    });
    await controller.bootstrap();
    expect(controller.state.running[remoteKey]).toBe(true);
    expect(controller.state.serverPages[remoteID]?.complete).toBe(false);

    // A later page proves the session idle; the paginated path clears the flag too.
    remote.active = new Set<string>();
    await controller.loadMoreSessions();
    expect(controller.state.running[remoteKey]).toBeUndefined();
    controller.dispose();
  });
});

/** Both hosts own `ses_same`; B has a revert staged on the server already. */
function revertHarness() {
  const { controller, local, remote } = harness();
  local.messages = { [sessionID]: [userMessage('m_local', 'A text')] };
  remote.messages = { [sessionID]: [userMessage('m_remote', 'B text')] };
  remote.sessions = remote.sessions.map((entry) => ({
    ...entry,
    revert: { messageID: 'm_remote', files: [] },
  }));
  return { controller, local, remote };
}

describe('staged reverts are bound to their owning host (issue #82)', () => {
  test('a revert staged on B while A is foreground never hijacks A or mutates A', async () => {
    const { controller, local } = revertHarness();
    await controller.bootstrap();
    controller.openSession(sessionID, localID);
    await flush();
    expect(controller.state.overlay.kind).toBe('none');

    // B re-reports its stage; A is the foreground conversation.
    controller.onEvents(remoteID, [{ kind: 'revert-changed', sessionID, action: 'staged' }], false);
    await flush();
    await Bun.sleep(400); // the debounced summary refresh
    await flush();

    // No modal appears over A; A is not mutated.
    expect(controller.state.overlay.kind).toBe('none');
    expect(local.calls.filter((call) => call.name === 'commitRevert')).toHaveLength(0);
    expect(local.calls.filter((call) => call.name === 'clearRevert')).toHaveLength(0);
    // B's row carries the stage; A's does not.
    expect(controller.state.sessions[remoteKey]?.revert?.messageID).toBe('m_remote');
    expect(controller.state.sessions[sessionID]?.revert).toBeUndefined();
    // The user was not told about a dialog they cannot act on from here.
    expect(controller.state.notice?.text ?? '').not.toContain('revert was staged');
    controller.dispose();
  });

  test('switching into B makes its staged revert actionable; confirm hits only B', async () => {
    const { controller, local, remote } = revertHarness();
    await controller.bootstrap();
    controller.openSession(sessionID, localID);
    await flush();
    expect(controller.state.overlay.kind).toBe('none');

    controller.openSession(sessionID, remoteID);
    await flush();
    expect(controller.state.overlay).toMatchObject({
      kind: 'revert',
      serverID: remoteID,
      sessionID,
      messageID: 'm_remote',
    });

    controller.revertKey({ name: 'return' });
    await flush();

    expect(remote.calls.filter((call) => call.name === 'commitRevert')).toHaveLength(1);
    expect(local.calls.filter((call) => call.name === 'commitRevert')).toHaveLength(0);
    expect(local.calls.filter((call) => call.name === 'clearRevert')).toHaveLength(0);
    expect(controller.state.overlay.kind).toBe('none');
    controller.dispose();
  });

  test('cancel clears only the owning host’s stage', async () => {
    const { controller, local, remote } = revertHarness();
    await controller.bootstrap();
    controller.openSession(sessionID, remoteID);
    await flush();
    expect(controller.state.overlay).toMatchObject({ kind: 'revert', serverID: remoteID });

    controller.revertKey({ name: 'escape' });
    await flush();

    expect(remote.calls.filter((call) => call.name === 'clearRevert')).toHaveLength(1);
    expect(local.calls.filter((call) => call.name === 'clearRevert')).toHaveLength(0);
    expect(local.calls.filter((call) => call.name === 'commitRevert')).toHaveLength(0);
    controller.dispose();
  });

  test('leaving for A after the modal opened makes no key act on B’s hidden stage', async () => {
    const { controller, local, remote } = revertHarness();
    await controller.bootstrap();
    controller.openSession(sessionID, remoteID);
    await flush();
    expect(controller.state.overlay).toMatchObject({ kind: 'revert', serverID: remoteID });

    // The user navigates away without answering, then presses Enter on A.
    controller.openSession(sessionID, localID);
    await flush();
    controller.revertKey({ name: 'return' });
    await flush();

    // The hidden dialog dismissed itself; no host's stage was committed.
    expect(local.calls.filter((call) => call.name === 'commitRevert')).toHaveLength(0);
    expect(remote.calls.filter((call) => call.name === 'commitRevert')).toHaveLength(0);
    expect(controller.state.overlay.kind).toBe('none');
    controller.dispose();
  });

  test('a mid-flight commit targets B, and B’s summary is stamped under B’s key', async () => {
    const { controller, local, remote } = revertHarness();
    await controller.bootstrap();
    controller.openSession(sessionID, remoteID);
    await flush();
    expect(controller.state.overlay).toMatchObject({ kind: 'revert', serverID: remoteID });

    // The user answers Enter and immediately switches to A while the verify RPC is in flight.
    const hold = Promise.withResolvers<void>();
    const realGet = remote.getSession.bind(remote);
    remote.getSession = async (id: string) => {
      await hold.promise;
      return realGet(id);
    };
    controller.revertKey({ name: 'return' });
    controller.openSession(sessionID, localID);
    await flush();
    hold.resolve();
    await flush();

    expect(remote.calls.filter((call) => call.name === 'commitRevert')).toHaveLength(1);
    expect(local.calls.filter((call) => call.name === 'commitRevert')).toHaveLength(0);
    expect(local.calls.filter((call) => call.name === 'clearRevert')).toHaveLength(0);
    // The verified summary landed on B's key; A's row never gained the stage.
    expect(controller.state.sessions[remoteKey]?.serverID).toBe(remoteID);
    expect(controller.state.sessions[sessionID]?.revert).toBeUndefined();
    controller.dispose();
  });

  test('exiting with a stage open clears it on its owning host', async () => {
    const { controller, local, remote } = revertHarness();
    await controller.bootstrap();
    controller.openSession(sessionID, remoteID);
    await flush();
    expect(controller.state.overlay).toMatchObject({ kind: 'revert', serverID: remoteID });

    expect(await controller.flushRevertOnExit()).toBeUndefined();

    expect(remote.calls.filter((call) => call.name === 'clearRevert')).toHaveLength(1);
    expect(local.calls.filter((call) => call.name === 'clearRevert')).toHaveLength(0);
    expect(controller.state.overlay.kind).toBe('none');
    controller.dispose();
  });
});

function asyncRoutingHarness() {
  const local = new FakeBackend();
  const remote = new FakeBackend();
  local.serverID = localID;
  remote.serverID = remoteID;
  local.sessions = [session(localID)];
  remote.sessions = [session(remoteID)];
  // Hold the remote's prompt behind a gate so the test can navigate away while it is in flight.
  const held = Promise.withResolvers<void>();
  const realPrompt = remote.prompt.bind(remote);
  remote.prompt = async (id: string, draft: PromptDraft) => {
    await held.promise;
    return realPrompt(id, draft);
  };
  const controller = new AppController({
    backend: local,
    backendFor: (serverID: string) => (serverID === remoteID ? remote : local),
    serverIDs: () => [localID, remoteID],
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/lotus',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    requestExit: () => {},
  });
  return { controller, local, remote, held };
}

describe('async requests stay bound to their originating host (issue #86)', () => {
  test('submit on B, then navigating to A sends nothing to A and leaves A’s composer alone', async () => {
    const { controller, local, remote, held } = asyncRoutingHarness();
    await controller.bootstrap();
    controller.openSession(sessionID, remoteID);
    await flush();
    expect(controller.state.route).toEqual({
      kind: 'conversation',
      serverID: remoteID,
      sessionID,
    });

    controller.setComposer(composerFrom('hello from B'));
    const submitted = controller.submit();
    await flush(); // submit is blocked on the held remote.prompt
    expect(local.calls.filter((call) => call.name === 'prompt')).toHaveLength(0);
    expect(remote.calls.filter((call) => call.name === 'prompt')).toHaveLength(0);

    // Switch to A while B’s submit is in flight.
    controller.openSession(sessionID, localID);
    await flush();
    expect(controller.state.route).toMatchObject({ kind: 'conversation', serverID: localID });

    held.resolve();
    await submitted;
    await flush();

    // The prompt went only to B; A never received a request and A’s composer is untouched.
    expect(local.calls.filter((call) => call.name === 'prompt')).toHaveLength(0);
    expect(remote.calls.filter((call) => call.name === 'prompt')).toHaveLength(1);
    expect(controller.state.composer.text).toBe('');
    controller.dispose();
  });

  test('switching sessions on one host preserves the originating host and draft', async () => {
    const { controller, local, remote, held } = asyncRoutingHarness();
    remote.sessions = [session(remoteID), { ...session(remoteID), id: 'ses_b2' }];
    await controller.bootstrap();
    controller.openSession(sessionID, remoteID);
    await flush();
    controller.setComposer(composerFrom('on B1'));
    const submitted = controller.submit();
    await flush(); // blocked on held remote.prompt

    // Switch to B2 on the same host while B1’s submit is in flight.
    controller.openSession('ses_b2', remoteID);
    await flush();
    expect(controller.state.route).toMatchObject({ kind: 'conversation', sessionID: 'ses_b2' });

    held.resolve();
    await submitted;
    await flush();

    // The prompt went to B (the originating host), never to A.
    expect(local.calls.filter((call) => call.name === 'prompt')).toHaveLength(0);
    expect(remote.calls.filter((call) => call.name === 'prompt')).toHaveLength(1);
    // B2’s composer is untouched; B1’s draft was parked by the session switch, not wiped.
    expect(controller.state.composer.text).toBe('');
    controller.dispose();
  });

  test('a submit transport error on B does not touch A when navigating away', async () => {
    const { controller, local, remote, held } = asyncRoutingHarness();
    await controller.bootstrap();
    controller.openSession(sessionID, remoteID);
    await flush();
    controller.setComposer(composerFrom('hello from B'));
    remote.promptError = new BackendError('transport', 'prompt', 'boom');
    const submitted = controller.submit();
    await flush(); // blocked on the held (failing) remote.prompt

    controller.openSession(sessionID, localID);
    await flush();
    expect(controller.state.route).toMatchObject({ kind: 'conversation', serverID: localID });

    held.resolve();
    await submitted;
    await flush();

    // The failing request went only to B; A is untouched and B’s draft is not wiped into A.
    expect(local.calls.filter((call) => call.name === 'prompt')).toHaveLength(0);
    expect(remote.calls.filter((call) => call.name === 'prompt')).toHaveLength(1);
    expect(controller.state.composer.text).toBe('');
    controller.dispose();
  });
});

function reconcileHarness() {
  const local = new FakeBackend();
  const remote = new FakeBackend();
  local.serverID = localID;
  remote.serverID = remoteID;
  local.sessions = [session(localID)];
  remote.sessions = [session(remoteID)];
  // The remote's getSession is held behind a gate until the test releases it.
  const held = Promise.withResolvers<SessionSummary>();
  remote.getSession = async (id: string) => {
    await held.promise;
    return { ...session(remoteID), id };
  };
  const serverIDsList = [localID, remoteID];
  const controller = new AppController({
    backend: local,
    backendFor: (serverID: string) => (serverID === remoteID ? remote : local),
    serverIDs: () => [...serverIDsList],
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/lotus',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    requestExit: () => {},
  });
  return { controller, local, remote, held, serverIDsList };
}

describe('session refresh epochs are rechecked before committing (issue #85)', () => {
  test('a held reconciliation response loses to a newer refresh', async () => {
    const { controller, remote, held } = reconcileHarness();
    // Prime the cache: remote owns ses_same.
    await controller.loadSessions(remoteID);
    expect(controller.state.sessions[remoteKey]).toBeDefined();

    // Remote's next listing returns nothing, so the cached remote row is a reconcile miss
    // and getSession is held behind a gate. The old refresh blocks on it.
    remote.sessions = [];
    const old = controller.loadSessions(remoteID);
    await flush(); // let it reach the held reconciliation

    // A newer remote refresh lists the updated session and commits it.
    remote.sessions = [{ ...session(remoteID), title: 'newer' }];
    await controller.loadSessions(remoteID);
    await flush();
    expect(controller.state.sessions[remoteKey]?.title).toBe('newer');

    // Resolve the stale old getSession: it must not clobber the newer snapshot.
    held.resolve({ ...session(remoteID), title: 'stale' });
    await old;
    await flush();
    expect(controller.state.sessions[remoteKey]?.title).toBe('newer');
    expect(controller.state.sessions[sessionID]).toBeUndefined();
    controller.dispose();
  });

  test('unpairing the remote during reconciliation resurrects nothing', async () => {
    const { controller, remote, held, serverIDsList } = reconcileHarness();
    // Prime the cache with a distinguishable title.
    remote.sessions = [{ ...session(remoteID), title: 'primed' }];
    await controller.loadSessions(remoteID);
    expect(controller.state.sessions[remoteKey]?.title).toBe('primed');

    // Remote's next listing returns nothing, so the cached remote row is a reconcile miss
    // and getSession is held behind a gate.
    remote.sessions = [];
    const old = controller.loadSessions(remoteID);
    await flush(); // let it reach the held reconciliation

    // Unpair B mid-reconciliation: deregister it and drop its cached rows.
    const index = serverIDsList.indexOf(remoteID);
    expect(index).toBeGreaterThanOrEqual(0);
    serverIDsList.splice(index, 1);
    delete controller.state.sessions[remoteKey];
    delete controller.state.running[remoteKey];

    // Resolve the stale old getSession: it must not re-apply the stale row.
    held.resolve({ ...session(remoteID), id: sessionID, title: 'stale' });
    await old;
    await flush();

    // B's rows are not resurrected as stale and B is no longer a registered host.
    expect(controller.state.sessions[remoteKey]?.title).not.toBe('stale');
    expect(controller.state.running[remoteKey]).toBeUndefined();
    expect(serverIDsList).not.toContain(remoteID);
    controller.dispose();
  });
});
