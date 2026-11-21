import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Backend } from '../adapter/backend.ts';
import { createBackend } from '../adapter/backend.ts';
import type { Connection } from '../adapter/connection.ts';
import { type PairingFetch } from '../adapter/pairing.ts';
import { ServerConnectionManager } from '../adapter/server-manager.ts';
import type { AppConfig } from '../config/config.ts';
import type { CredentialStore } from '../config/credentials.ts';
import { fileGoalStore, type GoalStore } from '../config/goal-store.ts';
import { type LocalState, type SaveResult, saveState } from '../config/local-state.ts';
import {
  addServerProfile,
  removeServerProfile,
  renameServerProfile,
  type ServerProfiles,
} from '../config/server-profiles.ts';
import { enqueueCredentialCleanup, reconcileCredentialCleanup } from '../config/unpair-recovery.ts';
import { osc52Clipboard } from '../domain/osc52.ts';
import { AppController, errorText, type ServerAdmin, type ServerListing } from './controller.ts';
import { type DebugLog, noDebugLog } from './debug-log.ts';
import { pairServer } from './pairing-service.ts';
import { listProjectFiles } from './project-files.ts';

export type AppPaths = Readonly<{
  stateFile: string;
  serversFile: string;
  stateDir: string;
}>;

/** One already-connected server to register before anything else happens. */
export type AssemblyConnection = Readonly<{
  serverID: string;
  label?: string;
  connection: Connection;
  backend: Backend;
  remoteFilesystem?: boolean;
  /** The server's own path style; the launch connection records its own (never assumed to be the frontend OS). */
  platform?: NodeJS.Platform;
}>;

/**
 * Everything the production controller needs. Callers pre-load files (config, profiles,
 * local state) and pick credentials; the assembly performs the wiring main.ts used to do
 * inline, so tests can drive the exact same composition with fake backends.
 */
export type ProductionAssemblyInput = Readonly<{
  config: AppConfig;
  platform: NodeJS.Platform;
  cwd: string;
  /** Real client launch directory, even when cwd names a remote project. */
  clientCwd?: string;
  version: string;
  paths: AppPaths;
  env: NodeJS.ProcessEnv;
  credentials: CredentialStore;
  /** The launch connection(s), already connected and verified by the caller. */
  connections: readonly AssemblyConnection[];
  profiles: ServerProfiles;
  localState: LocalState;
  /** True only for the directly configured launch connection; paired servers get their own. */
  remoteFilesystem?: boolean;
  now?: () => number;
  goalStore?: GoalStore;
  debugLog?: DebugLog;
  /** Reports host health to the manager so the overview dots reflect reality. */
  applyHealth?: (serverID: string, result: { ok: true } | { ok: false; error: unknown }) => void;
  /** Test hooks; production callers leave these unset. */
  listFiles?: (root: string) => Promise<string[]>;
  saveLocalState?: (state: LocalState) => Promise<SaveResult | void>;
  /** Pairing transport override for tests; production uses the real fetch. */
  pairingFetch?: PairingFetch;
  generateID?: () => string;
  /** Backend factory override for restore/pair paths; production uses the real SDK backend. */
  createBackend?: typeof createBackend;
  requestExit: () => void;
}>;

export type ProductionAssembly = Readonly<{
  servers: ServerConnectionManager;
  controller: AppController;
  /** The same admin surface the controller wires; exposed for assembly-path tests. */
  serverAdmin: ServerAdmin;
}>;

/**
 * Starts (or replaces) the event stream for one server. Per-server stream status is applied
 * to the manager; the single UI stream badge is driven by the launch server only, decided
 * inside the controller.
 */
export function wireServerStream(
  servers: ServerConnectionManager,
  controller: AppController,
  targetID: string,
): void {
  servers.startStream(targetID, {
    onBatch: (_serverID, events, resync) => controller.onEvents(targetID, events, resync),
    onStatus: (_serverID, status) => {
      const state =
        status === 'live' ? 'online' : status === 'connecting' ? 'connecting' : 'offline';
      servers.setState(targetID, state);
      controller.onStreamStatus(targetID, status);
    },
  });
}

/** Trailing slashes are never meaningful for server identity; URLs are compared without them. */
function baseOfUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Wires the server manager, credentials and profile store to the app controller exactly
 * as the real binary does. Used by `main.ts` and by production-composition tests, so the
 * missing-resolver class of bug cannot slip back in between the two.
 */
export async function createProductionAssembly(
  input: ProductionAssemblyInput,
): Promise<ProductionAssembly> {
  const launch = input.connections[0];
  if (launch === undefined)
    throw new Error('The production assembly needs at least one connection.');
  const launchServerID = launch.serverID;
  const launchBackend = launch.backend;
  const servers = new ServerConnectionManager();
  // The launch host is local only when it shares this machine's filesystem; a --remote
  // launch connection must not inherit the frontend OS.
  const launchIsLocal = input.remoteFilesystem !== true;
  for (const registration of input.connections) {
    const platform =
      registration.platform ??
      (registration === launch && launchIsLocal ? input.platform : undefined);
    servers.add({
      serverID: registration.serverID,
      ...(registration.label === undefined ? {} : { label: registration.label }),
      connection: registration.connection,
      backend: registration.backend,
      remoteFilesystem:
        registration.remoteFilesystem ?? registration.connection.origin === 'remote',
      ...(platform === undefined ? {} : { platform }),
    });
    servers.setState(registration.serverID, 'online');
  }
  const debugLog = input.debugLog ?? noDebugLog;
  let profiles = input.profiles;

  // Restore every persisted paired server alongside the launch connection. Missing or
  // unreadable credentials never abort startup; they register as `unauthorized` with no
  // headers, so the overview can show the host without ever issuing a request.
  // `auth: 'none'` profiles restore anonymously: no stored secret exists by design and
  // none is requested — a launch-time health check proves the host is reachable.
  const launchBase = baseOfUrl(launch.connection.baseUrl);
  for (const profile of profiles.profiles) {
    if (servers.get(profile.serverID) !== undefined) continue;
    if (baseOfUrl(profile.baseUrl) === launchBase) continue;
    const anonymous = profile.auth === 'none';
    const secret = anonymous
      ? undefined
      : await input.credentials.get(profile.serverID).catch(() => undefined);
    const auth = profile.auth ?? 'bearer';
    const headers =
      anonymous || secret === undefined
        ? {}
        : auth === 'basic'
          ? { authorization: `Basic ${Buffer.from(`opencode:${secret}`).toString('base64')}` }
          : { authorization: `Bearer ${secret}` };
    const authorized = anonymous || secret !== undefined;
    const connection: Connection = { baseUrl: profile.baseUrl, headers, origin: 'remote' };
    const restored = (input.createBackend ?? createBackend)(connection, {
      serverID: profile.serverID,
      toolOutputChars: input.config.transcript.toolOutputChars,
    });
    servers.add({
      serverID: profile.serverID,
      label: profile.shortname,
      connection,
      backend: restored,
      remoteFilesystem: true,
      ...(profile.platform === undefined ? {} : { platform: profile.platform }),
    });
    servers.setState(profile.serverID, authorized ? 'connecting' : 'unauthorized');
    debugLog.write('server-restored', {
      serverID: profile.serverID,
      authorized,
    });
  }

  const keepFresh = (saved: ServerProfiles): ServerProfiles => {
    profiles = saved;
    return saved;
  };

  const serversListing = (): ServerListing[] =>
    servers.list().map((entry) => ({
      serverID: entry.serverID,
      label: entry.label,
      baseUrl: entry.backend.baseUrl,
      state: entry.state,
      active: entry.serverID === launchServerID,
    }));

  const serverAdmin: ServerAdmin = {
    list: () => serversListing(),
    rename: async (targetID, label) => {
      const saved = keepFresh(await renameServerProfile(input.paths.serversFile, targetID, label));
      servers.setLabel(targetID, label);
      return saved.profiles.map((profile) => ({
        serverID: profile.serverID,
        label: profile.shortname,
        baseUrl: profile.baseUrl,
        state: servers.get(profile.serverID)?.state ?? 'offline',
        active: profile.serverID === launchServerID,
      }));
    },
    unpair: async (targetID) => {
      // An `auth: none` profile has no secret by design, so the credential store is never
      // consulted: a machine without a working keyring can still forget an anonymous host.
      // For authenticated hosts the registry entry is removed first: a failure before that
      // point leaves both profile and credential intact (#156). If credential cleanup then
      // fails, the ID is queued for a durable retry at next startup instead of stranding an
      // unusable registered host or silently losing the secret.
      const anonymous =
        profiles.profiles.find((profile) => profile.serverID === targetID)?.auth === 'none';
      keepFresh(await removeServerProfile(input.paths.serversFile, targetID));
      await servers.remove(targetID);
      if (anonymous) return { credentialCleanup: 'done' };
      try {
        await input.credentials.delete(targetID);
      } catch (error) {
        await enqueueCredentialCleanup(input.paths.stateDir, targetID);
        return { credentialCleanup: 'pending', error: errorText(error) };
      }
      return { credentialCleanup: 'done' };
    },
  };

  const controller = new AppController({
    backend: launchBackend,
    serverID: launchServerID,
    config: input.config,
    localState: input.localState,
    platform: input.platform,
    cwd: input.cwd,
    clientCwd: input.clientCwd ?? process.cwd(),
    version: input.version,
    now: input.now ?? Date.now,
    saveLocalState: (state) =>
      input.saveLocalState === undefined
        ? saveState(input.paths.stateFile, state)
        : input.saveLocalState(state),
    listFiles: (root) =>
      input.listFiles === undefined ? listProjectFiles(root) : input.listFiles(root),
    ...(input.remoteFilesystem === undefined ? {} : { remoteFilesystem: input.remoteFilesystem }),
    requestExit: input.requestExit,
    copyFallbackDir: input.paths.stateDir,
    // OSC 52 only when a real terminal can receive it AND the single set operation fits the
    // explicit byte limit; otherwise save an exact local file with a visible path (#105, #131).
    // The fallback directory is client-local state, never the active (possibly remote) cwd (#153).
    copyText: async (text) => {
      const sequence =
        input.env['TERM'] !== 'dumb' && process.stdout.isTTY ? osc52Clipboard(text) : undefined;
      if (sequence !== undefined) {
        process.stdout.write(sequence);
        return { method: 'clipboard' };
      }
      await mkdir(input.paths.stateDir, { recursive: true });
      const path = join(input.paths.stateDir, `marg-copy-${process.pid}-${randomUUID()}.txt`);
      await Bun.write(path, text);
      try {
        await chmod(path, 0o600);
      } catch {
        // Filesystems without POSIX permission bits still keep the exact bytes; report the path.
      }
      return { method: 'file', path };
    },
    goalStore:
      input.goalStore ??
      fileGoalStore(join(input.paths.stateDir, 'goals'), () => new Date().toISOString()),
    pair: async (request) => {
      const result = await pairServer(request, {
        servers,
        profiles: () => profiles,
        addProfile: async (inputProfile) =>
          keepFresh(await addServerProfile(input.paths.serversFile, inputProfile)),
        credentials: input.credentials,
        ...(input.pairingFetch === undefined ? {} : { fetch: input.pairingFetch }),
        ...(input.generateID === undefined ? {} : { generateID: input.generateID }),
        ...(input.createBackend === undefined ? {} : { createBackend: input.createBackend }),
        ...(input.env['MARGARITA_SERVER_PASSWORD'] === undefined
          ? {}
          : { password: input.env['MARGARITA_SERVER_PASSWORD'] }),
        ...(input.env['MARGARITA_ALLOW_INSECURE_HTTP'] === '1' ? { allowInsecureHttp: true } : {}),
        toolOutputChars: input.config.transcript.toolOutputChars,
      });
      // The new host joins subscriptions and the overview immediately: wire its stream and
      // re-aggregate without a restart.
      wireServerStream(servers, controller, result.serverID);
      await controller.loadSessions().catch(() => {});
      return { shortname: result.shortname };
    },
    serverAdmin,
    /** Production wiring: the manager's fail-closed resolver, never a silent fallback. */
    backendFor: (serverID) => servers.backendFor(serverID),
    serverIDs: () => servers.list().map((managed) => managed.serverID),
    serverInfo: (targetID) => {
      const managed = servers.get(targetID);
      if (managed === undefined) return undefined;
      return { label: managed.label, online: managed.state === 'online' };
    },
    setServerHealth: (targetID, result) => servers.applyHealth(targetID, result),
    /** Per-server path style from authenticated metadata; never the frontend's. */
    platformFor: (targetID) => servers.platformFor(targetID),
    debugLog,
  });

  // Reconcile an unpair whose credential deletion failed in a previous run (#156).
  const unpairRecovery = await reconcileCredentialCleanup(input.paths.stateDir, input.credentials);
  if (unpairRecovery.cleared > 0 || unpairRecovery.remaining.length > 0) {
    debugLog.write('unpair-recovery', {
      cleared: unpairRecovery.cleared,
      remaining: unpairRecovery.remaining,
    });
  }

  return { servers, controller, serverAdmin };
}
