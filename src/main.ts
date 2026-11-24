#!/usr/bin/env bun
import { isAbsolute, resolve } from 'node:path';

import { createCliRenderer, createRendererClipboardAdapter } from '@opentui/core';
import { render } from '@opentui/solid';

import { type Backend, BackendError, createBackend } from './adapter/backend.ts';
import { connect, type Connection, ConnectionError, redactUrl } from './adapter/connection.ts';
import { serverIDForConnection } from './adapter/server-manager.ts';
import { errorText } from './app/controller.ts';
import { createDebugLog, type DebugLog, noDebugLog } from './app/debug-log.ts';
import {
  type AssemblyConnection,
  createProductionAssembly,
  wireServerStream,
} from './app/production-assembly.ts';
import { remoteConnectionFor } from './app/remote-connection.ts';
import { buildVersion } from './build-version.ts';
import { type CliOptions, helpText, parseArgs } from './cli/args.ts';
import { exitCodes, runPrint } from './cli/print.ts';
import { resolveWorkingDirectory } from './cli/target.ts';
import { loadConfig } from './config/config.ts';
import { systemCredentialStore } from './config/credentials.ts';
import { loadState } from './config/local-state.ts';
import { appPaths } from './config/paths.ts';
import { loadServerProfiles } from './config/server-profiles.ts';
import { buildKeymap } from './domain/keymap.ts';
import type { ModelSelection } from './domain/model-ref.ts';
import type { SessionRef } from './domain/server-identity.ts';
import { createStartupTimeline } from './perf/startup.ts';
import { App } from './ui/app.tsx';
import { pickTheme } from './ui/theme.ts';

// Monotonic elapsed time since process entry. The controller receives the same function, so
// its milestones and main.ts's stages share one origin (#345).
const processEntryClock = performance.now();
const processElapsed = (): number => performance.now() - processEntryClock;
const startupTimeline = createStartupTimeline({ clock: processElapsed });
startupTimeline.mark('process-entry');

type StartupTimelineMeta = Readonly<{
  outcome: 'ready' | 'aborted' | 'failed';
  mode: 'interactive' | 'print';
  launchMargin: 'local' | 'remote';
}>;

let startupTimelineWritten = false;

/** Flushes the in-memory timeline once; later calls are ignored. */
function writeStartupTimeline(log: DebugLog, meta: StartupTimelineMeta): void {
  if (startupTimelineWritten) return;
  startupTimelineWritten = true;
  log.write('startup-timeline', { ...startupTimeline.snapshot(), ...meta });
}

async function main(argv: readonly string[]): Promise<number> {
  const version = buildVersion();
  const parsed = parseArgs(argv);
  switch (parsed.kind) {
    case 'help':
      process.stdout.write(helpText);
      return exitCodes.ok;
    case 'version':
      process.stdout.write(`marg ${version}\n`);
      return exitCodes.ok;
    case 'error':
      process.stderr.write(`marg: ${parsed.message}\nRun marg --help for usage.\n`);
      return exitCodes.usage;
    case 'run':
      return run(parsed.options, version);
    default:
      return exitCodes.usage;
  }
}

async function run(options: CliOptions, version: string): Promise<number> {
  const env = process.env;
  const startedAt = Date.now();
  let debugLog: DebugLog = noDebugLog;
  if (options.debugLog !== undefined) {
    const created = createDebugLog(options.debugLog);
    if (!created.ok) {
      process.stderr.write(`marg: ${created.message}\n`);
      return exitCodes.usage;
    }
    debugLog = created.log;
  }
  installCrashHandlers(debugLog);
  debugLog.write('startup', {
    version,
    platform: process.platform,
    term: env['TERM'],
    colorTerm: env['COLORTERM'],
    noColor: env['NO_COLOR'] !== undefined,
    cwd: options.cwd ?? process.cwd(),
  });
  try {
    const code = await execute(options, debugLog, version);
    debugLog.write('exit', { code, ms: Date.now() - startedAt });
    return code;
  } catch (error) {
    writeStartupTimeline(debugLog, {
      outcome: 'failed',
      mode: options.print ? 'print' : 'interactive',
      launchMargin: options.remote === undefined ? 'local' : 'remote',
    });
    debugLog.write('crash', { errorName: error instanceof Error ? error.name : 'unknown' });
    process.stderr.write(`marg: ${errorText(error)}\n`);
    return exitCodes.failed;
  } finally {
    debugLog.close();
  }
}

/** Crash paths: record, then die the same way the runtime defaults would. */
function installCrashHandlers(log: DebugLog): void {
  if (!log.enabled) return;
  process.on('uncaughtException', (error) => {
    log.write('uncaught-exception', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    log.close();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.write('unhandled-rejection', {
      errorName: reason instanceof Error ? reason.name : 'unknown',
    });
    log.close();
    process.exit(1);
  });
}

async function execute(options: CliOptions, debugLog: DebugLog, version: string): Promise<number> {
  startupTimeline.mark('execute-entry');
  const timelineMeta = (outcome: StartupTimelineMeta['outcome']): StartupTimelineMeta => ({
    outcome,
    mode: options.print ? 'print' : 'interactive',
    launchMargin: options.remote === undefined ? 'local' : 'remote',
  });
  const flushTimeline = (outcome: StartupTimelineMeta['outcome']): void => {
    writeStartupTimeline(debugLog, timelineMeta(outcome));
  };
  const env = process.env;
  const platform = process.platform;
  const localCwd = options.cwd === undefined ? process.cwd() : absolute(options.cwd);
  const paths = appPaths(env, platform);
  const configLoad = await loadConfig(options.config ?? paths.configFile);
  startupTimeline.mark('config-loaded');
  for (const warning of configLoad.warnings) process.stderr.write(`config: ${warning}\n`);
  const keymapBuild = buildKeymap(configLoad.config.keys);
  for (const error of keymapBuild.errors) process.stderr.write(`keys: ${error}\n`);

  const profileLoad = await loadServerProfiles(paths.serversFile);
  startupTimeline.mark('profiles-loaded');
  if (profileLoad.warning !== undefined) process.stderr.write(`${profileLoad.warning}\n`);
  const profiles = profileLoad.profiles;
  const credentials = systemCredentialStore(platform, paths.stateDir);

  let backend: Backend;
  let remoteFilesystem = false;
  let serverID = 'local';
  let cwd = localCwd;
  let launchConnection: AssemblyConnection | undefined;
  const connectionsExtra: AssemblyConnection[] = [];
  try {
    let connection: Connection;
    if (options.remote !== undefined) {
      const alias = options.remote;
      const profile = profiles.profiles.find(
        (entry) => entry.shortname.toLowerCase() === alias.toLowerCase(),
      );
      if (profile === undefined) {
        process.stderr.write(`marg: unknown server "${alias}". Use /servers or pair it first.\n`);
        return exitCodes.notFound;
      }
      const remote = await remoteConnectionFor(profile, credentials);
      if (!remote.ok) {
        process.stderr.write(`marg: ${remote.message}\n`);
        return exitCodes.unauthorized;
      }
      connection = remote.connection;
      serverID = profile.serverID;
      remoteFilesystem = true;
      const resolved = resolveWorkingDirectory({
        cwd: options.cwd,
        remote: true,
        localCwd,
        platform,
      });
      if (!resolved.ok) {
        process.stderr.write(`marg: ${resolved.message}\n`);
        return exitCodes.usage;
      }
      cwd = resolved.directory;
      backend = createBackend(connection, {
        serverID,
        toolOutputChars: configLoad.config.transcript.toolOutputChars,
      });
      // The launch host's own path style comes from its saved profile (recorded from
      // authenticated server metadata when it was paired); never assume the frontend OS
      // for a remote host (issue #84).
      launchConnection = {
        serverID,
        connection,
        backend,
        remoteFilesystem,
        ...(profile.platform === undefined ? {} : { platform: profile.platform }),
      };
    } else {
      connection = await connect({
        ...(options.server === undefined ? {} : { server: options.server }),
        startServer: options.startServer,
        ...(env['MARGARITA_SERVER_PASSWORD'] === undefined
          ? {}
          : { remotePassword: env['MARGARITA_SERVER_PASSWORD'] }),
        ...(env['MARGARITA_ALLOW_INSECURE_HTTP'] === '1' ? { allowInsecureHttp: true } : {}),
        onStarting: () => process.stderr.write('Starting OpenCode service…\n'),
      });
      serverID = serverIDForConnection(connection);
      remoteFilesystem = connection.origin === 'remote';
      const resolved = resolveWorkingDirectory({
        cwd: options.cwd,
        remote: remoteFilesystem,
        localCwd,
        platform,
      });
      if (!resolved.ok) {
        process.stderr.write(`marg: ${resolved.message}\n`);
        return exitCodes.usage;
      }
      cwd = resolved.directory;
      backend = createBackend(connection, {
        serverID,
        toolOutputChars: configLoad.config.transcript.toolOutputChars,
      });
      // A local launch host uses the frontend's own path style.
      launchConnection = {
        serverID,
        connection,
        backend,
        remoteFilesystem,
        platform,
      };
    }
    // Policy: --server/--remote select the primary host, they never narrow the overview.
    // A discovered local service is registered alongside the explicit host and all paired
    // profiles stay available, so identical project names are always distinguishable.
    if (options.remote !== undefined || options.server !== undefined) {
      const local = await connect({ startServer: false }).catch(() => undefined);
      if (local !== undefined) {
        const localServerID = serverIDForConnection(local);
        connectionsExtra.push({
          serverID: localServerID,
          connection: local,
          backend: createBackend(local, { serverID: localServerID }),
          remoteFilesystem: false,
        });
      }
    }
    debugLog.write('connected', { baseUrl: redactUrl(backend.baseUrl), serverID });
    startupTimeline.mark('connection-ready');
  } catch (error) {
    flushTimeline('failed');
    debugLog.write('connect-failed', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    process.stderr.write(`marg: ${errorText(error)}\n`);
    if (error instanceof ConnectionError) {
      process.stderr.write(
        'Start OpenCode yourself, pass --server <url>, or use --start-server to launch it.\n',
      );
    }
    return exitCodes.unavailable;
  }

  const stateLoad = await loadState(paths.stateFile);
  startupTimeline.mark('state-loaded');
  if (stateLoad.warning !== undefined) process.stderr.write(`${stateLoad.warning}\n`);

  const exit: { request?: () => void } = {};
  const interactive = !options.print;
  // Interactive mode registers paired hosts immediately but decrypts their credentials only
  // after the shell mounts (#346). Print mode keeps the strict "everything resolved before
  // output" contract because --continue/--resume may need the remote index.
  const restoredServerListener: { current?: (serverID: string) => void } = {};
  const { servers, controller, clipboard, runDeferredMaintenance } = await createProductionAssembly(
    {
      config: configLoad.config,
      platform,
      cwd,
      clientCwd: process.cwd(),
      version,
      paths: {
        stateFile: paths.stateFile,
        serversFile: paths.serversFile,
        stateDir: paths.stateDir,
      },
      env,
      credentials,
      connections: launchConnection === undefined ? [] : [launchConnection, ...connectionsExtra],
      profiles,
      localState: stateLoad.state,
      remoteFilesystem,
      now: Date.now,
      monotonic: processElapsed,
      deferSavedServers: interactive,
      onServerRestored: (restoredID) => restoredServerListener.current?.(restoredID),
      debugLog,
      requestExit: () => exit.request?.(),
    },
  );
  startupTimeline.mark('assembly-ready');
  restoredServerListener.current = (restoredID) => {
    if (servers.get(restoredID) !== undefined) {
      wireServerStream(servers, controller, restoredID);
    }
  };

  // Start loading immediately, but never make the interactive shell wait for catalog and
  // historical session indexing before its first frame (#287). Print mode keeps the strict
  // "no TUI" contract and settles the same promise before producing output.
  const bootstrapPromise = controller.bootstrap();
  // The early shell must not turn a startup failure into an unhandled rejection while the
  // renderer is being created or the first frame is painted; the awaited copy below is
  // still the authority for the exit code.
  void bootstrapPromise.catch(() => {});
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | undefined;
  const finished = Promise.withResolvers<void>();
  const stopPump = () => servers.dispose();
  let maintenanceStarted = false;
  const startDeferredMaintenance = (): void => {
    if (maintenanceStarted) return;
    maintenanceStarted = true;
    // The shell has painted: restore unrelated paired hosts and finish the durable unpair
    // cleanup without holding up the first frame or target resolution (#346, #348).
    void runDeferredMaintenance()
      .then(() => startupTimeline.mark('post-mount-maintenance'))
      .catch((error: unknown) => {
        debugLog.write('post-mount-maintenance-failed', { error: errorText(error) });
        controller.showNotice(`Post-mount maintenance failed: ${errorText(error)}`, 'error', false);
      });
  };
  const shutdown = async () => {
    if (renderer !== undefined && !renderer.isDestroyed) renderer.destroy();
    // Stop every stream before returning so a failed target resolution cannot leave the
    // event loop alive with a TUI that has already been torn down (#287).
    await stopPump();
    controller.dispose();
    await clipboard.dispose();
  };
  if (interactive) {
    // One stream per registered server. Manager-level guards drop callbacks from stale
    // streams, so reconnects and unpair cannot duplicate subscriptions. Cached sessions stay
    // visible while a host is offline; only the launch server drives the stream badge.
    for (const managed of servers.list()) {
      wireServerStream(servers, controller, managed.serverID);
    }
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      targetFps: 30,
      useKittyKeyboard: {},
      autoFocus: false,
      openConsoleOnError: false,
    });
    startupTimeline.mark('renderer-created');
    const surface = renderer;
    surface.once('frame', () => {
      startupTimeline.mark('first-frame');
      startDeferredMaintenance();
    });
    // OSC 52 is a renderer channel (capability-aware and terminal-owned), so it is attached
    // after the renderer exists and before any UI can trigger a copy.
    clipboard.attachTerminal(createRendererClipboardAdapter(surface));
    exit.request = () => {
      if (!surface.isDestroyed) surface.destroy();
    };
    surface.once('destroy', () => finished.resolve());
    process.once('SIGTERM', () => {
      debugLog.write('signal', { signal: 'SIGTERM' });
      exit.request?.();
    });

    const ui = configLoad.config.ui;
    const animate =
      ui.animation && env['MARGARITA_NO_ANIMATION'] === undefined && env['NO_COLOR'] === undefined;
    try {
      await render(
        () =>
          App({
            controller,
            keymap: keymapBuild.keymap,
            theme: pickTheme(env, ui.theme),
            animate,
            ascii: ui.ascii || env['MARGARITA_ASCII'] !== undefined,
            env,
          }),
        renderer,
      );
      startupTimeline.mark('ui-mounted');
    } catch (error) {
      // A renderer that mounted and then failed must still restore the terminal.
      flushTimeline('failed');
      await shutdown();
      throw error;
    }
  }

  try {
    // Ctrl+C/SIGTERM destroys the renderer; do not keep the process alive waiting for a
    // catalog or session index the user has already dismissed (#287).
    const phase = await Promise.race([
      bootstrapPromise.then(() => 'ready' as const),
      finished.promise.then(() => 'aborted' as const),
    ]);
    if (phase === 'aborted') {
      flushTimeline('aborted');
      await shutdown();
      return exitCodes.ok;
    }
    const startup = controller.state.startup;
    if (startup.sessionsReadyAt !== undefined) {
      startupTimeline.markAt('session-page-ready', startup.sessionsReadyAt);
    }
    if (startup.catalogReadyAt !== undefined) {
      startupTimeline.markAt('catalog-ready', startup.catalogReadyAt);
    }
    if (startup.indexCompleteAt !== undefined) {
      startupTimeline.markAt('session-index-complete', startup.indexCompleteAt);
    }
    if (startup.hydrationReadyAt !== undefined) {
      startupTimeline.markAt('request-hydration-ready', startup.hydrationReadyAt);
    }
    if (startup.readyAt === undefined) startupTimeline.mark('composer-ready');
    else startupTimeline.markAt('composer-ready', startup.readyAt);
    flushTimeline('ready');
    debugLog.write('bootstrap', {
      sessions: Object.keys(controller.state.sessions).length,
      ...(startup.startedAt === undefined || startup.readyAt === undefined
        ? {}
        : { readyInMs: startup.readyAt - startup.startedAt }),
    });
  } catch (error) {
    flushTimeline('failed');
    debugLog.write('bootstrap-failed', {
      errorKind: error instanceof BackendError ? error.kind : 'unknown',
    });
    process.stderr.write(
      `marg: could not load from ${redactUrl(backend.baseUrl)}: ${errorText(error)}\n`,
    );
    await shutdown();
    return error instanceof BackendError && error.kind === 'unauthorized'
      ? exitCodes.unauthorized
      : exitCodes.unavailable;
  }

  const target = options.target;
  // A remote target has no meaningful implicit directory: this machine's cwd is not on the
  // remote host. Starting or continuing without an explicit remote --cwd is an error.
  if (remoteFilesystem && cwd === '') {
    if (
      target.kind === 'continue' ||
      (target.kind === 'new' && target.prompt !== undefined) ||
      (options.print && target.kind === 'new')
    ) {
      process.stderr.write(
        'marg: --remote needs --cwd <absolute path on the remote host> to start or continue a session.\n',
      );
      await shutdown();
      return exitCodes.usage;
    }
  }
  // An explicit --remote/--server host is authoritative for resume/continue: resolution must
  // never silently search unrelated hosts (#149, #152).
  const explicitServerID =
    options.remote !== undefined || options.server !== undefined ? serverID : undefined;
  let sessionRef: SessionRef | undefined;
  let resolvedDirectory = cwd;
  if (target.kind === 'resume') {
    const resolved = await controller.resolveCliSession(
      target.sessionID,
      explicitServerID === undefined ? {} : { serverID: explicitServerID },
    );
    if (!resolved.ok) {
      process.stderr.write(`marg: ${resolved.message}\n`);
      await shutdown();
      return resolved.reason === 'not-found' ? exitCodes.notFound : exitCodes.failed;
    }
    sessionRef = resolved.ref;
    resolvedDirectory = resolved.directory;
  } else if (target.kind === 'continue') {
    try {
      const latest = await controller.findLatestSessionIn(cwd, serverID);
      if (latest !== undefined) {
        sessionRef = { serverID: latest.serverID, sessionID: latest.id };
        resolvedDirectory = latest.directory;
      } else if (options.print) {
        process.stderr.write('marg: no session to continue in this project.\n');
        await shutdown();
        return exitCodes.notFound;
      }
    } catch (error) {
      process.stderr.write(`marg: could not continue in this project: ${errorText(error)}\n`);
      await shutdown();
      return exitCodes.failed;
    }
  }

  // An existing session keeps its own selections unless a flag says otherwise, and flags are
  // checked against that session's project. A new session uses the startup project's catalog.
  let agent: { agent?: string } = {};
  let model: { model?: ModelSelection } = {};
  if (sessionRef === undefined) {
    const resolvedAgent = controller.resolveCliAgent(options.agent);
    if (!resolvedAgent.ok) {
      process.stderr.write(`marg: ${resolvedAgent.message}\n`);
      await shutdown();
      return exitCodes.modelUnavailable;
    }
    const resolvedModel = controller.resolveCliModel({
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
    });
    if (!resolvedModel.ok) {
      process.stderr.write(`marg: ${resolvedModel.message}\n`);
      await shutdown();
      return exitCodes.modelUnavailable;
    }
    agent = resolvedAgent;
    model = resolvedModel;
    controller.setNewSessionDefaults(agent.agent, model.model);
  } else {
    const applied = await controller.applyCliOverrides(sessionRef, {
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
    });
    if (!applied.ok) {
      process.stderr.write(`marg: ${applied.message}\n`);
      await shutdown();
      return exitCodes.modelUnavailable;
    }
  }

  if (options.print) {
    const prompt = 'prompt' in target ? target.prompt : undefined;
    if (prompt === undefined || prompt.trim() === '') {
      process.stderr.write('marg: --print needs a prompt.\n');
      await shutdown();
      return exitCodes.usage;
    }
    const abort = new AbortController();
    process.once('SIGINT', () => abort.abort());
    debugLog.write('print', { json: options.json, serverID: sessionRef?.serverID ?? serverID });
    try {
      // Print and interactive mode share the same resolved target: an existing session is
      // always driven through its owning host's backend, never the launch backend (#149).
      const printBackend =
        sessionRef === undefined ? backend : servers.backendFor(sessionRef.serverID);
      return await runPrint({
        backend: printBackend,
        directory: resolvedDirectory,
        prompt,
        ...(sessionRef === undefined ? {} : { sessionID: sessionRef.sessionID }),
        ...(agent.agent === undefined ? {} : { agent: agent.agent }),
        ...(model.model === undefined ? {} : { model: model.model }),
        json: options.json,
        write: (text) => process.stdout.write(text),
        diagnostic: (text) => process.stderr.write(text),
        signal: abort.signal,
      });
    } catch (error) {
      process.stderr.write(`marg: ${errorText(error)}\n`);
      await shutdown();
      return exitCodes.failed;
    }
  }

  const prompt = 'prompt' in target ? target.prompt : undefined;
  if (sessionRef !== undefined) {
    controller.openSession(sessionRef.sessionID, sessionRef.serverID);
    if (prompt !== undefined) await controller.sendToSession(sessionRef, prompt);
  } else if ((target.kind === 'new' || target.kind === 'continue') && cwd !== '') {
    if (prompt === undefined) controller.startNewSession(cwd, serverID);
    else await controller.createSessionWithPrompt({ serverID, directory: cwd }, prompt);
  } else {
    controller.openOverview();
  }

  await finished.promise;
  await stopPump();
  try {
    await controller.flushLocalState();
  } catch (error) {
    process.stderr.write(`marg: local state was not fully saved: ${errorText(error)}\n`);
  }
  const revertError = await controller.flushRevertOnExit();
  if (revertError !== undefined) {
    process.stderr.write(`marg: could not cancel the staged revert: ${revertError}\n`);
  }
  controller.dispose();
  await clipboard.dispose();
  return exitCodes.ok;
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

process.exitCode = await main(process.argv.slice(2));
