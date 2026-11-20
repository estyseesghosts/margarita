import { describe, expect, test } from 'bun:test';

import { type WorkerJob, workerNodeKey, workerNodes, workerStatusLabel } from './worker.ts';

const job = (
  id: string,
  status: WorkerJob['status'],
  startedAt: number,
  childSessionID: string,
): WorkerJob => ({
  id,
  childSessionID,
  agent: 'build',
  description: `investigate ${id}`,
  status,
  startedAt,
});

describe('background worker projection (#101)', () => {
  test('two concurrent workers are both shown, identified and ordered deterministically', () => {
    const nodes = workerNodes(
      [job('b', 'completed', 20, 'child_b'), job('a', 'running', 10, 'child_a')],
      new Set(),
    );
    expect(nodes.map((node) => node.worker.id)).toEqual(['a', 'b']);
    expect(nodes[0]?.key).toBe('worker:a');
    expect(nodes[0]?.worker.childSessionID).toBe('child_a');
    expect(nodes[0]?.expanded).toBe(false);
    expect(workerStatusLabel('completed')).toBe('returned');
    expect(workerStatusLabel('error')).toBe('failed');
  });

  test('running outranks age, and links break ties by id', () => {
    const nodes = workerNodes(
      [
        job('z', 'running', 500, 'child_z'),
        job('a', 'error', 1, 'child_a'),
        job('b', 'running', 400, 'child_b'),
      ],
      new Set(),
    );
    expect(nodes.map((node) => node.worker.id)).toEqual(['b', 'z', 'a']);
  });

  test('expansion is selected by stable worker key', () => {
    const nodes = workerNodes([job('a', 'running', 1, 'child_a')], new Set([workerNodeKey('a')]));
    expect(nodes[0]?.expanded).toBe(true);
  });

  test('an empty server result produces no rows — never a synthetic worker', () => {
    expect(workerNodes([], new Set())).toEqual([]);
  });
});
