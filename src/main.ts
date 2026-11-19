#!/usr/bin/env bun
import { isAbsolute, resolve } from 'node:path';

import { createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';

import packageJson from '../package.json' with { type: 'json' };
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
import { App } from './ui/app.tsx';
import { pickTheme } from './ui/theme.ts';

const version = packageJson.version;

async function main(argv: readonly string[]): Promise<number> {
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
      return run(parsed.options);
    default:
      return exitCodes.usage;
  }
}

async function run(options: CliOptions): Promise<number> {
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
    const code = await execute(options, debugLog);
    debugLog.write('exit', { code, ms: Date.now() - startedAt });
    return code;
  } catch (error) {
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

async function execute(options: CliOptions, debugLog: DebugLog): Promise<number> {
  const env = process.env;
  const platform = process.platform;
  const localCwd = options.cwd === undefined ? process.cwd() : absolute(options.cwd);
  const paths = appPaths(env, platform);
  const configLoad = await loadConfig(options.config ?? paths.configFile);
  for (const warning of configLoad.warnings) process.stderr.write(`config: ${warning}\n`);
  const keymapBuild = buildKeymap(configLoad.config.keys);
  for (const error of keymapBuild.errors) process.stderr.write(`keys: ${error}\n`);

  const profileLoad = await loadServerProfiles(paths.serversFile);
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
      const secret = await credentials.get(profile.serverID).catch(() => undefined);
      if (secret === undefined) {
        process.stderr.write(
          `marg: no saved credential for "${profile.shortname}". Re-pair it or set MARGARITA_SERVER_PASSWORD.\\n`,
        );
        return exitCodes.unauthorized;
      }
      connection = {
        baseUrl: profile.baseUrl,
        headers: {
          authorization:
            profile.auth === 'basic'
              ? `Basic ${Buffer.from(`opencode:${secret}`).toString('base64')}`
              : `Bearer ${secret}`,
        },
        origin: 'remote',
      };
      serverID = profile.serverID;
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
      const resolved = resolveWorkingDirectory({
        cwd: options.cwd,
        remote: connection.origin === 'remote',
        localCwd,
        platform,
      });
      if (!resolved.ok) {
        process.stderr.write(`marg: ${resolved.message}\n`);
        return exitCodes.usage;
      }
      cwd = resolved.directory;
    }
    backend = createBackend(connection, {
      serverID,
      toolOutputChars: configLoad.config.transcript.toolOutputChars,
    });
    remoteFilesystem = connection.origin === 'remote';
    launchConnection = { serverID, connection, backend, remoteFilesystem };
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
  } catch (error) {
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
  if (stateLoad.warning !== undefined) process.stderr.write(`${stateLoad.warning}\n`);

  const exit: { request?: () => void } = {};
  const { servers, controller } = await createProductionAssembly({
    config: configLoad.config,
    platform,
    cwd,
    version,
    paths: { stateFile: paths.stateFile, serversFile: paths.serversFile, stateDir: paths.stateDir },
    env,
    credentials,
    connections: launchConnection === undefined ? [] : [launchConnection, ...connectionsExtra],
    profiles,
    localState: stateLoad.state,
    remoteFilesystem,
    debugLog,
    requestExit: () => exit.request?.(),
  });

  try {
    await controller.bootstrap();
    debugLog.write('bootstrap', { sessions: Object.keys(controller.state.sessions).length });
  } catch (error) {
    debugLog.write('bootstrap-failed', {
      errorKind: error instanceof BackendError ? error.kind : 'unknown',
    });
    process.stderr.write(
      `marg: could not load from ${redactUrl(backend.baseUrl)}: ${errorText(error)}\n`,
    );
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
      return exitCodes.usage;
    }
  }
  let existingSessionID: string | undefined;
  if (target.kind === 'resume') {
    const summary = await controller.ensureSession(target.sessionID);
    if (summary === undefined) {
      process.stderr.write(`marg: session ${target.sessionID} not found.\n`);
      return exitCodes.notFound;
    }
    existingSessionID = summary.id;
  } else if (target.kind === 'continue') {
    const latest = await controller.findLatestSessionIn(cwd);
    existingSessionID = latest?.id;
    if (existingSessionID === undefined && options.print) {
      process.stderr.write('marg: no session to continue in this project.\n');
      return exitCodes.notFound;
    }
  }

  // An existing session keeps its own selections unless a flag says otherwise, and flags are
  // checked against that session's project. A new session uses the startup project's catalog.
  let agent: { agent?: string } = {};
  let model: { model?: ModelSelection } = {};
  if (existingSessionID === undefined) {
    const resolvedAgent = controller.resolveCliAgent(options.agent);
    if (!resolvedAgent.ok) {
      process.stderr.write(`marg: ${resolvedAgent.message}\n`);
      return exitCodes.modelUnavailable;
    }
    const resolvedModel = controller.resolveCliModel({
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
    });
    if (!resolvedModel.ok) {
      process.stderr.write(`marg: ${resolvedModel.message}\n`);
      return exitCodes.modelUnavailable;
    }
    agent = resolvedAgent;
    model = resolvedModel;
    controller.setNewSessionDefaults(agent.agent, model.model);
  } else {
    const applied = await controller.applyCliOverrides(existingSessionID, {
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
    });
    if (!applied.ok) {
      process.stderr.write(`marg: ${applied.message}\n`);
      return exitCodes.modelUnavailable;
    }
  }

  if (options.print) {
    const prompt = 'prompt' in target ? target.prompt : undefined;
    if (prompt === undefined || prompt.trim() === '') {
      process.stderr.write('marg: --print needs a prompt.\n');
      return exitCodes.usage;
    }
    const abort = new AbortController();
    process.once('SIGINT', () => abort.abort());
    debugLog.write('print', { json: options.json });
    try {
      return await runPrint({
        backend,
        directory: cwd,
        prompt,
        ...(existingSessionID === undefined ? {} : { sessionID: existingSessionID }),
        ...(agent.agent === undefined ? {} : { agent: agent.agent }),
        ...(model.model === undefined ? {} : { model: model.model }),
        json: options.json,
        write: (text) => process.stdout.write(text),
        diagnostic: (text) => process.stderr.write(text),
        signal: abort.signal,
      });
    } catch (error) {
      process.stderr.write(`marg: ${errorText(error)}\n`);
      return exitCodes.failed;
    }
  }

  // One stream per registered server. Manager-level guards drop callbacks from stale
  // streams, so reconnects and unpair cannot duplicate subscriptions. Cached sessions stay
  // visible while a host is offline; only the launch server drives the single stream badge.
  for (const managed of servers.list()) {
    wireServerStream(servers, controller, serverID, managed.serverID);
  }
  const stopPump = () => servers.dispose();

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
  });
  const finished = Promise.withResolvers<void>();
  exit.request = () => {
    if (!renderer.isDestroyed) renderer.destroy();
  };
  renderer.once('destroy', () => finished.resolve());
  process.once('SIGTERM', () => {
    debugLog.write('signal', { signal: 'SIGTERM' });
    exit.request?.();
  });

  const ui = configLoad.config.ui;
  const animate =
    ui.animation && env['MARGARITA_NO_ANIMATION'] === undefined && env['NO_COLOR'] === undefined;
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

  const prompt = 'prompt' in target ? target.prompt : undefined;
  if (existingSessionID !== undefined) {
    controller.openSession(existingSessionID);
    if (prompt !== undefined) await controller.sendToSession(existingSessionID, prompt);
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
  return exitCodes.ok;
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

process.exitCode = await main(process.argv.slice(2));
