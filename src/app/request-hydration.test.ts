import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { defaultConfig } from '../config/config.ts';
import { emptyState } from '../config/local-state.ts';
import type { SessionSummary } from '../domain/session.ts';
import { AppController } from './controller.ts';

function summary(id: string): SessionSummary {
  return {
    id,
    serverID: 'local',
    projectID: 'p',
    directory: '/work/hydration',
    title: id,
    createdAt: 0,
    updatedAt: 1,
    archived: false,
  };
}

function controllerFor(backend: FakeBackend): AppController {
  return new AppController({
    backend,
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work/hydration',
    version: '0.0.1',
    now: () => 10_000,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
  });
}

function permission(id: string, sessionID: string) {
  return { id, sessionID, action: 'edit', resources: [], save: [] };
}

describe('request hydration independence (#348)', () => {
  test('hydrates active sessions with at most four concurrent reads', async () => {
    const backend = new FakeBackend();
    backend.sessions = Array.from({ length: 12 }, (_, index) => summary(`ses_${index}`));
    backend.active = new Set(backend.sessions.map((session) => session.id));
    const active = new Set<string>();
    let peak = 0;
    const original = backend.listPermissions.bind(backend);
    backend.listPermissions = async (sessionID) => {
      active.add(sessionID);
      peak = Math.max(peak, active.size);
      await Bun.sleep(2);
      active.delete(sessionID);
      return original(sessionID);
    };
    const controller = controllerFor(backend);
    await controller.bootstrap();
    await controller.settleRequestHydration();
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    for (const session of backend.sessions) {
      expect(controller.requestHydrationOf(session.id)).toBe('ready');
    }
    expect(controller.state.startup.hydrationReadyAt).toBeDefined();
    controller.dispose();
  });

  test('concurrent startup/SSE refreshes coalesce and dirty one follow-up', async () => {
    const backend = new FakeBackend();
    backend.sessions = [summary('ses_a')];
    const controller = controllerFor(backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await controller.settleRequestHydration();

    let reads = 0;
    let concurrent = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.listPermissions = async () => {
      reads += 1;
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await gate;
      concurrent -= 1;
      return [];
    };
    controller.retryInputRequests();
    controller.retryInputRequests();
    await Promise.resolve();
    // The second request did not start a second simultaneous permission/form RPC.
    expect(peak).toBe(1);
    expect(reads).toBe(1);
    release?.();
    await controller.settleRequestHydration();
    // The coalesced second request still runs once after the first settles, so an event that
    // arrived during the read is never lost.
    expect(reads).toBe(2);
    controller.dispose();
  });

  test('a failed refresh keeps the last confirmed requests and reports the failure', async () => {
    const backend = new FakeBackend();
    backend.sessions = [summary('ses_a')];
    backend.permissions = [permission('per_1', 'ses_a')];
    const controller = controllerFor(backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await controller.settleRequestHydration();
    expect(controller.executionOf('ses_a').state).toBe('waiting');

    backend.listPermissions = async () => {
      throw new Error('permission endpoint offline');
    };
    controller.retryInputRequests();
    await controller.settleRequestHydration();
    expect(controller.executionOf('ses_a').state).toBe('waiting');
    expect(controller.state.requestErrors['ses_a']?.permissions).toContain('offline');
    expect(controller.requestHydrationOf('ses_a')).toBe('ready');
    controller.dispose();
  });

  test('a request that arrives during the initial read is delivered by the follow-up', async () => {
    const backend = new FakeBackend();
    backend.sessions = [summary('ses_a')];
    const controller = controllerFor(backend);
    await controller.bootstrap();
    controller.openSession('ses_a');
    await controller.settleRequestHydration();

    let reads = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = backend.listPermissions.bind(backend);
    backend.listPermissions = async (sessionID) => {
      reads += 1;
      if (reads === 1) await gate;
      return original(sessionID);
    };
    controller.retryInputRequests();
    await Promise.resolve();
    expect(controller.requestHydrationOf('ses_a')).toBe('loading');
    backend.permissions = [permission('per_late', 'ses_a')];
    controller.retryInputRequests();
    release?.();
    await controller.settleRequestHydration();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(controller.executionOf('ses_a').state).toBe('waiting');
    expect(controller.state.permissions['ses_a']?.map((entry) => entry.id)).toEqual(['per_late']);
    controller.dispose();
  });
});
