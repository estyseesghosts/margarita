import { describe, expect, test } from 'bun:test';

import { shellBackgroundState, type ShellJob } from './shell-job.ts';

const running: ShellJob = {
  id: 'job_1',
  shellID: 'shell_1',
  sessionID: 'ses_1',
  status: 'running',
  startedAt: 1,
};

describe('shell background evidence (#259)', () => {
  test('reports running only while the job list is confirmed', () => {
    expect(shellBackgroundState([running], 'shell_1', 'confirmed')).toBe('confirmed-running');
    expect(shellBackgroundState([running], 'shell_1', 'stale')).toBe('last-known-running');
    expect(shellBackgroundState([running], 'shell_1', 'unavailable')).toBe('last-known-running');
  });

  test('never invents liveness from a missing or stopped row', () => {
    expect(shellBackgroundState([running], undefined, 'confirmed')).toBe('not-reported');
    expect(shellBackgroundState(undefined, 'shell_1', 'confirmed')).toBe('not-reported');
    expect(shellBackgroundState([], 'shell_1', 'confirmed')).toBe('confirmed-not-running');
    expect(shellBackgroundState([], 'shell_1', 'stale')).toBe('not-reported');
    expect(
      shellBackgroundState([{ ...running, status: 'completed' }], 'shell_1', 'confirmed'),
    ).toBe('confirmed-not-running');
  });
});
