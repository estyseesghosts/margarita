import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Backend, createBackend } from '../../src/adapter/backend.ts';
import { type MockModel, startMockModel } from './mock-model.ts';

/**
 * A private, throwaway OpenCode service for the writable suite.
 *
 * It is a standalone `opencode serve` on a free loopback port. All four XDG roots and the
 * workspace live under one temp directory, so nothing is read from or written to the user's
 * OpenCode config, data or sessions, and the user's background service is never contacted.
 * `stop()` kills the process and deletes the directory.
 */
export type DisposableService = Readonly<{
  backend: Backend;
  baseUrl: string;
  /** Auth headers for building a raw SDK client (fixture capture). */
  headers: Readonly<Record<string, string>>;
  /** Workspace directory sessions are created in. */
  workspace: string;
  model: MockModel;
  /** Model reference configured as the default. */
  modelRef: { providerID: string; modelID: string };
  stop: () => Promise<void>;
}>;

const startupTimeoutMs = 30_000;

export async function startDisposableService(): Promise<DisposableService> {
  const root = await mkdtemp(join(tmpdir(), 'marg-writable-'));
  const workspace = join(root, 'workspace');
  const configDir = join(root, 'config', 'opencode');
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true });

  const model = startMockModel();
  await writeFile(
    join(configDir, 'opencode.json'),
    JSON.stringify({
      providers: {
        mock: {
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: model.url, apiKey: 'mock-key' },
          models: { 'mock-1': { name: 'Mock 1' }, 'mock-2': { name: 'Mock 2' } },
        },
      },
      model: 'mock/mock-1',
      permission: { bash: 'ask' },
    }),
  );

  const port = await freePort();
  const child = Bun.spawn(
    ['opencode', 'serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'],
    {
      cwd: workspace,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_CACHE_HOME: join(root, 'cache'),
        XDG_STATE_HOME: join(root, 'state'),
      },
    },
  );

  const stop = async (): Promise<void> => {
    killService(child, port);
    await Promise.race([child.exited, Bun.sleep(5_000)]);
    await model.stop();
    // Windows can hold SQLite and log handles for a while after the process is gone. A
    // leftover temp directory is not a test failure, so cleanup is best effort.
    await rm(root, { recursive: true, force: true, maxRetries: 120, retryDelay: 250 }).catch(
      (error: unknown) => {
        console.warn(`could not remove disposable service directory ${root}: ${String(error)}`);
      },
    );
  };

  try {
    const password = await readPassword(child.stdout, startupTimeoutMs);
    const baseUrl = `http://127.0.0.1:${port}`;
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    const backend = createBackend({
      baseUrl,
      headers: { authorization },
      origin: 'remote',
    });
    return {
      backend,
      baseUrl,
      headers: { authorization },
      workspace,
      model,
      modelRef: { providerID: 'mock', modelID: 'mock-1' },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Stops the service. The `opencode` launcher can hand off to a detached child on Windows, so
 * the process actually serving `port` is found by its listening socket and killed too.
 * Only the process bound to this suite's own random port is ever touched.
 */
function killService(child: Bun.Subprocess, port: number): void {
  child.kill();
  if (process.platform !== 'win32') return;
  const script = `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`;
  Bun.spawnSync(['powershell', '-NoProfile', '-Command', script], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = probe.port;
  if (port === undefined) throw new Error('could not reserve a loopback port');
  await probe.stop(true);
  return port;
}

/** Reads the server's startup output until it announces its generated password. */
async function readPassword(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffered = '';
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => null),
      ]);
      if (next === null || next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      const match = /server password (\S+)/.exec(buffered);
      if (match?.[1] !== undefined) return match[1];
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(
    `opencode serve did not announce a password within ${timeoutMs} ms:\n${buffered}`,
  );
}
