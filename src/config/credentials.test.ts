import { describe, expect, test } from 'bun:test';

import {
  CredentialError,
  type KeychainCommand,
  keychainCredentialStore,
  type KeychainResult,
  memoryCredentialStore,
  stripOutputFraming,
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

describe('subprocess framing preserves exact secret bytes (#159)', () => {
  test('only one trailing line terminator is removed', () => {
    expect(stripOutputFraming('  key  \n')).toBe('  key  ');
    expect(stripOutputFraming('\ttoken\t\r\n')).toBe('\ttoken\t');
    expect(stripOutputFraming('secret\r')).toBe('secret');
    expect(stripOutputFraming('  raw  ')).toBe('  raw  ');
    // A secret that itself ends in a newline survives because only one terminator goes.
    expect(stripOutputFraming('secret\n\n')).toBe('secret\n');
  });

  test('Keychain get returns leading/trailing whitespace and Unicode verbatim', async () => {
    const secret = '  leading\ttrailing ünicode  ';
    const found = recorder({ exitCode: 0, stdout: `${secret}\n`, stderr: '' });
    expect(await keychainCredentialStore(found.runner).get('srv_1')).toBe(secret);
  });

  test('Keychain get strips CRLF framing, not significant tabs', async () => {
    const secret = '\t key \t';
    const found = recorder({ exitCode: 0, stdout: `${secret}\r\n`, stderr: '' });
    expect(await keychainCredentialStore(found.runner).get('srv_1')).toBe(secret);
  });
});
function recorder(result: KeychainResult = { exitCode: 0, stdout: '', stderr: '' }) {
  const commands: KeychainCommand[] = [];
  const runner = (command: KeychainCommand): KeychainResult => {
    commands.push(command);
    return result;
  };
  return { commands, runner };
}

const token = 'sk_live_test_abc123';

describe('macOS Keychain credential store (issue #69)', () => {
  test('set never places the secret in argv or an environment, only on stdin', async () => {
    const { commands, runner } = recorder();
    const store = keychainCredentialStore(runner);
    await store.set('srv_1', token);
    expect(commands).toHaveLength(1);
    const [command] = commands;
    if (command === undefined) throw new Error('no command recorded');
    expect(command.argv.join(' ')).not.toContain(token);
    expect(command.argv).toEqual(['security', '-i']);
    expect(command.stdin).toContain(token);
    // The runner launches with an empty environment; the secret is on stdin only.
    expect(JSON.stringify(command)).not.toContain('env');
  });

  test('keys are rejected before any subprocess is launched', async () => {
    for (const account of ['-w', '--help', 'a b', 'a;b', 'a\nb', '']) {
      const { commands, runner } = recorder();
      const store = keychainCredentialStore(runner);
      expect(store.set(account, token)).rejects.toBeInstanceOf(CredentialError);
      expect(store.get(account)).rejects.toBeInstanceOf(CredentialError);
      expect(store.delete(account)).rejects.toBeInstanceOf(CredentialError);
      expect(commands).toHaveLength(0);
    }
  });

  test('empty and newline-bearing secrets are refused without launching anything', async () => {
    const { commands, runner } = recorder();
    const store = keychainCredentialStore(runner);
    expect(store.set('srv_1', '')).rejects.toBeInstanceOf(CredentialError);
    expect(store.set('srv_1', 'line1\nline2')).rejects.toBeInstanceOf(CredentialError);
    expect(commands).toHaveLength(0);
  });

  test('arbitrary non-newline secrets survive the interactive quoting intact', async () => {
    const { commands, runner } = recorder();
    const store = keychainCredentialStore(runner);
    const awkward = `it's "tricky" \\ with 'quotes' and $pecial & <chars>`;
    await store.set('srv_1', awkward);
    const stdin = commands[0]?.stdin ?? '';
    // Every single quote is escaped the shell way; no raw byte breaks the line.
    expect(stdin.endsWith('\n')).toBe(true);
    expect(stdin).toContain(awkward.replaceAll("'", "'\\''"));
    expect(stdin).not.toContain('\n\n');
    expect(commands[0]?.argv.join(' ')).not.toContain(awkward);
  });

  test('a keychain failure never echoes the secret in the thrown error', async () => {
    const { runner } = recorder({ exitCode: 1, stdout: `err ${token}`, stderr: `bad ${token}` });
    const store = keychainCredentialStore(runner);
    const error = await store.set('srv_1', token).catch((cause: unknown) => cause);
    if (!(error instanceof CredentialError)) throw new Error('expected a CredentialError');
    expect(error.message).not.toContain(token);
  });

  test('get returns the trimmed secret; non-zero exit reads as missing', async () => {
    const found = recorder({ exitCode: 0, stdout: `${token}\n`, stderr: '' });
    expect(await keychainCredentialStore(found.runner).get('srv_1')).toBe(token);
    const missing = recorder({ exitCode: 44, stdout: '', stderr: 'item not found' });
    expect(await keychainCredentialStore(missing.runner).get('srv_1')).toBeUndefined();
    // get never receives a secret to place anywhere.
    expect(found.commands[0]?.argv.join(' ')).not.toContain(token);
  });

  test('delete launches exactly the removal command, with no secret involved', async () => {
    const { commands, runner } = recorder();
    const store = keychainCredentialStore(runner);
    await store.set('srv_1', token);
    await store.delete('srv_1');
    expect(commands[1]?.argv).toEqual([
      'security',
      'delete-generic-password',
      '-s',
      'margarita',
      '-a',
      'srv_1',
    ]);
    expect(commands[1]?.stdin).toBeUndefined();
    expect(commands[1]?.argv.join(' ')).not.toContain(token);
  });
});

// Opt-in round-trip against the real macOS Keychain. Runs only on macOS with
// MARGARITA_KEYCHAIN_TEST=1; uses a disposable account name and always cleans up.
describe.skipIf(process.platform !== 'darwin' || process.env['MARGARITA_KEYCHAIN_TEST'] !== '1')(
  'macOS Keychain round-trip (opt-in)',
  () => {
    const account = `margarita-test-${Date.now().toString(36)}`;
    const disposable = `tok_disposable_${Date.now().toString(36)}`;
    test('set, read, replace and delete a disposable item', async () => {
      const store = keychainCredentialStore();
      try {
        await store.set(account, disposable);
        expect(await store.get(account)).toBe(disposable);
        await store.set(account, `${disposable}_v2`);
        expect(await store.get(account)).toBe(`${disposable}_v2`);
      } finally {
        await store.delete(account);
      }
      expect(await store.get(account)).toBeUndefined();
    });
  },
);
