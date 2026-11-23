import { describe, expect, test } from 'bun:test';

import type { PinnedModelOperation } from '../config/local-state.ts';
import type { ModelSelection } from '../domain/model-ref.ts';
import { applyPin, modelScope, projectPinScope } from './model-pins.ts';

function model(modelID: string): ModelSelection {
  return { providerID: 'provider', modelID };
}

describe('model pins (#313)', () => {
  test('scopes are per host and canonical directory', () => {
    expect(modelScope('local', '/work', 'linux')).toBe(modelScope('local', '/work/', 'linux'));
    expect(modelScope('local', '/work', 'linux')).not.toBe(modelScope('remote', '/work', 'linux'));
    expect(projectPinScope('local', '/work', 'linux')).toBe(
      `project:${modelScope('local', '/work', 'linux')}`,
    );
  });

  test('a pin stores an explicit operation and a visible pin', () => {
    const { operations, pins } = applyPin({}, {}, 'user', model('a'), '2026-01-01T00:00:00Z');
    expect(pins['user']).toEqual(model('a'));
    expect(operations['user']).toEqual({
      revision: 1,
      model: model('a'),
      updatedAt: '2026-01-01T00:00:00Z',
    });
  });

  test('revisions increase per scope and other scopes are untouched', () => {
    const first = applyPin({}, {}, 'user', model('a'), 't1');
    const second = applyPin(first.operations, first.pins, 'user', model('b'), 't2');
    expect(second.operations['user']?.revision).toBe(2);
    expect(second.pins['user']).toEqual(model('b'));

    const other = applyPin(second.operations, second.pins, 'project:x', model('c'), 't3');
    expect(other.operations['user']).toEqual(second.operations['user']);
    expect(other.operations['project:x']?.revision).toBe(1);
    expect(other.pins['user']).toEqual(model('b'));
  });

  test('a clear removes the visible pin but keeps a monotone operation', () => {
    const before: Record<string, PinnedModelOperation> = {
      user: { revision: 4, model: model('a'), updatedAt: 't1' },
    };
    const { operations, pins } = applyPin(before, { user: model('a') }, 'user', null, 't2');
    expect(pins['user']).toBeUndefined();
    expect(operations['user']).toEqual({ revision: 5, model: null, updatedAt: 't2' });
  });
});
