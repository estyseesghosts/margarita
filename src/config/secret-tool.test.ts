import { describe, expect, test } from 'bun:test';

import {
  CredentialError,
  type SecretToolCommand,
  secretToolCredentialStore,
  type SecretToolResult,
} from './credentials.ts';

type Script = (command: SecretToolCommand) => SecretToolResult;

function storeWith(script: Script) {
  const commands: SecretToolCommand[] = [];
  const store = secretToolCredentialStore(async (command) => {
    commands.push(command);
    return script(command);
  });
  return { store, commands };
}

const ok = (stdout = ''): SecretToolResult => ({ exitCode: 0, stdout, stderr: '' });
const notFound: SecretToolResult = { exitCode: 1, stdout: '', stderr: '' };
const failing = (stderr: string): SecretToolResult => ({ exitCode: 1, stdout: '', stderr });

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (cause) {
    return cause;
  }
  return undefined;
}

describe('Secret Service store (#183)', () => {
  test('a missing item is undefined, not an error', async () => {
    const { store } = storeWith(() => notFound);
    expect(await store.get('srv_1')).toBeUndefined();
  });

  test('operational failures are never read as a missing credential', async () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['secret-tool: Could not connect: No such file or directory', 'no Secret Service'],
      ['Cannot autolaunch D-Bus without X11 $DISPLAY', 'no Secret Service'],
      ['secret-tool: Cannot get secret of a locked object', 'locked'],
      ['Prompt was dismissed or cancelled', 'cancelled'],
      ['segfault-ish gibberish', 'status 1'],
    ];
    for (const [stderr, expected] of cases) {
      const { store } = storeWith(() => failing(stderr));
      const error = await failure(() => store.get('srv_1'));
      expect(error).toBeInstanceOf(CredentialError);
      expect(String(error)).toContain(expected);
    }
  });

  test('a signal-style exit is a failure, not a missing item', async () => {
    const { store } = storeWith(() => ({ exitCode: 139, stdout: '', stderr: '' }));
    expect(await failure(() => store.get('srv_1'))).toBeInstanceOf(CredentialError);
  });

  test('writes report failure instead of silently succeeding', async () => {
    const { store } = storeWith(() => failing('Cannot get secret of a locked object'));
    expect(await failure(() => store.set('srv_1', 'value'))).toBeInstanceOf(CredentialError);
  });

  test('delete treats an absent item as done but surfaces real failures', async () => {
    expect(await failure(() => storeWith(() => notFound).store.delete('srv_1'))).toBeUndefined();
    expect(await failure(() => storeWith(() => ok()).store.delete('srv_1'))).toBeUndefined();
    const error = await failure(() =>
      storeWith(() => failing('Could not connect: No such file or directory')).store.delete(
        'srv_1',
      ),
    );
    expect(error).toBeInstanceOf(CredentialError);
  });

  test('the secret travels only on stdin and exact bytes round-trip', async () => {
    const secret = '  tab\there "quoted" \'single\' ünï 🔑 \n  ';
    const stored: string[] = [];
    const { store, commands } = storeWith((command) => {
      if (command.argv[1] === 'store') {
        stored.push(command.stdin ?? '');
        return ok();
      }
      return ok(`${stored.at(-1) ?? ''}\n`);
    });
    await store.set('srv_1', secret);
    expect(await store.get('srv_1')).toBe(secret);
    for (const command of commands) {
      expect(command.argv.join(' ')).not.toContain('tab');
      expect(command.argv.some((arg) => arg.includes('🔑'))).toBe(false);
    }
    expect(commands[0]?.stdin).toBe(secret);
  });

  test('errors never contain the secret or the tool output', async () => {
    const secret = 'hunter2-super-secret';
    const { store } = storeWith(() => failing(`locked while storing ${secret}`));
    const error = await failure(() => store.set('srv_1', secret));
    expect(String(error)).not.toContain(secret);
  });

  test('empty secrets are refused before running anything', async () => {
    const { store, commands } = storeWith(() => ok());
    expect(await failure(() => store.set('srv_1', ''))).toBeInstanceOf(CredentialError);
    expect(commands).toEqual([]);
  });
});
