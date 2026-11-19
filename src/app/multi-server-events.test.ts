import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
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
  for (let round = 0; round < 10; round += 1) await Bun.sleep(0);
}

const remoteKey = `server:${remoteID}/session:${sessionID}`;

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
