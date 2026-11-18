#!/usr/bin/env bun
import { isAbsolute, resolve } from 'node:path';

import { createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';

import packageJson from '../package.json' with { type: 'json' };
import { type Backend, BackendError, createBackend } from './adapter/backend.ts';
import { connect, ConnectionError } from './adapter/connection.ts';
import { startEventPump } from './adapter/event-pump.ts';
import { AppController, errorText } from './app/controller.ts';
import { listProjectFiles } from './app/project-files.ts';
import { type CliOptions, helpText, parseArgs } from './cli/args.ts';
import { exitCodes, runPrint } from './cli/print.ts';
import { loadConfig } from './config/config.ts';
import { loadState, saveState } from './config/local-state.ts';
import { appPaths } from './config/paths.ts';
import { buildKeymap } from './domain/keymap.ts';
import { directoryKey } from './domain/path-identity.ts';
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
  const platform = process.platform;
  const cwd = options.cwd === undefined ? process.cwd() : absolute(options.cwd);
  const paths = appPaths(env, platform);
  const configLoad = await loadConfig(options.config ?? paths.configFile);
  for (const warning of configLoad.warnings) process.stderr.write(`config: ${warning}\n`);
  const keymapBuild = buildKeymap(configLoad.config.keys);
  for (const error of keymapBuild.errors) process.stderr.write(`keys: ${error}\n`);

  let backend: Backend;
  try {
    const connection = await connect({
      ...(options.server === undefined ? {} : { server: options.server }),
      startServer: options.startServer,
      ...(env['MARGARITA_SERVER_PASSWORD'] === undefined
        ? {}
        : { remotePassword: env['MARGARITA_SERVER_PASSWORD'] }),
      onStarting: () => process.stderr.write('Starting OpenCode service…\n'),
    });
    backend = createBackend(connection);
  } catch (error) {
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
  const controller = new AppController({
    backend,
    config: configLoad.config,
    localState: stateLoad.state,
    platform,
    cwd,
    version,
    now: Date.now,
    saveLocalState: (state) => saveState(paths.stateFile, state),
    listFiles: (root) => listProjectFiles(root),
    requestExit: () => exit.request?.(),
  });

  try {
    await controller.bootstrap();
  } catch (error) {
    process.stderr.write(`marg: could not load from ${backend.baseUrl}: ${errorText(error)}\n`);
    return error instanceof BackendError && error.kind === 'unauthorized'
      ? exitCodes.unauthorized
      : exitCodes.unavailable;
  }

  const agent = controller.resolveCliAgent(options.agent);
  if (!agent.ok) {
    process.stderr.write(`marg: ${agent.message}\n`);
    return exitCodes.modelUnavailable;
  }
  const model = controller.resolveCliModel({
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
  });
  if (!model.ok) {
    process.stderr.write(`marg: ${model.message}\n`);
    return exitCodes.modelUnavailable;
  }
  controller.setNewSessionDefaults(agent.agent, model.model);

  const target = options.target;
  let existingSessionID: string | undefined;
  if (target.kind === 'resume') {
    if (controller.state.sessions[target.sessionID] === undefined) {
      try {
        await backend.getSession(target.sessionID);
      } catch {
        process.stderr.write(`marg: session ${target.sessionID} not found.\n`);
        return exitCodes.notFound;
      }
    }
    existingSessionID = target.sessionID;
  } else if (target.kind === 'continue') {
    existingSessionID = latestSessionIn(controller, cwd);
    if (existingSessionID === undefined && options.print) {
      process.stderr.write('marg: no session to continue in this project.\n');
      return exitCodes.notFound;
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
        signal: abort.signal,
      });
    } catch (error) {
      process.stderr.write(`marg: ${errorText(error)}\n`);
      return exitCodes.failed;
    }
  }

  const stopPump = startEventPump({
    source: (signal) => backend.events(signal),
    onBatch: (events, resync) => controller.onEvents(events, resync),
    onStatus: (status) => controller.onStreamStatus(status),
  });

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
  process.once('SIGTERM', () => exit.request?.());

  const animate = env['MARGARITA_NO_ANIMATION'] === undefined && env['NO_COLOR'] === undefined;
  await render(
    () =>
      App({
        controller,
        keymap: keymapBuild.keymap,
        theme: pickTheme(env),
        animate,
        ascii: env['MARGARITA_ASCII'] !== undefined,
        env,
      }),
    renderer,
  );

  const prompt = 'prompt' in target ? target.prompt : undefined;
  if (existingSessionID !== undefined) {
    controller.openSession(existingSessionID);
    if (prompt !== undefined) await controller.sendToSession(existingSessionID, prompt);
  } else if (target.kind === 'new' || target.kind === 'continue') {
    if (prompt === undefined) controller.startNewSession(cwd);
    else await controller.createSessionWithPrompt(cwd, prompt);
  } else {
    controller.openOverview();
  }

  await finished.promise;
  await stopPump();
  controller.dispose();
  return exitCodes.ok;
}

function latestSessionIn(controller: AppController, cwd: string): string | undefined {
  const key = directoryKey(cwd, process.platform);
  return Object.values(controller.state.sessions)
    .filter(
      (session) =>
        !session.archived &&
        session.parentID === undefined &&
        directoryKey(session.directory, process.platform) === key,
    )
    .toSorted((left, right) => right.updatedAt - left.updatedAt)[0]?.id;
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

process.exitCode = await main(process.argv.slice(2));
