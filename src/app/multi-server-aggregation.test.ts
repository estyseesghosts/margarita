import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import { composerFrom } from '../domain/composer.ts';
import type { SessionSummary } from '../domain/session.ts';
import { AppController } from './controller.ts';

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

    routed.openOverview();
    routed.setComposer(composerFrom('@local'));
    for (let round = 0; round < 5; round += 1) await Bun.sleep(0);
    expect(routed.state.completion?.items.map((item) => item.insert)).toEqual(['@local-file.ts ']);
    expect(localScans).toBeGreaterThan(0);
    routed.dispose();
  });
});
