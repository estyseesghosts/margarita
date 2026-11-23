import { describe, expect, test } from 'bun:test';

import { AdmissionGate } from './admission-gate.ts';

describe('prompt admission gate (#312)', () => {
  test('one key is single-flight while other keys stay independent', () => {
    const gate = new AdmissionGate();
    const local = 'local:ses_same';
    const remote = 'remote:ses_same';
    expect(gate.isAdmitting(local)).toBe(false);
    expect(gate.begin(local)).toBe(true);
    expect(gate.isAdmitting(local)).toBe(true);
    expect(gate.begin(local)).toBe(false);
    expect(gate.begin(remote)).toBe(true);
    expect(gate.isAdmitting(remote)).toBe(true);
  });

  test('releasing a key clears only that claim', () => {
    const gate = new AdmissionGate();
    gate.begin('a');
    gate.begin('b');
    gate.end('a');
    expect(gate.isAdmitting('a')).toBe(false);
    expect(gate.isAdmitting('b')).toBe(true);
    gate.end('b');
    expect(gate.isAdmitting('b')).toBe(false);
  });

  test('releasing an unclaimed key is a no-op', () => {
    const gate = new AdmissionGate();
    gate.end('never-claimed');
    expect(gate.isAdmitting('never-claimed')).toBe(false);
    expect(gate.begin('never-claimed')).toBe(true);
  });
});
