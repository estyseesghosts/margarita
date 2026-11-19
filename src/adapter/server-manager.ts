import { createHash } from 'node:crypto';

import type { BackendEvent } from '../domain/backend-event.ts';
import type { Backend } from './backend.ts';
import { BackendError } from './backend.ts';
import type { Connection } from './connection.ts';
import { startEventPump, type StreamStatus } from './event-pump.ts';

/**
 * Stable identity for a directly configured connection. Discovered/started services are the
 * reserved local server; an explicit `--server` URL derives a deterministic remote ID so
 * repeat invocations address the same sessions without depending on a display name.
 */
export function serverIDForConnection(connection: Connection): string {
  if (connection.origin !== 'remote') return 'local';
  const digest = createHash('sha256').update(connection.baseUrl).digest('base64url');
  return `srv_${digest.slice(0, 16)}`;
}

/** Per-server connection state. One server's failure never changes another's. */
export type ServerState = 'connecting' | 'online' | 'offline' | 'unauthorized' | 'incompatible';

export type ManagedServer = Readonly<{
  serverID: string;
  /** Display label only; never part of identity and safe to change. */
  label: string;
  connection: Connection;
  backend: Backend;
  state: ServerState;
  error?: string;
  /** True when the server does not share this machine's filesystem. */
  remoteFilesystem: boolean;
  /**
   * Monotonic per-registration token. Stream guards compare this, never object identity:
   * `setState` replaces the managed-server object, and object identity would mark every
   * later status/event as stale.
   */
  registration: number;
}>;

export type ServerTarget = Readonly<{
  serverID: string;
  label?: string;
  connection: Connection;
  backend: Backend;
  remoteFilesystem?: boolean;
}>;

export type StreamHandlers = Readonly<{
  onBatch: (serverID: string, events: readonly BackendEvent[], resync: boolean) => void;
  onStatus: (serverID: string, status: StreamStatus, error?: unknown) => void;
}>;

export type StreamState = Readonly<{ serverID: string; status: StreamStatus }>;

/**
 * Owns the set of servers Margarita talks to. Backends are isolated: each has its own
 * connection, credentials, event stream, and status. Margarita never starts or stops a
 * remote server; removing a server only forgets it locally.
 */
export class ServerConnectionManager {
  private readonly servers = new Map<string, ManagedServer>();
  private readonly streams = new Map<string, () => Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private registrationSequence = 0;
  private disposed = false;

  /** Registers or replaces a server. Replacing aborts its old stream first. */
  add(target: ServerTarget): ManagedServer {
    this.assertOpen();
    if (this.streams.has(target.serverID)) void this.stopStream(target.serverID);
    const server: ManagedServer = {
      serverID: target.serverID,
      label: target.label ?? target.serverID,
      connection: target.connection,
      backend: target.backend,
      state: 'connecting',
      remoteFilesystem: target.remoteFilesystem ?? target.connection.origin === 'remote',
      registration: (this.registrationSequence += 1),
    };
    this.servers.set(target.serverID, server);
    this.emit();
    return server;
  }

  /** Number of registered servers; lets callers open an empty overview with cached state. */
  get size(): number {
    return this.servers.size;
  }

  get(serverID: string): ManagedServer | undefined {
    return this.servers.get(serverID);
  }

  list(): ManagedServer[] {
    return [...this.servers.values()];
  }

  /** Fails closed: unknown or removed servers never fall back to another backend. */
  backendFor(serverID: string): Backend {
    const server = this.servers.get(serverID);
    if (server === undefined) throw new Error(`Unknown server: ${serverID}`);
    return server.backend;
  }

  serverFor(serverID: string): ManagedServer {
    const server = this.servers.get(serverID);
    if (server === undefined) throw new Error(`Unknown server: ${serverID}`);
    return server;
  }

  /** Renames a server without touching its identity or any session. */
  setLabel(serverID: string, label: string): void {
    const server = this.serverFor(serverID);
    if (server.label === label) return;
    this.servers.set(serverID, { ...server, label });
    this.emit();
  }

  setState(serverID: string, state: ServerState, error?: string): void {
    const server = this.servers.get(serverID);
    if (server === undefined || server.state === state) return;
    this.servers.set(serverID, {
      ...server,
      state,
      ...(error === undefined ? {} : { error }),
    });
    this.emit();
  }

  /** Applies a health-check result without letting a stale check overwrite a newer state. */
  applyHealth(serverID: string, result: { ok: true } | { ok: false; error: unknown }): void {
    if (!this.servers.has(serverID)) return;
    if (result.ok) {
      this.setState(serverID, 'online');
      return;
    }
    const kind = result.error instanceof BackendError ? result.error.kind : 'unknown';
    const state: ServerState =
      kind === 'unauthorized' ? 'unauthorized' : kind === 'invalid' ? 'incompatible' : 'offline';
    this.setState(serverID, state, String(result.error));
  }

  /**
   * Starts the one event stream for a server. Starting again for the same server replaces the
   * previous subscription, so reconnect/unpair can never leave duplicate listeners.
   */
  startStream(serverID: string, handlers: StreamHandlers): void {
    this.assertOpen();
    const server = this.servers.get(serverID);
    if (server === undefined) return;
    void this.stopStream(serverID);
    const registration = server.registration;
    const current = (): ManagedServer | undefined => {
      const managed = this.servers.get(serverID);
      return managed !== undefined && managed.registration === registration ? managed : undefined;
    };
    const stop = startEventPump({
      source: (signal) => server.backend.events(signal),
      onBatch: (events, resync) => {
        if (current() === undefined) return; // stale stream from a replaced server
        handlers.onBatch(serverID, events, resync);
      },
      onStatus: (status, error) => {
        if (current() === undefined) return;
        handlers.onStatus(serverID, status, error);
      },
    });
    this.streams.set(serverID, stop);
  }

  /** Stops a server's stream but keeps it registered (its sessions stay cached). */
  async disconnect(serverID: string): Promise<void> {
    await this.stopStream(serverID);
    if (this.servers.has(serverID)) this.setState(serverID, 'offline');
  }

  /** Forgets a server entirely. Never tells the remote service to stop anything. */
  async remove(serverID: string): Promise<void> {
    await this.stopStream(serverID);
    if (this.servers.delete(serverID)) this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.streams.keys()].map((serverID) => this.stopStream(serverID)));
    this.servers.clear();
    this.listeners.clear();
  }

  private async stopStream(serverID: string): Promise<void> {
    const stop = this.streams.get(serverID);
    if (stop === undefined) return;
    this.streams.delete(serverID);
    await stop();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Server manager is disposed');
  }
}
