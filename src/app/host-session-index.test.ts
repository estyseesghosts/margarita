import { describe, expect, test } from 'bun:test';

import { healthCommands, type HealthReport, HostSessionIndex } from './host-session-index.ts';

function report(overrides: Partial<HealthReport> & { serverID: string }): HealthReport {
  return { epoch: 1, ok: true, cause: undefined, ...overrides };
}

function kinds(commands: readonly { kind: string }[]): string[] {
  return commands.map((command) => command.kind);
}

describe('host session index: stream status (#308)', () => {
  test('a host keeps its own status and falls back to the launch badge', () => {
    const index = new HostSessionIndex();
    expect(index.statusOf('remote', 'live')).toBe('live');
    index.transition({
      serverID: 'remote',
      status: 'reconnecting',
      launchServerID: 'local',
      launchBadge: 'live',
    });
    expect(index.statusOf('remote', 'live')).toBe('reconnecting');
    expect(index.statusOf('other', 'live')).toBe('live');
    expect(index.statusOf('other', 'connecting')).toBe('connecting');
  });

  test('a remote transition only bumps the overview clock and drops its own runtime state', () => {
    const index = new HostSessionIndex();
    const effects = index.transition({
      serverID: 'remote',
      status: 'reconnecting',
      launchServerID: 'local',
      launchBadge: 'live',
    });
    expect(kinds(effects.batched)).toEqual(['bump-overview', 'clear-runtime']);
    expect(effects.batched[1]).toEqual({ kind: 'clear-runtime', serverID: 'remote' });
    expect(effects.after).toEqual([]);
  });

  test('a healthy remote transition never touches runtime state', () => {
    const index = new HostSessionIndex();
    const effects = index.transition({
      serverID: 'remote',
      status: 'live',
      launchServerID: 'local',
      launchBadge: 'live',
    });
    expect(kinds(effects.batched)).toEqual(['bump-overview']);
    expect(effects.after).toEqual([]);
  });

  test('the launch badge follows every launch-host status', () => {
    const index = new HostSessionIndex();
    const live = index.transition({
      serverID: 'local',
      status: 'connecting',
      launchServerID: 'local',
      launchBadge: 'connecting',
    });
    expect(live.after).toEqual([{ kind: 'set-badge', status: 'connecting' }]);

    const lost = index.transition({
      serverID: 'local',
      status: 'reconnecting',
      launchServerID: 'local',
      launchBadge: 'live',
    });
    expect(kinds(lost.batched)).toEqual(['bump-overview', 'clear-runtime']);
    expect(kinds(lost.after)).toEqual(['set-badge', 'show-lost-notice']);
    expect(lost.after[0]).toEqual({ kind: 'set-badge', status: 'reconnecting' });
  });

  test('only a launch reconnect→live edge resyncs, after the badge is set', () => {
    const index = new HostSessionIndex();
    const effects = index.transition({
      serverID: 'local',
      status: 'live',
      launchServerID: 'local',
      launchBadge: 'reconnecting',
    });
    expect(kinds(effects.after)).toEqual(['set-badge', 'resync']);
    expect(effects.after[1]).toEqual({ kind: 'resync', serverID: 'local' });

    const steady = index.transition({
      serverID: 'local',
      status: 'live',
      launchServerID: 'local',
      launchBadge: 'live',
    });
    expect(kinds(steady.after)).toEqual(['set-badge']);
  });
});

describe('host session index: health reporting (#308)', () => {
  test('only registered, still-current results emit health, in order', () => {
    const results = [
      report({ serverID: 'a', epoch: 2 }),
      report({ serverID: 'b', epoch: 1, ok: false, cause: 'stale' }),
      report({ serverID: 'c', epoch: 2 }),
      report({ serverID: 'd', epoch: 2, ok: false, cause: 'offline' }),
    ];
    const { applied, health } = healthCommands(
      results,
      new Set(['a', 'b', 'd']),
      (_serverID, epoch) => epoch === 2,
    );
    expect(applied.map((result) => result.serverID)).toEqual(['a', 'd']);
    expect(health).toEqual([
      { serverID: 'a', result: { ok: true } },
      { serverID: 'd', result: { ok: false, error: 'offline' } },
    ]);
  });

  test('a failed result forwards its original cause, not a flattened message', () => {
    const cause = new Error('connection reset');
    const { health } = healthCommands(
      [report({ serverID: 'a', ok: false, cause })],
      new Set(['a']),
      () => true,
    );
    expect(health).toEqual([{ serverID: 'a', result: { ok: false, error: cause } }]);
  });

  test('an empty result set emits nothing', () => {
    expect(healthCommands([], new Set(['a']), () => true)).toEqual({ applied: [], health: [] });
  });
});
