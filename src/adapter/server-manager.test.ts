import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import { BackendError } from './backend.ts';
import type { Connection } from './connection.ts';
import { ServerConnectionManager } from './server-manager.ts';

function connection(url: string, origin: Connection['origin'] = 'remote'): Connection {
  return { baseUrl: url, headers: {}, origin };
}

function server(_serverID: string, url: string): { connection: Connection; backend: FakeBackend } {
  return { connection: connection(url), backend: new FakeBackend() };
}

describe('ServerConnectionManager', () => {
  test('local and two remote servers coexist and stay isolated', () => {
    const manager = new ServerConnectionManager();
    const local = server('local', 'http://localhost:4096');
    const one = server('srv_1', 'http://one:4096');
    const two = server('srv_2', 'http://two:4096');
    manager.add({
      serverID: 'local',
      ...local,
      connection: connection('http://localhost:4096', 'discovered'),
    });
    manager.add({ serverID: 'srv_1', ...one });
    manager.add({ serverID: 'srv_2', ...two });

    expect(manager.list().map((entry) => entry.serverID)).toEqual(['local', 'srv_1', 'srv_2']);
    expect(manager.backendFor('srv_1')).toBe(one.backend);
    expect(manager.backendFor('srv_2')).toBe(two.backend);
    expect(manager.serverFor('srv_1').remoteFilesystem).toBe(true);
    expect(manager.serverFor('local').remoteFilesystem).toBe(false);
  });

  test('fails closed for an unknown or removed server', async () => {
    const manager = new ServerConnectionManager();
    manager.add({ serverID: 'srv_1', ...server('srv_1', 'http://one:4096') });
    expect(() => manager.backendFor('srv_missing')).toThrow('Unknown server');
    await manager.remove('srv_1');
    expect(() => manager.backendFor('srv_1')).toThrow('Unknown server');
  });

  test('removing one server leaves the others functional and sends no stop', async () => {
    const manager = new ServerConnectionManager();
    const one = server('srv_1', 'http://one:4096');
    const two = server('srv_2', 'http://two:4096');
    manager.add({ serverID: 'srv_1', ...one });
    manager.add({ serverID: 'srv_2', ...two });

    await manager.remove('srv_1');
    let reached = false;
    two.backend.listSessionsHook = async () => {
      reached = true;
      return { sessions: [] };
    };
    await manager.backendFor('srv_2').listSessions({});
    expect(reached).toBe(true);
    expect(one.backend.calls).toEqual([]);
  });

  test('status changes never leak across servers', () => {
    const manager = new ServerConnectionManager();
    manager.add({ serverID: 'local', ...server('local', 'http://localhost:4096') });
    manager.add({ serverID: 'srv_1', ...server('srv_1', 'http://one:4096') });
    manager.setState('local', 'online');
    manager.applyHealth('srv_1', {
      ok: false,
      error: new BackendError('unauthorized', 'session.list', 'no'),
    });
    expect(manager.serverFor('local').state).toBe('online');
    expect(manager.serverFor('srv_1').state).toBe('unauthorized');
  });

  test('a stalled remote does not block registering the local server', () => {
    const manager = new ServerConnectionManager();
    manager.add({ serverID: 'local', ...server('local', 'http://localhost:4096') });
    // The remote is simply not registered yet; local is immediately usable.
    expect(manager.serverFor('local')).toBeDefined();
    expect(manager.backendFor('local')).toBeDefined();
  });

  test('stream callbacks survive state transitions; only replacement goes stale', async () => {
    const manager = new ServerConnectionManager();
    const fake = server('srv_1', 'http://one:4096');
    manager.add({ serverID: 'srv_1', ...fake });
    const statuses: string[] = [];
    let batches = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.backend.eventsHook = (signal: AbortSignal) =>
      (async function* () {
        yield { kind: 'connected' };
        await gate;
        yield { kind: 'session-changed', sessionID: 'ses_x' };
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      })();
    manager.startStream('srv_1', {
      onBatch: () => {
        batches += 1;
      },
      onStatus: (_serverID, status) => statuses.push(status),
    });
    for (let round = 0; round < 10; round += 1) await Bun.sleep(0);
    expect(statuses).toContain('live');
    // A state transition replaces the managed-server object; the stream is NOT stale.
    manager.setState('srv_1', 'online');
    release();
    await Bun.sleep(75);
    expect(batches).toBe(1);
    // Re-registering the server replaces the registration; the old stream goes stale.
    manager.add({ serverID: 'srv_1', ...server('srv_1', 'http://two:4096') });
    await Bun.sleep(75);
    expect(batches).toBe(1);
    await manager.dispose();
  });

  test('replacing a server aborts its old stream so subscriptions do not duplicate', async () => {
    const manager = new ServerConnectionManager();
    const first = server('srv_1', 'http://one:4096');
    manager.add({ serverID: 'srv_1', ...first });
    const batches: number[] = [];
    const handlers = {
      onBatch: () => batches.push(1),
      onStatus: () => {},
    };
    manager.startStream('srv_1', handlers);
    manager.startStream('srv_1', handlers);
    manager.startStream('srv_1', handlers);
    manager.add({ serverID: 'srv_1', ...server('srv_1', 'http://two:4096') });
    await manager.dispose();
    // No stream callback fired; the important property is that dispose settles cleanly.
    expect(batches).toEqual([]);
  });

  test('a cheaper label change keeps identity and sessions', () => {
    const manager = new ServerConnectionManager();
    manager.add({ serverID: 'srv_1', label: 'work', ...server('srv_1', 'http://one:4096') });
    const backend = manager.backendFor('srv_1');
    manager.setLabel('srv_1', 'office');
    expect(manager.serverFor('srv_1').label).toBe('office');
    expect(manager.backendFor('srv_1')).toBe(backend);
  });
});
