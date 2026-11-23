import { describe, expect, test } from 'bun:test';

import type { SessionSummary, TokenUsage } from '../domain/session.ts';
import {
  mergeCommittedSessions,
  sessionFlags,
  sessionPage,
  type SnapshotResult,
} from './session-snapshot.ts';

const tokens: TokenUsage = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    serverID: 'local',
    projectID: 'p',
    directory: '/work',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    ...overrides,
  };
}

function result(overrides: Partial<SnapshotResult> = {}): SnapshotResult {
  return {
    serverID: 'local',
    ok: true,
    error: undefined,
    fresh: {},
    active: new Set(),
    cursor: undefined,
    usageSeq: 0,
    ...overrides,
  };
}

describe('session snapshot commit (#308)', () => {
  test('fresh rows win, found rows are added, untouched cached rows remain', () => {
    const current = {
      'local:a': session('a', { title: 'stale' }),
      'local:kept': session('kept', { title: 'kept' }),
    };
    const merged = mergeCommittedSessions(
      current,
      { 'local:a': session('a', { title: 'fresh' }) },
      { 'local:found': session('found', { title: 'found' }) },
      0,
      () => 0,
    );
    expect(merged['local:a']?.title).toBe('fresh');
    expect(merged['local:found']?.title).toBe('found');
    expect(merged['local:kept']?.title).toBe('kept');
  });

  test('a live usage event newer than the snapshot keeps cost and tokens', () => {
    const current = {
      'local:a': session('a', { cost: 1.5, tokens }),
    };
    const merged = mergeCommittedSessions(
      current,
      { 'local:a': session('a', { title: 'from listing' }) },
      {},
      5,
      (key) => (key === 'local:a' ? 6 : 0),
    );
    expect(merged['local:a']?.title).toBe('from listing');
    expect(merged['local:a']?.cost).toBe(1.5);
    expect(merged['local:a']?.tokens).toEqual(tokens);
  });

  test('without newer usage evidence the snapshot replaces cost and tokens', () => {
    const current = { 'local:a': session('a', { cost: 1.5, tokens }) };
    const merged = mergeCommittedSessions(current, { 'local:a': session('a') }, {}, 5, () => 5);
    expect(merged['local:a']?.cost).toBeUndefined();
    expect(merged['local:a']?.tokens).toBeUndefined();
  });

  test('preserving usage does not introduce undefined cost/tokens keys', () => {
    const current = { 'local:a': session('a') };
    const merged = mergeCommittedSessions(
      current,
      { 'local:a': session('a', { title: 'from listing' }) },
      {},
      5,
      () => 6,
    );
    expect(Object.hasOwn(merged['local:a'] ?? {}, 'cost')).toBe(false);
    expect(Object.hasOwn(merged['local:a'] ?? {}, 'tokens')).toBe(false);
  });
});

describe('session page and flag derivation (#308)', () => {
  test('a paged result is incomplete and keeps its cursor', () => {
    expect(sessionPage(result({ cursor: 'next' }))).toEqual({
      cursor: 'next',
      complete: false,
      loading: false,
    });
  });

  test('a successful terminal result is complete; a failure is not (#327)', () => {
    expect(sessionPage(result())).toEqual({ complete: true, loading: false });
    expect(sessionPage(result({ ok: false, error: 'offline' }))).toEqual({
      complete: false,
      loading: false,
      error: 'offline',
    });
    expect(sessionPage(result({ ok: false, error: undefined }))).toEqual({
      complete: false,
      loading: false,
      error: 'Could not reach the server',
    });
  });

  test('a failed host page never makes a single-host resync globally complete (#327)', () => {
    const pages = {
      local: sessionPage(result({ ok: false, error: 'offline' })),
      remote: sessionPage(result({ serverID: 'remote' })),
    };
    const flags = sessionFlags(
      [result({ serverID: 'remote' })],
      1,
      () => Object.values(pages).every((page) => page.complete),
      'remote',
    );
    expect(flags.complete).toBe(false);
    expect(pages['local']?.complete).toBe(false);
  });

  test('full-refresh flags come from the applied results', () => {
    const flags = sessionFlags(
      [result({ ok: true }), result({ serverID: 'remote', ok: false, error: 'down' })],
      1,
      () => false,
      undefined,
    );
    expect(flags.complete).toBe(false);
    expect(flags.loading).toBe(true);
    expect(flags.error).toBe('down');
    expect(flags.cursor).toBeUndefined();

    const clean = sessionFlags([result({ ok: true })], 1, () => false, undefined);
    expect(clean.complete).toBe(true);
    expect(clean.cursor).toBeUndefined();
    const paged = sessionFlags([result({ cursor: 'next' })], 1, () => false, undefined);
    expect(paged.cursor).toBe('next');
  });

  test('a single-host resync defers completeness to every host and clears no cursor', () => {
    const flags = sessionFlags([], 0, () => true, 'local');
    expect(flags.complete).toBe(true);
    expect(flags.cursor).toBeUndefined();
    expect(flags.loading).toBe(false);
    expect(flags.error).toBeUndefined();
  });
});
