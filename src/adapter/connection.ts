import { existsSync } from 'node:fs';

import { fallback, Service } from '@opencode/client/service';

export type Connection = Readonly<{
  baseUrl: string;
  headers: Readonly<Record<string, string>>;
  origin: 'discovered' | 'started' | 'remote';
}>;

export type ConnectOptions = Readonly<{
  /** Explicit server URL; never starts a local service. */
  server?: string;
  /** Opt-in: start `opencode serve --service` when no service is registered. */
  startServer: boolean;
  /** Basic-auth password for a remote server, from env only (never argv). */
  remotePassword?: string;
  onStarting?: () => void;
}>;

export class ConnectionError extends Error {
  override readonly name = 'ConnectionError';
}

/**
 * Connects to OpenCode without disturbing an existing install:
 * 1. `--server` → use that URL as-is.
 * 2. Otherwise discover the registered local service (read-only).
 * 3. Only with `--start-server`, and only when no service is registered at all, start
 *    one through the user's own `opencode serve --service`. A version requirement is
 *    never passed, so the SDK can never replace or stop a running service.
 * Margarita never stops the service on exit.
 */
export async function connect(options: ConnectOptions): Promise<Connection> {
  if (options.server !== undefined) {
    let url: URL;
    try {
      url = new URL(options.server);
    } catch (cause) {
      throw new ConnectionError(`Invalid --server URL "${options.server}".`, { cause });
    }
    return {
      baseUrl: url.toString().replace(/\/$/, ''),
      headers: basicAuthHeaders(options.remotePassword, 'opencode'),
      origin: 'remote',
    };
  }
  const discovered = await Service.discover();
  if (discovered !== undefined) {
    return {
      baseUrl: discovered.url,
      headers: basicAuthHeaders(discovered.auth?.password, discovered.auth?.username),
      origin: 'discovered',
    };
  }
  if (existsSync(fallback())) {
    // A registration exists but is not healthy; starting another would contend with it.
    throw new ConnectionError(
      'An OpenCode service is registered but not responding. Check `opencode service status`.',
    );
  }
  if (!options.startServer) {
    throw new ConnectionError(
      'No OpenCode service is running. Start one with `opencode serve --service`, or pass --start-server.',
    );
  }
  options.onStarting?.();
  try {
    const started = await Service.ensure();
    return {
      baseUrl: started.url,
      headers: basicAuthHeaders(started.auth?.password, started.auth?.username),
      origin: 'started',
    };
  } catch (cause) {
    throw new ConnectionError('Could not start the OpenCode service.', { cause });
  }
}

function basicAuthHeaders(
  password: string | undefined,
  username: string | undefined,
): Record<string, string> {
  if (password === undefined) return {};
  const credentials = Buffer.from(`${username ?? 'opencode'}:${password}`).toString('base64');
  return { authorization: `Basic ${credentials}` };
}
