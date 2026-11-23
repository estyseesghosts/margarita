import { describe, expect, test } from 'bun:test';

import type { Route } from './app-state.ts';
import { attachedSessionFor, routeServerFor } from './route-server.ts';

describe('route ownership rules (#308)', () => {
  test('a conversation belongs to its own host; the overview to the viewed project', () => {
    const conversation: Route = { kind: 'conversation', serverID: 'remote', sessionID: 'ses_a' };
    const newRoute: Route = { kind: 'new', serverID: 'remote', directory: '/work' };
    expect(routeServerFor(conversation, 'local')).toBe('remote');
    expect(routeServerFor(newRoute, 'local')).toBe('remote');
    expect(routeServerFor({ kind: 'overview' }, 'remote')).toBe('remote');
  });

  test('the attached conversation is only on its owning host', () => {
    const conversation: Route = { kind: 'conversation', serverID: 'remote', sessionID: 'ses_a' };
    expect(attachedSessionFor(conversation, 'remote')).toBe('ses_a');
    expect(attachedSessionFor(conversation, 'local')).toBeUndefined();
    expect(attachedSessionFor({ kind: 'overview' }, 'remote')).toBeUndefined();
    expect(
      attachedSessionFor({ kind: 'new', serverID: 'remote', directory: '/work' }, 'remote'),
    ).toBeUndefined();
  });
});
