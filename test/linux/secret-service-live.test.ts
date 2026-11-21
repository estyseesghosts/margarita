import { describe, expect, test } from 'bun:test';

import {
  CredentialError,
  secretToolCredentialStore,
  spawnSecretToolRunner,
} from '../../src/config/credentials.ts';

/**
 * Opt-in: run through `scripts/test-keyring.sh`, which creates a private session bus and
 * keyring. Refuses to run against anything else so a developer's login keyring is never used.
 */
const enabled =
  process.platform === 'linux' &&
  process.env['MARGARITA_LIVE_KEYRING'] === '1' &&
  process.env['MARGARITA_PRIVATE_KEYRING'] === '1';

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (cause) {
    return cause;
  }
  return undefined;
}

describe.skipIf(!enabled)('live Secret Service (private keyring)', () => {
  const store = secretToolCredentialStore();
  const id = `live_${process.pid}`;

  test('set, get, replace and delete round-trip exact bytes', async () => {
    const first = '  lead\ttab "q" \'s\' ünï 🔑  ';
    expect(await store.get(id)).toBeUndefined();
    await store.set(id, first);
    expect(await store.get(id)).toBe(first);
    await store.set(id, 'replacement');
    expect(await store.get(id)).toBe('replacement');
    await store.delete(id);
    expect(await store.get(id)).toBeUndefined();
    // Deleting an absent item is fine.
    await store.delete(id);
  });

  test('an unreachable bus is an operational error, never a missing credential', async () => {
    const unreachable = secretToolCredentialStore(
      spawnSecretToolRunner({
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-margarita-bus',
      }),
    );
    expect(await failure(() => unreachable.get(id))).toBeInstanceOf(CredentialError);
    expect(await failure(() => unreachable.set(id, 'x'))).toBeInstanceOf(CredentialError);
    expect(await failure(() => unreachable.delete(id))).toBeInstanceOf(CredentialError);
  });
});
