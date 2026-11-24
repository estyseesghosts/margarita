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
  type ServerProfile,
  type ServerProfiles,
} from '../config/server-profiles.ts';
import { enqueueCredentialCleanup, reconcileCredentialCleanup } from '../config/unpair-recovery.ts';
import { type ClipboardService, createSystemClipboard } from './clipboard.ts';
import { mapConcurrent } from './concurrency.ts';
import { AppController, errorText, type ServerAdmin, type ServerListing } from './controller.ts';
import { type DebugLog, noDebugLog } from './debug-log.ts';
import { openExternalUrl } from './open-url.ts';
import { pairServer } from './pairing-service.ts';
import { scanProjectFiles } from './project-files.ts';

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
  /** Monotonic process clock for startup milestones; defaults to performance.now. */
  monotonic?: () => number;
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
  /**
   * Register paired-server metadata immediately and move credential reads/restores to
   * `restoreSavedServers()` after the interactive shell mounts (#346). Tests default to the
   * synchronous path; production `main.ts` opts in.
   */
  deferSavedServers?: boolean;
  /** Called for each authenticated deferred server after it is registered (stream wiring). */
  onServerRestored?: (serverID: string) => void;
  /** Bounded credential/restore concurrency; defaults to four independent reads. */
  restoreConcurrency?: number;
  /** Clipboard transport override for tests; production uses this machine's clipboard. */
  clipboard?: ClipboardService;
  requestExit: () => void;
}>;

export type DeferredServerState = 'restoring' | 'unauthorized';

export type ProductionAssembly = Readonly<{
  servers: ServerConnectionManager;
  controller: AppController;
  /** The one client-local clipboard every copy and paste consumer shares. */
  clipboard: ClipboardService;
  /** The same admin surface the controller wires; exposed for assembly-path tests. */
  serverAdmin: ServerAdmin;
  /**
   * Reads the remaining profiles' credentials and registers them with bounded concurrency.
   * Idempotent: repeated calls share one restore. Safe after the shell has mounted.
   */
  restoreSavedServers(): Promise<string[]>;
  /**
   * Post-mount maintenance: deferred restore plus the durable unpair-credential recovery
   * queue. Runs once per process; the queue is preserved until deletion actually succeeds.
   */
  runDeferredMaintenance(): Promise<void>;
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

  // Persisted paired servers are candidates for restoration. Missing or unreadable
  // credentials never abort startup; they register as `unauthorized` with no headers, so the
  // overview can show the host without ever issuing a request. `auth: 'none'` profiles
  // restore anonymously: no stored secret exists by design and none is requested.
  const launchBase = baseOfUrl(launch.connection.baseUrl);
  const savedProfiles = profiles.profiles.filter(
    (profile) =>
      servers.get(profile.serverID) === undefined && baseOfUrl(profile.baseUrl) !== launchBase,
  );

  const keepFresh = (saved: ServerProfiles): ServerProfiles => {
    profiles = saved;
    return saved;
  };

  // Late-bound because the controller is constructed after the admin surface it receives;
  // unpairing must remove a not-yet-restored host's overview metadata as well.
  const deferredMetadata: { forget: (serverID: string) => void } = { forget: () => {} };

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
      deferredMetadata.forget(targetID);
      if (anonymous) return { credentialCleanup: 'done' };
      try {
        await input.credentials.delete(targetID);
      } catch (error) {
        try {
          await enqueueCredentialCleanup(input.paths.stateDir, targetID);
        } catch (queueError) {
          // The retry could not be recorded (e.g. a damaged queue): say so, never claim it is queued.
          return {
            credentialCleanup: 'pending',
            error: `${errorText(error)}; the retry could not be queued: ${errorText(queueError)}`,
          };
        }
        return { credentialCleanup: 'pending', error: errorText(error) };
      }
      return { credentialCleanup: 'done' };
    },
  };

  const clipboard =
    input.clipboard ??
    createSystemClipboard({
      stateDir: input.paths.stateDir,
      pid: process.pid,
      env: input.env,
    });

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
    ...(input.monotonic === undefined ? {} : { monotonic: input.monotonic }),
    saveLocalState: (state) =>
      input.saveLocalState === undefined
        ? saveState(input.paths.stateFile, state)
        : input.saveLocalState(state),
    listFiles: async (root) => {
      if (input.listFiles !== undefined) return input.listFiles(root);
      const scan = await scanProjectFiles(root);
      if (
        scan.truncated !== undefined &&
        scan.truncated !== 'files' &&
        scan.truncated !== 'aborted'
      ) {
        debugLog.write('file-scan-truncated', { reason: scan.truncated });
        controller.showNotice(
          `File suggestions may be incomplete (scan stopped: ${scan.truncated} limit).`,
          'dim',
        );
      }
      if (scan.unreadable.count > 0) {
        debugLog.write('file-scan-unreadable', {
          count: scan.unreadable.count,
          samples: scan.unreadable.samples,
        });
        const plural = scan.unreadable.count === 1 ? 'directory' : 'directories';
        controller.showNotice(
          `File suggestions may be incomplete (${scan.unreadable.count} unreadable ${plural}).`,
          'dim',
        );
      }
      return {
        files: scan.files,
        complete: !scan.incomplete,
        ...(scan.incomplete
          ? {
              detail:
                scan.truncated !== undefined && scan.truncated !== 'files'
                  ? `scan stopped: ${scan.truncated} limit`
                  : scan.unreadable.count > 0
                    ? `${scan.unreadable.count} unreadable ${scan.unreadable.count === 1 ? 'directory' : 'directories'}`
                    : 'scan did not cover the whole project',
            }
          : {}),
      };
    },
    ...(input.remoteFilesystem === undefined ? {} : { remoteFilesystem: input.remoteFilesystem }),
    requestExit: input.requestExit,
    copyFallbackDir: input.paths.stateDir,
    // OSC 52 only when a real terminal can receive it AND the single set operation fits the
    // explicit byte limit; otherwise save an exact local file with a visible path (#105, #131).
    // The fallback directory is client-local state, never the active (possibly remote) cwd (#153).
    // One client-local clipboard: native first, OSC 52 where the terminal owns the channel,
    // and an explicit owner-only file only when the caller allows it (#105, #131).
    // The fallback directory is client-local state, never the active (possibly remote) cwd (#153).
    clipboard,
    // External MCP elicitations open in the client's browser only after http(s) validation.
    openUrl: (url) => openExternalUrl(url, process.platform),
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

  deferredMetadata.forget = (serverID) => controller.resolveDeferredServer(serverID, 'ready');

  // Deferred restoration (#346): the launch host and shell never wait for unrelated saved
  // servers or their credential backends. The metadata is registered immediately so the
  // overview can name hosts while they restore; credentials are read with bounded
  // concurrency only when `runDeferredMaintenance()` is called after the shell mounts.
  const clock = input.monotonic ?? (() => performance.now());
  const deferredRestore = input.deferSavedServers === true;
  const restoreConcurrency = Math.max(1, input.restoreConcurrency ?? 4);
  let restoreInFlight: Promise<string[]> | undefined;
  let maintenanceInFlight: Promise<void> | undefined;
  let cleanupCompleted = false;

  const restoreOne = async (
    profile: ServerProfile,
  ): Promise<{ serverID: string; authorized: boolean; skipped: boolean }> => {
    const started = clock();
    const anonymous = profile.auth === 'none';
    let secret: string | undefined;
    let credentialMs = 0;
    if (!anonymous) {
      const credentialStarted = clock();
      try {
        secret = await input.credentials.get(profile.serverID);
      } catch {
        // Missing, locked and unavailable stores all mean the same thing here: the host is
        // registered unauthorized and no request is issued with an invented credential.
        secret = undefined;
      }
      credentialMs = Math.max(0, clock() - credentialStarted);
      // Explicitly report subprocess-backed credential cost (Windows DPAPI spawns PowerShell)
      // without ever logging the secret or the stored blob.
      debugLog.write('credential-read', {
        serverID: profile.serverID,
        platform: input.platform,
        store: input.credentials.kind,
        ms: Math.round(credentialMs * 100) / 100,
        found: secret !== undefined,
      });
    }
    // The user may have unpaired the host while its credential read was in flight. Never
    // resurrect a removed profile; the durable queue/credential cleanup remains authoritative.
    if (!profiles.profiles.some((entry) => entry.serverID === profile.serverID)) {
      return { serverID: profile.serverID, authorized: false, skipped: true };
    }
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
    controller.resolveDeferredServer(profile.serverID, authorized ? 'ready' : 'unauthorized');
    debugLog.write('server-restored', {
      serverID: profile.serverID,
      authorized,
      credentialMs: Math.round(credentialMs * 100) / 100,
      totalMs: Math.round((clock() - started) * 100) / 100,
    });
    if (authorized) {
      input.onServerRestored?.(profile.serverID);
      // A deferred host appears after the shell mounted, so its first page is not part of the
      // launch bootstrap. Synchronous composition still lets bootstrap load every host once.
      if (deferredRestore) void controller.loadSessions(profile.serverID).catch(() => {});
    }
    return { serverID: profile.serverID, authorized, skipped: false };
  };

  const restoreSavedServers = (): Promise<string[]> => {
    if (restoreInFlight !== undefined) return restoreInFlight;
    restoreInFlight = (async () => {
      if (savedProfiles.length === 0) return [];
      const results = await mapConcurrent(savedProfiles, restoreConcurrency, restoreOne);
      return results.filter((entry) => !entry.skipped).map((entry) => entry.serverID);
    })();
    return restoreInFlight;
  };

  const runCredentialCleanup = async (): Promise<void> => {
    if (cleanupCompleted) return;
    cleanupCompleted = true;
    try {
      const unpairRecovery = await reconcileCredentialCleanup(
        input.paths.stateDir,
        input.credentials,
      );
      if (unpairRecovery.cleared > 0 || unpairRecovery.remaining.length > 0) {
        debugLog.write('unpair-recovery', {
          cleared: unpairRecovery.cleared,
          remaining: unpairRecovery.remaining,
        });
      }
    } catch (error) {
      // A damaged queue must not block startup, and must not be reported as "nothing pending".
      debugLog.write('unpair-recovery', { failed: errorText(error) });
      controller.showNotice(errorText(error), 'error', false);
    }
  };

  const runDeferredMaintenance = (): Promise<void> => {
    if (maintenanceInFlight !== undefined) return maintenanceInFlight;
    maintenanceInFlight = (async () => {
      const started = clock();
      let restored: string[] = [];
      let restoreError: string | undefined;
      try {
        restored = await restoreSavedServers();
      } catch (error) {
        restoreError = errorText(error);
        debugLog.write('server-restore-failed', { error: restoreError });
        controller.showNotice(`Could not restore paired servers: ${restoreError}`, 'error', false);
      }
      const cleanupStarted = clock();
      await runCredentialCleanup();
      debugLog.write('post-mount-maintenance', {
        restoreMs: Math.round((cleanupStarted - started) * 100) / 100,
        cleanupMs: Math.round((clock() - cleanupStarted) * 100) / 100,
        restored: restored.length,
        ...(restoreError === undefined ? {} : { restoreError }),
      });
    })();
    return maintenanceInFlight;
  };

  if (input.deferSavedServers === true) {
    controller.registerDeferredServers(
      savedProfiles.map((profile) => ({
        serverID: profile.serverID,
        label: profile.shortname,
        baseUrl: profile.baseUrl,
        state: 'restoring' as const,
      })),
    );
  } else {
    // Legacy/synchronous composition (tests and non-interactive callers). It still uses the
    // same bounded restore and timing path, just before returning instead of after mount.
    await restoreSavedServers();
    await runCredentialCleanup();
  }

  return {
    servers,
    controller,
    clipboard,
    serverAdmin,
    restoreSavedServers,
    runDeferredMaintenance,
  };
}
