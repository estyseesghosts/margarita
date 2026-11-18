import { describe, expect, test } from 'bun:test';

import { projectExecution } from './execution.ts';
import { executionLabel } from './session.ts';

const base = { connected: true, loaded: true, running: false, permissionIDs: [], formCount: 0 };

describe('projectExecution', () => {
  test('disconnected is unknown, never idle', () => {
    const execution = projectExecution({ ...base, connected: false });
    expect(execution.state).toBe('unknown');
    expect(executionLabel(execution)).toBe('reconnecting');
  });
  test('pending permission beats running', () => {
    expect(projectExecution({ ...base, running: true, permissionIDs: ['p1'] })).toEqual({
      state: 'waiting',
      permissionIDs: ['p1'],
      formIDs: [],
    });
  });
  test('forms also need input', () => {
    expect(executionLabel(projectExecution({ ...base, formCount: 1 }))).toBe('needs input');
  });
  test('running and idle outcomes', () => {
    expect(projectExecution({ ...base, running: true })).toEqual({ state: 'working' });
    expect(executionLabel(projectExecution({ ...base, outcome: 'failed' }))).toBe('failed');
    expect(projectExecution(base)).toEqual({ state: 'idle' });
  });
});
