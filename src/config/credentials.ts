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
  return out.trim();
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

function keychainCredentialStore(): CredentialStore {
  if (!commandAvailable('security')) return unavailableCredentialStore('security not found');
  const service = 'margarita';
  return {
    kind: 'system',
    description: 'macOS Keychain',
    async get(serverID) {
      const result = Bun.spawnSync([
        'security',
        'find-generic-password',
        '-s',
        service,
        '-a',
        serverID,
        '-w',
      ]);
      if (result.exitCode !== 0) return undefined;
      return result.stdout.toString().trim();
    },
    async set(serverID, secret) {
      if (secret === '') throw new CredentialError('Refusing to store an empty credential.');
      const result = Bun.spawnSync([
        'security',
        'add-generic-password',
        '-U',
        '-s',
        service,
        '-a',
        serverID,
        '-w',
        secret,
      ]);
      if (result.exitCode !== 0)
        throw new CredentialError('Could not write to the macOS Keychain.');
    },
    async delete(serverID) {
      Bun.spawnSync(['security', 'delete-generic-password', '-s', service, '-a', serverID]);
    },
  };
}

function secretToolCredentialStore(): CredentialStore {
  if (!commandAvailable('secret-tool')) {
    return unavailableCredentialStore('secret-tool not found');
  }
  return {
    kind: 'system',
    description: 'Secret Service',
    async get(serverID) {
      const result = Bun.spawnSync([
        'secret-tool',
        'lookup',
        'service',
        'margarita',
        'server',
        serverID,
      ]);
      if (result.exitCode !== 0) return undefined;
      return result.stdout.toString().trim();
    },
    async set(serverID, secret) {
      if (secret === '') throw new CredentialError('Refusing to store an empty credential.');
      const process = Bun.spawn(
        [
          'secret-tool',
          'store',
          '--label',
          `Margarita (${serverID})`,
          'service',
          'margarita',
          'server',
          serverID,
        ],
        { stdin: 'pipe', stderr: 'pipe' },
      );
      void process.stdin.write(secret);
      void process.stdin.end();
      if ((await process.exited) !== 0) {
        throw new CredentialError('Could not write to the Secret Service.');
      }
    },
    async delete(serverID) {
      Bun.spawnSync(['secret-tool', 'clear', 'service', 'margarita', 'server', serverID]);
    },
  };
}
