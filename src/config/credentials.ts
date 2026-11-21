import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { isRecord } from '../domain/backend-event.ts';

/**
 * Secret storage for paired servers. Secrets never live in `config.jsonc`, `servers.json`,
 * or `state.json`. When no OS credential store is available, callers must either keep the
 * credential in memory for this session or ask the user to re-pair / set the env var.
 */
export type CredentialStore = Readonly<{
  kind: 'system' | 'memory' | 'unavailable';
  /** Human-readable storage name for status lines; never includes a secret. */
  description: string;
  get(serverID: string): Promise<string | undefined>;
  set(serverID: string, secret: string): Promise<void>;
  delete(serverID: string): Promise<void>;
}>;

export class CredentialError extends Error {
  override readonly name = 'CredentialError';
}

/**
 * Removes exactly one trailing line terminator added by a subprocess, preserving every other
 * byte (including leading/trailing spaces, tabs and Unicode) in an opaque secret (#159).
 */
export function stripOutputFraming(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n') || text.endsWith('\r')) return text.slice(0, -1);
  return text;
}

export function memoryCredentialStore(): CredentialStore & { secrets: Map<string, string> } {
  const secrets = new Map<string, string>();
  return {
    kind: 'memory',
    description: 'in-memory (this process only)',
    secrets,
    async get(serverID) {
      return secrets.get(serverID);
    },
    async set(serverID, secret) {
      if (secret === '') throw new CredentialError('Refusing to store an empty credential.');
      secrets.set(serverID, secret);
    },
    async delete(serverID) {
      secrets.delete(serverID);
    },
  };
}

export function unavailableCredentialStore(reason: string): CredentialStore {
  const fail = async (): Promise<never> => {
    throw new CredentialError(
      `Secure credential storage is unavailable (${reason}). Re-pair when it is available, or set MARGARITA_SERVER_PASSWORD for a direct connection.`,
    );
  };
  return {
    kind: 'unavailable',
    description: `unavailable (${reason})`,
    get: fail,
    set: fail,
    delete: fail,
  };
}

/**
 * DPAPI-backed store on Windows. The encrypted blob is written under Margarita's state
 * directory; only the same Windows user can decrypt it. PowerShell is invoked without a
 * shell so a secret is passed on stdin, never through argv or the environment.
 */
async function runPowerShell(script: string, input?: string): Promise<string> {
  const process = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (input !== undefined) {
    void process.stdin.write(input);
    void process.stdin.end();
  }
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new CredentialError(`Credential storage failed: ${err.trim()}`);
  return stripOutputFraming(out);
}

export function windowsCredentialStore(dir: string): CredentialStore {
  const pathOf = (serverID: string) => join(dir, `credential-${safeName(serverID)}.bin`);
  const run = runPowerShell;
  return {
    kind: 'system',
    description: 'Windows DPAPI',
    async get(serverID) {
      let blob: string;
      try {
        blob = await readFile(pathOf(serverID), 'utf8');
      } catch (cause) {
        if (isRecord(cause) && cause['code'] === 'ENOENT') return undefined;
        throw new CredentialError('Could not read the stored credential.', { cause });
      }
      return run(
        'Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($p)',
        blob,
      );
    },
    async set(serverID, secret) {
      if (secret === '') throw new CredentialError('Refusing to store an empty credential.');
      const encrypted = await run(
        'Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($s); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($p)',
        secret,
      );
      await mkdir(dirname(pathOf(serverID)), { recursive: true });
      const temp = `${pathOf(serverID)}.${process.pid}.tmp`;
      await writeFile(temp, encrypted, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, pathOf(serverID));
    },
    async delete(serverID) {
      await rm(pathOf(serverID), { force: true });
    },
  };
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Picks the best available store without ever falling back to a plaintext file. Callers that
 * receive `unavailable` can still keep a secret in memory for the current session.
 */
export function systemCredentialStore(
  platform: NodeJS.Platform,
  stateDir: string,
): CredentialStore {
  if (platform === 'win32') return windowsCredentialStore(stateDir);
  if (platform === 'darwin') return keychainCredentialStore();
  if (platform === 'linux') return secretToolCredentialStore();
  return unavailableCredentialStore(`no credential store for ${platform}`);
}

function commandAvailable(command: string): boolean {
  return Bun.which(command) !== null;
}

const service = 'margarita';

/** The exact subprocess invocation the keychain store performs; everything is captured here. */
export type KeychainCommand = Readonly<{
  argv: readonly string[];
  /** Secrets are fed here, never through argv or the environment. */
  stdin?: string;
}>;

export type KeychainResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type KeychainRunner = (command: KeychainCommand) => KeychainResult;

/** Launches `security` with no inherited environment and the secret only on stdin. */
const spawnSecurity: KeychainRunner = (command) => {
  const child = Bun.spawnSync([...command.argv], {
    stdin: command.stdin === undefined ? 'ignore' : Buffer.from(command.stdin, 'utf8'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {},
  });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
};

/** Margarita-generated identities only; rejects anything that could be read as a flag. */
const serverIDPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function assertSafeAccount(serverID: string): void {
  if (!serverIDPattern.test(serverID)) {
    throw new CredentialError('Unsafe server identity for the Keychain account.');
  }
}

/**
 * Interaction with the `security` CLI. The secret travels to `security` on stdin (never
 * argv, environment, or logs): the interactive `-i` mode parses the command line from
 * stdin, so the password stays off the spawned process list. The account is validated
 * and single-quoted the shell way, and newlines are refused — the interactive command
 * line is single-line by construction. Tests inject a runner; the injected path never
 * probes the host. The `security` probe only gates the real launcher, so on non-macOS
 * hosts callers get `unavailable` instead of confusing subprocess failures.
 */
export function keychainCredentialStore(runner: KeychainRunner = spawnSecurity): CredentialStore {
  if (runner === spawnSecurity && !commandAvailable('security')) {
    return unavailableCredentialStore('security not found');
  }
  return {
    kind: 'system',
    description: 'macOS Keychain',
    async get(serverID) {
      assertSafeAccount(serverID);
      const result = runner({
        argv: ['security', 'find-generic-password', '-s', service, '-a', serverID, '-w'],
      });
      if (result.exitCode !== 0) return undefined;
      return stripOutputFraming(result.stdout);
    },
    async set(serverID, secret) {
      assertSafeAccount(serverID);
      if (secret === '') throw new CredentialError('Refusing to store an empty credential.');
      if (/[\r\n]/.test(secret)) {
        throw new CredentialError('Refusing to store a credential containing newline characters.');
      }
      const quoted = `'${secret.replaceAll("'", "'\\''")}'`;
      const result = runner({
        argv: ['security', '-i'],
        stdin: `add-generic-password -U -s ${service} -a ${serverID} -w ${quoted}\n`,
      });
      if (result.exitCode !== 0) {
        // Never echo stderr/stdout: they may contain fragments of the secret.
        throw new CredentialError('Could not write to the macOS Keychain.');
      }
    },
    async delete(serverID) {
      assertSafeAccount(serverID);
      runner({ argv: ['security', 'delete-generic-password', '-s', service, '-a', serverID] });
    },
  };
}

/** One `secret-tool` invocation; the secret (if any) goes on stdin, never argv or env. */
export type SecretToolCommand = Readonly<{ argv: readonly string[]; stdin?: string }>;
export type SecretToolResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;
export type SecretToolRunner = (command: SecretToolCommand) => Promise<SecretToolResult>;

/** Launches `secret-tool`; `env` lets tests point it at a private or unreachable bus. */
export function spawnSecretToolRunner(env?: Record<string, string>): SecretToolRunner {
  return (command) => runSecretTool(command, env);
}

const spawnSecretTool: SecretToolRunner = (command) => runSecretTool(command);

async function runSecretTool(
  command: SecretToolCommand,
  env?: Record<string, string>,
): Promise<SecretToolResult> {
  const child = Bun.spawn([...command.argv], {
    ...(env === undefined ? {} : { env }),
    stdin: command.stdin === undefined ? 'ignore' : Buffer.from(command.stdin, 'utf8'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const secretToolHelp =
  'Install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora) and run a Secret Service provider such as gnome-keyring or KeePassXC inside your login session. Headless/SSH sessions usually have none: use MARGARITA_SERVER_PASSWORD for a direct connection instead.';

/**
 * Classifies a failed `secret-tool` run without ever echoing its output into an error that
 * could be shown or logged next to a secret. `secret-tool` signals "no such item" as exit 1
 * with nothing on stderr; a locked keyring, a missing session bus or a crash all say
 * something, and must never read as "no credential" (#183).
 */
function secretToolFailure(action: string, result: SecretToolResult): CredentialError {
  const detail = result.stderr.toLowerCase();
  const reason = detail.includes('locked')
    ? 'the keyring is locked; unlock it and retry'
    : /connect|bus|dbus|autolaunch|no such file|org\.freedesktop/.test(detail)
      ? `no Secret Service is reachable on the session bus. ${secretToolHelp}`
      : /cancel|dismiss/.test(detail)
        ? 'the unlock prompt was cancelled'
        : `secret-tool exited with status ${result.exitCode}`;
  return new CredentialError(`Could not ${action} the credential: ${reason}.`);
}

const itemNotFound = (result: SecretToolResult): boolean =>
  result.exitCode === 1 && result.stderr.trim() === '' && result.stdout === '';

const attributes = (serverID: string) => ['service', service, 'server', serverID];

export function secretToolCredentialStore(runner?: SecretToolRunner): CredentialStore {
  if (runner === undefined && !commandAvailable('secret-tool')) {
    return unavailableCredentialStore(`secret-tool not found. ${secretToolHelp}`);
  }
  const run = runner ?? spawnSecretTool;
  return {
    kind: 'system',
    description: 'Secret Service',
    async get(serverID) {
      const result = await run({ argv: ['secret-tool', 'lookup', ...attributes(serverID)] });
      if (result.exitCode === 0) return stripOutputFraming(result.stdout);
      if (itemNotFound(result)) return undefined;
      throw secretToolFailure('read', result);
    },
    async set(serverID, secret) {
      if (secret === '') throw new CredentialError('Refusing to store an empty credential.');
      const result = await run({
        argv: [
          'secret-tool',
          'store',
          '--label',
          `Margarita (${serverID})`,
          ...attributes(serverID),
        ],
        stdin: secret,
      });
      if (result.exitCode !== 0) throw secretToolFailure('store', result);
    },
    async delete(serverID) {
      const result = await run({ argv: ['secret-tool', 'clear', ...attributes(serverID)] });
      // An already-absent item is a successful delete; anything else must not read as one.
      if (result.exitCode === 0 || itemNotFound(result)) return;
      throw secretToolFailure('delete', result);
    },
  };
}
