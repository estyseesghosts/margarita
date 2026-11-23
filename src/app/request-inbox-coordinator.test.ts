import { describe, expect, test } from 'bun:test';

import { FakeBackend } from '../../test/fake-backend.ts';
import type { PermissionPrompt } from '../adapter/wire-mapping.ts';
import type { FormRequest } from '../domain/form.ts';
import {
  requestErrorsValue,
  type RequestInboxCommand,
  RequestInboxCoordinator,
  type RequestInboxCoordinatorDeps,
  type RequestReads,
} from './request-inbox-coordinator.ts';

const backend = new FakeBackend();

function permission(id = 'p1'): PermissionPrompt {
  return { id, sessionID: 'ses', action: 'read', resources: [], save: [] };
}

function form(id: string, sessionID = 'ses'): FormRequest {
  return { id, sessionID, title: id, fields: [] };
}

function reads(overrides: Partial<RequestReads> = {}): RequestReads {
  return {
    permissions: { status: 'fulfilled', value: [permission()] },
    forms: { status: 'fulfilled', value: [form('f1')] },
    locationForms: { status: 'fulfilled', value: [] },
    ...overrides,
  };
}

function fixture(overrides: Partial<RequestInboxCoordinatorDeps> = {}) {
  let currentReads = reads();
  const deps: RequestInboxCoordinatorDeps = {
    readRequests: async () => currentReads,
    backendFor: () => backend,
    keyFor: (serverID, sessionID) => `${serverID}:${sessionID}`,
    sessionEpoch: () => 1,
    isSessionCurrent: () => true,
    isRegisteredBackend: () => true,
    directoryOf: () => '/work',
    previousPermissionIDOf: () => 'p1',
    cachedFormsOf: () => [],
    attachedRoute: () => ({ serverID: 'srv', sessionID: 'ses' }),
    scope: () => new Set(['ses']),
    describeError: (reason) => String(reason),
    verify: async () => ({ verified: new Set(), unrelated: new Set(), pending: new Set() }),
    ...overrides,
  };
  return {
    deps,
    coordinator: new RequestInboxCoordinator(deps),
    setReads: (value: RequestReads) => {
      currentReads = value;
    },
  };
}

async function collect(
  generator: AsyncGenerator<readonly RequestInboxCommand[], void, void>,
): Promise<RequestInboxCommand[][]> {
  const batches: RequestInboxCommand[][] = [];
  for await (const batch of generator) batches.push([...batch]);
  return batches;
}

describe('request inbox coordinator (#310)', () => {
  test('an empty error record is omitted from the store', () => {
    expect(requestErrorsValue({})).toBeUndefined();
    expect(requestErrorsValue({ forms: 'offline' })).toEqual({ forms: 'offline' });
  });

  test('authoritative results publish in one batch with no error', async () => {
    const f = fixture();
    expect(await collect(f.coordinator.refresh('ses', 'srv'))).toEqual([
      [
        { kind: 'set-permissions', key: 'srv:ses', value: [permission()] },
        { kind: 'set-forms', key: 'srv:ses', value: [form('f1')] },
        { kind: 'set-request-errors', key: 'srv:ses', value: undefined },
      ],
    ]);
  });

  test('a rejected permissions endpoint publishes no value but still resets focus', async () => {
    const f = fixture();
    f.setReads(
      reads({
        permissions: { status: 'rejected', reason: 'denied' },
        forms: { status: 'rejected', reason: 'offline' },
      }),
    );
    const batches = await collect(f.coordinator.refresh('ses', 'srv'));
    expect(batches).toEqual([
      [
        { kind: 'set-forms', key: 'srv:ses', value: [] },
        {
          kind: 'set-request-errors',
          key: 'srv:ses',
          value: { permissions: 'denied', forms: 'offline' },
        },
        { kind: 'reset-permission-focus' },
      ],
    ]);
  });

  test('a successful retry keeps deliberate focus for the same request', async () => {
    const f = fixture();
    const batches = await collect(f.coordinator.refresh('ses', 'srv'));
    expect((batches[0] ?? []).map((c) => c.kind)).not.toContain('reset-permission-focus');
  });

  test('the authoritative batch is yielded before verification runs', async () => {
    let verifyCalls = 0;
    const f = fixture({
      readRequests: async () =>
        reads({ locationForms: { status: 'fulfilled', value: [form('child', 'child')] } }),
      scope: () => new Set(['ses']),
      verify: async () => {
        verifyCalls += 1;
        return { verified: new Set(), unrelated: new Set(), pending: new Set() };
      },
    });
    const generator = f.coordinator.refresh('ses', 'srv');
    const first = await generator.next();
    expect(first.done).toBe(false);
    expect(verifyCalls).toBe(0);
    const second = await generator.next();
    expect(verifyCalls).toBe(1);
    expect(second.done).toBe(false);
    expect((second.value ?? []).map((c) => c.kind)).toEqual(['set-forms', 'set-request-errors']);
    expect((await generator.next()).done).toBe(true);
  });

  test('a verification error is appended to the second batch without clearing the first', async () => {
    const f = fixture({
      readRequests: async () =>
        reads({ locationForms: { status: 'fulfilled', value: [form('child', 'child')] } }),
      verify: async () => ({
        verified: new Set<string>(),
        unrelated: new Set<string>(),
        pending: new Set(['child']),
        error: 'the ownership check timed out',
      }),
    });
    const batches = await collect(f.coordinator.refresh('ses', 'srv'));
    expect(batches[0]).toContainEqual({
      kind: 'set-permissions',
      key: 'srv:ses',
      value: [permission()],
    });
    expect(batches[1]?.[1]).toEqual({
      kind: 'set-request-errors',
      key: 'srv:ses',
      value: { forms: "Could not verify a child question's owner: the ownership check timed out" },
    });
  });

  test('verified descendants appear and unrelated rows disappear in the second batch', async () => {
    const f = fixture({
      readRequests: async () =>
        reads({ locationForms: { status: 'fulfilled', value: [form('child', 'child')] } }),
      verify: async () => ({
        verified: new Set(['child']),
        unrelated: new Set<string>(),
        pending: new Set<string>(),
      }),
    });
    const batches = await collect(f.coordinator.refresh('ses', 'srv'));
    expect(batches[1]?.[0]).toEqual({
      kind: 'set-forms',
      key: 'srv:ses',
      value: [form('f1'), form('child', 'child')],
    });
  });

  test('a newer refresh invalidates an older one before its second batch', async () => {
    const f = fixture({
      readRequests: async () =>
        reads({ locationForms: { status: 'fulfilled', value: [form('child', 'child')] } }),
    });
    const older = f.coordinator.refresh('ses', 'srv');
    const newer = f.coordinator.refresh('ses', 'srv');
    await older.next();
    await newer.next();
    expect((await older.next()).done).toBe(true);
  });

  test('forget hooks let a late result from a removed session be discarded', async () => {
    const f = fixture({
      readRequests: async () =>
        reads({ locationForms: { status: 'fulfilled', value: [form('child', 'child')] } }),
    });
    const generator = f.coordinator.refresh('ses', 'srv');
    await generator.next();
    f.coordinator.forgetSession('srv:ses');
    expect((await generator.next()).done).toBe(true);

    const other = f.coordinator.refresh('other', 'srv');
    await other.next();
    f.coordinator.forgetServer('srv');
    expect((await other.next()).done).toBe(true);
  });
});
