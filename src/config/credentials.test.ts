import { describe, expect, test } from 'bun:test';

import {
  CredentialError,
  memoryCredentialStore,
  systemCredentialStore,
  unavailableCredentialStore,
} from './credentials.ts';

describe('credential store', () => {
  test('memory store round-trips and deletes secrets', async () => {
    const store = memoryCredentialStore();
    expect(await store.get('srv_1')).toBeUndefined();
    await store.set('srv_1', 'secret');
    expect(await store.get('srv_1')).toBe('secret');
    await store.delete('srv_1');
    expect(await store.get('srv_1')).toBeUndefined();
  });

  test('empty secrets are refused', async () => {
    const store = memoryCredentialStore();
    expect(store.set('srv_1', '')).rejects.toBeInstanceOf(CredentialError);
  });

  test('unavailable storage fails visibly instead of writing cleartext', async () => {
    const store = unavailableCredentialStore('no keyring');
    expect(store.kind).toBe('unavailable');
    expect(store.description).toContain('no keyring');
    expect(store.set('srv_1', 'secret')).rejects.toBeInstanceOf(CredentialError);
    expect(store.get('srv_1')).rejects.toBeInstanceOf(CredentialError);
  });

  test('an unsupported platform reports unavailable', () => {
    const store = systemCredentialStore('aix', '/tmp');
    expect(store.kind).toBe('unavailable');
  });
});
