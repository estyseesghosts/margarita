import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import { composerFrom } from '../domain/composer.ts';
import { buildKeymap } from '../domain/keymap.ts';
import type { SessionSummary } from '../domain/session.ts';
import { AppController } from './controller.ts';
import { routeKey } from './key-router.ts';

function session(id: string, serverID: string, directory: string): SessionSummary {
  return {
    id,
    serverID,
    projectID: 'p',
    directory,
    createdAt: 0,
    updatedAt: 1,
    archived: false,
  };
}

function harness() {
  const local = new FakeBackend();
  const remote = new FakeBackend();
  local.serverID = 'local';
  remote.serverID = 'srv_1';
  local.sessions = [session('ses_a', 'local', '/work/lotus')];
  remote.sessions = [session('ses_a', 'srv_1', '/work/lotus')];
  const controller = new AppController({
    backend: local,
    backendFor: (serverID: string) => (serverID === 'srv_1' ? remote : local),
    serverIDs: () => ['local', 'srv_1'],
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
  return { controller, local, remote };
}

describe('cross-server aggregation', () => {
  test('identical session IDs and directories become separate projects', async () => {
    const { controller } = harness();
    await controller.loadSessions();
    expect(Object.keys(controller.state.sessions).toSorted()).toEqual([
      'server:srv_1/session:ses_a',
      'ses_a',
    ]);
    expect(controller.groups()).toHaveLength(2);
    controller.dispose();
  });

  test('each server paginates independently and merges its own rows', async () => {
    const { controller, local, remote } = harness();
    let localPages = 0;
    let remotePages = 0;
    local.listSessionsHook = async () => {
      localPages += 1;
      if (localPages <= 5) {
        return {
          sessions: [session(`ses_l${localPages}`, 'local', '/work/lotus')],
          nextCursor: `l${localPages}`,
        };
      }
      return { sessions: [session('ses_l6', 'local', '/work/lotus')] };
    };
    remote.listSessionsHook = async () => {
      remotePages += 1;
      if (remotePages <= 5) {
        return {
          sessions: [session(`ses_r${remotePages}`, 'srv_1', '/work/lotus')],
          nextCursor: `r${remotePages}`,
        };
      }
      return { sessions: [session('ses_r6', 'srv_1', '/work/lotus')] };
    };
    await controller.loadSessions();
    expect(controller.state.serverPages['local']?.cursor).toBe('l5');
    expect(controller.state.serverPages['srv_1']?.cursor).toBe('r5');
    expect(controller.state.sessionsComplete).toBe(false);

    await controller.loadMoreSessions();
    expect(localPages).toBe(6);
    expect(remotePages).toBe(6);
    expect(controller.state.serverPages['local']?.complete).toBe(true);
    expect(controller.state.serverPages['srv_1']?.complete).toBe(true);
    expect(Object.keys(controller.state.sessions)).toContain('server:srv_1/session:ses_r6');
    expect(Object.keys(controller.state.sessions)).toContain('ses_l6');
    controller.dispose();
  });

  test('catalogs are scoped by server and directory', async () => {
    const { controller, local, remote } = harness();
    local.agents = [{ id: 'local-agent', name: 'Local', mode: 'primary', hidden: false }];
    remote.agents = [{ id: 'remote-agent', name: 'Remote', mode: 'primary', hidden: false }];
    await controller.loadCatalog('/work/lotus', 'local');
    expect(controller.state.agents.map((agent) => agent.id)).toEqual(['local-agent']);
    expect(controller.catalogFresh('/work/lotus', 'local')).toBe(true);

    await controller.loadCatalog('/work/lotus', 'srv_1');
    expect(controller.state.agents.map((agent) => agent.id)).toEqual(['remote-agent']);
    expect(controller.catalogFresh('/work/lotus', 'srv_1')).toBe(true);
    expect(controller.catalogFresh('/work/lotus', 'local')).toBe(false);
    controller.dispose();
  });

  test('a late catalog response from a previous server cannot overwrite the selected one', async () => {
    const { controller, local, remote } = harness();
    let releaseLocal: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    local.listAgentsHook = async () => {
      await gate;
      return [{ id: 'late-local', name: 'Late', mode: 'primary', hidden: false }];
    };
    remote.agents = [{ id: 'remote-agent', name: 'Remote', mode: 'primary', hidden: false }];

    const slow = controller.loadCatalog('/work/lotus', 'local');
    await controller.loadCatalog('/work/lotus', 'srv_1');
    releaseLocal?.();
    await slow;

    expect(controller.state.agents.map((agent) => agent.id)).toEqual(['remote-agent']);
    expect(controller.state.catalogServerID).toBe('srv_1');
    controller.dispose();
  });
});

function catalogHarness() {
  const local = new FakeBackend();
  const remote = new FakeBackend();
  local.serverID = 'local';
  remote.serverID = 'srv_1';
  local.sessions = [session('ses_l', 'local', '/work/alpha')];
  remote.sessions = [session('ses_r', 'srv_1', '/srv/beta')];
  local.agents = [
    { id: 'a-local', name: 'Local', mode: 'primary', hidden: false },
    { id: 'a-shared', name: 'Shared', mode: 'primary', hidden: false },
  ];
  remote.agents = [{ id: 'a-remote', name: 'Remote', mode: 'primary', hidden: false }];
  local.models = [
    { providerID: 'p', modelID: 'm-local', name: 'Local', enabled: true, variants: [] },
  ];
  remote.models = [
    { providerID: 'p', modelID: 'm-remote', name: 'Remote', enabled: true, variants: [] },
  ];
  const controller = new AppController({
    backend: local,
    backendFor: (serverID: string) => (serverID === 'srv_1' ? remote : local),
    serverIDs: () => ['local', 'srv_1'],
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/alpha',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: () => Promise.resolve([]),
    requestExit: () => {},
  });
  return { controller, local, remote };
}

describe('overview catalog actions follow the selected project (issue #79)', () => {
  test('overview catalog actions resolve against the selected host, not the launch host', async () => {
    const { controller, local, remote } = catalogHarness();
    await controller.bootstrap();
    await controller.loadSessions();

    // Select B's project row in the overview.
    controller.openSession('ses_r', 'srv_1');
    controller.openOverview();
    expect(controller.state.overview.project.serverID).toBe('srv_1');
    expect(controller.state.overview.project.directory).toBe('/srv/beta');
    await controller.loadCatalog('/srv/beta', 'srv_1');

    // Agent cycling sees only B's catalog.
    await controller.cycleAgent(1);
    expect(controller.state.overview.agent).toBe('a-remote');

    // The model picker offers only B's models.
    await controller.openModelPicker();
    expect(controller.modelChoices('').map((choice) => choice.modelID)).toEqual(['m-remote']);

    // F2's recent-model path and --model resolution validate against B too.
    controller.setOverlay({ kind: 'none' });
    controller.setComposer(composerFrom('/model p/m-local'));
    await controller.submit();
    expect(controller.state.overview.model).toBeUndefined();
    expect(controller.state.notice?.text).toContain('m-local');

    // A new session from B's overview row gets B's valid selection.
    controller.setOverlay({ kind: 'none' });
    controller.setComposer(composerFrom('/model p/m-remote'));
    await controller.submit();
    expect(controller.state.overview.model).toEqual({ providerID: 'p', modelID: 'm-remote' });
    await controller.createSessionWithPrompt(
      { serverID: 'srv_1', directory: '/srv/beta' },
      'start here',
    );
    expect(remote.calls.filter((call) => call.name === 'createSession')).toHaveLength(1);
    expect(local.calls.filter((call) => call.name === 'createSession')).toHaveLength(0);
    const created = remote.calls.find((call) => call.name === 'createSession')?.args[0];
    expect(created).toMatchObject({ model: { providerID: 'p', modelID: 'm-remote' } });

    controller.dispose();
  });

  test('switching projects while a slow catalog RPC runs never uses the stale catalog', async () => {
    const { controller, remote } = catalogHarness();
    await controller.bootstrap();
    await controller.loadSessions();
    controller.openSession('ses_l', 'local');
    controller.openOverview();
    await controller.loadCatalog('/work/alpha', 'local');
    expect(controller.catalogFresh('/work/alpha', 'local')).toBe(true);

    // B's catalog RPC hangs while the user moves back to A's project.
    let releaseRemote: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRemote = resolve;
    });
    const realAgents = remote.listAgents.bind(remote);
    remote.listAgents = async () => {
      await gate;
      return realAgents();
    };

    controller.openSession('ses_r', 'srv_1');
    controller.openOverview();
    expect(controller.state.overview.project.serverID).toBe('srv_1');
    const slowCatalog = controller.loadCatalog('/srv/beta', 'srv_1');

    controller.openSession('ses_l', 'local');
    controller.openOverview();
    expect(controller.state.overview.project.serverID).toBe('local');

    releaseRemote?.();
    await slowCatalog;

    // The late B response must not have replaced A's usable catalog.
    expect(controller.state.catalogServerID).toBe('local');
    expect(controller.state.agents.map((agent) => agent.id)).toContain('a-local');
    expect(controller.state.agents.map((agent) => agent.id)).not.toContain('a-remote');
    await controller.cycleAgent(1);
    expect(controller.state.overview.agent).toBe('a-local');
    controller.dispose();
  });
});

describe('per-server @file completion', () => {
  test('the selected server decides local files vs remote file search', async () => {
    const { local, remote } = harness();
    remote.sessions = [{ ...session('ses_r', 'srv_1', '/work/lotus') }];
    remote.remoteFiles = ['remote-file.ts', 'remote-other.ts'];
    local.remoteFiles = ['must-not-be-used.ts'];
    let localScans = 0;
    const localListFiles = async () => {
      localScans += 1;
      return ['local-file.ts'];
    };
    const routed = new AppController({
      backend: local,
      backendFor: (serverID: string) => (serverID === 'srv_1' ? remote : local),
      serverIDs: () => ['local', 'srv_1'],
      config: defaultConfig,
      localState: emptyState,
      platform: 'linux',
      cwd: '/work/lotus',
      version: '0.0.1',
      now: () => 10_000,
      saveLocalState: async () => {},
      listFiles: localListFiles,
      requestExit: () => {},
    });
    routed.state.sessions['server:srv_1/session:ses_r'] = remote.sessions[0]!;
    routed.state.sessions['ses_a'] = local.sessions[0]!;
    await routed.loadSessions();
    routed.openSession('ses_r', 'srv_1');
    routed.setComposer(composerFrom('@remote'));
    for (let round = 0; round < 5; round += 1) await Bun.sleep(0);

    expect(routed.state.completion?.kind).toBe('file');
    expect(routed.state.completion?.items.map((item) => item.insert)).toEqual([
      '@remote-file.ts ',
      '@remote-other.ts ',
    ]);
    expect(remote.calls.some((call) => call.name === 'findProjectFiles')).toBe(true);
    expect(localScans).toBe(0);

    // The overview opens on the selected remote project and stays remote (issue #79).
    routed.openOverview();
    routed.setComposer(composerFrom('@remote'));
    for (let round = 0; round < 5; round += 1) await Bun.sleep(0);
    expect(routed.state.overview.project.serverID).toBe('srv_1');
    expect(routed.state.completion?.items.map((item) => item.insert)).toEqual([
      '@remote-file.ts ',
      '@remote-other.ts ',
    ]);
    expect(localScans).toBe(0);

    // Opening the selected remote session's overview keeps the remote project (issue #79).
    routed.openOverview();
    routed.setComposer(composerFrom('@remote'));
    for (let round = 0; round < 5; round += 1) await Bun.sleep(0);
    expect(routed.state.overview.project.serverID).toBe('srv_1');
    expect(routed.state.completion?.items.map((item) => item.insert)).toEqual([
      '@remote-file.ts ',
      '@remote-other.ts ',
    ]);
    expect(localScans).toBe(0);

    // Selecting the local project in the overview makes completion local again.
    routed.openSession('ses_a', 'local');
    routed.openOverview();
    routed.setComposer(composerFrom('@local'));
    for (let round = 0; round < 5; round += 1) await Bun.sleep(0);
    expect(routed.state.overview.project.serverID).toBe('local');
    expect(routed.state.completion?.items.map((item) => item.insert)).toEqual(['@local-file.ts ']);
    expect(localScans).toBeGreaterThan(0);
    routed.dispose();
  });
});

const keymapServices = { openEditor: () => {}, redraw: () => {}, scroll: () => {} };

function routeKeyNew(
  controller: AppController,
  name: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
) {
  const { keymap } = buildKeymap({});
  routeKey(
    controller,
    keymap,
    { name, ctrl: mods.ctrl ?? false, alt: mods.alt ?? false, shift: mods.shift ?? false },
    keymapServices,
  );
}

function userMessage(id: string, text: string) {
  return { kind: 'user', id, createdAt: 1, text, attachments: [] } as const;
}

describe('overview identity (issue #62)', () => {
  test('Enter on a remote row opens that server and its transcript, never the launch one', async () => {
    const { controller, local, remote } = harness();
    local.messages = { ses_a: [userMessage('m_local', 'from local')] };
    remote.messages = { ses_a: [userMessage('m_remote', 'from remote')] };
    await controller.bootstrap();
    controller.openOverview();

    const remoteRow = controller
      .overviewRows()
      .find((row) => row.kind === 'session' && row.session.serverID === 'srv_1');
    expect(remoteRow?.kind).toBe('session');
    if (remoteRow === undefined) throw new Error('missing remote row');

    for (
      let step = 0;
      step < 10 && controller.state.overview.selectedRow !== remoteRow.key;
      step += 1
    ) {
      routeKeyNew(controller, 'down');
    }
    expect(controller.state.overview.selectedRow).toBe(remoteRow.key);

    routeKeyNew(controller, 'return');
    for (let round = 0; round < 10; round += 1) await Bun.sleep(0);

    expect(controller.state.route).toEqual({
      kind: 'conversation',
      serverID: 'srv_1',
      sessionID: 'ses_a',
    });
    expect(
      controller.state.transcripts['server:srv_1/session:ses_a']?.messages.map((m) => m.id),
    ).toEqual(['m_remote']);
    // The launch backend was asked for nothing about the remote session.
    expect(local.calls.filter((call) => call.name === 'listMessages')).toHaveLength(0);
    controller.dispose();
  });

  test('selecting a remote project and typing creates the session on that server only', async () => {
    const { controller, local, remote } = harness();
    await controller.bootstrap();
    controller.openOverview();

    const remoteRow = controller
      .overviewRows()
      .find((row) => row.kind === 'session' && row.session.serverID === 'srv_1');
    if (remoteRow === undefined) throw new Error('missing remote row');
    for (
      let step = 0;
      step < 10 && controller.state.overview.selectedRow !== remoteRow.key;
      step += 1
    ) {
      routeKeyNew(controller, 'down');
    }

    controller.setComposer(composerFrom('build the thing'));
    await controller.submit();

    expect(remote.calls.filter((call) => call.name === 'createSession')).toHaveLength(1);
    expect(local.calls.filter((call) => call.name === 'createSession')).toHaveLength(0);
    expect(remote.calls.filter((call) => call.name === 'prompt')).toHaveLength(1);
    expect(local.calls.filter((call) => call.name === 'prompt')).toHaveLength(0);
    const route = controller.state.route;
    expect(route.kind).toBe('conversation');
    if (route.kind === 'conversation') expect(route.serverID).toBe('srv_1');
    controller.dispose();
  });
});
