import { describe, expect, test } from 'bun:test';

import { classifySessionStatus, isActiveStatus, needsInputStatus } from './session-status.ts';

describe('session status classifier', () => {
  test('precedence is needs input > working > failed > idle', () => {
    expect(
      classifySessionStatus({
        online: true,
        execution: { state: 'waiting', permissionIDs: ['p'], formIDs: [] },
      }),
    ).toBe('needs-input');
    expect(classifySessionStatus({ online: true, execution: { state: 'working' } })).toBe(
      'working',
    );
    expect(
      classifySessionStatus({ online: true, execution: { state: 'idle', outcome: 'failed' } }),
    ).toBe('failed');
    expect(classifySessionStatus({ online: true, execution: { state: 'idle' } })).toBe('idle');
  });

  test('interruption is idle, not failed', () => {
    expect(
      classifySessionStatus({ online: true, execution: { state: 'idle', outcome: 'interrupted' } }),
    ).toBe('idle');
  });

  test('offline servers are unknown, never red or stale green', () => {
    expect(classifySessionStatus({ online: false, execution: { state: 'working' } })).toBe(
      'unknown',
    );
    expect(
      classifySessionStatus({
        online: false,
        execution: { state: 'idle', outcome: 'failed' },
      }),
    ).toBe('unknown');
  });

  test('archived sessions never count as active', () => {
    expect(
      classifySessionStatus({ online: true, archived: true, execution: { state: 'working' } }),
    ).toBe('idle');
  });

  test('tabs share the classifier', () => {
    expect(isActiveStatus('working')).toBe(true);
    expect(isActiveStatus('needs-input')).toBe(true);
    expect(isActiveStatus('idle')).toBe(false);
    expect(needsInputStatus('needs-input')).toBe(true);
    expect(needsInputStatus('working')).toBe(false);
  });
});
