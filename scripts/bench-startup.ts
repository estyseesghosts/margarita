/**
 * Opt-in cold/warm launch benchmark (#345).
 *
 *   bun run bench:startup
 *   bun run bench:startup -- --smoke
 *   bun run bench:startup -- --json .bench/startup.json
 *
 * The harness composes the real production assembly, controller bootstrap and Solid/OpenTUI
 * tree over deterministic fake backends and synthetic profiles. It never contacts an OpenCode
 * service, never decrypts a real credential and never reads a user transcript. Credential
 * latency is simulated in the `credential` dimension so the Windows DPAPI path can be compared
 * with an in-memory store without touching the user's keyring.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { testRender } from '@opentui/solid';

import {
  type AssemblyConnection,
  createProductionAssembly,
} from '../src/app/production-assembly.ts';
import { type CredentialStore, memoryCredentialStore } from '../src/config/credentials.ts';
import { buildKeymap } from '../src/domain/keymap.ts';
import type { SessionSummary } from '../src/domain/session.ts';
import { type BenchStats, summarizeSamples } from '../src/perf/measure.ts';
import { createStartupTimeline, type StartupTimelineSnapshot } from '../src/perf/startup.ts';
import { App } from '../src/ui/app.tsx';
import { pickTheme } from '../src/ui/theme.ts';
import { FakeBackend } from '../test/fake-backend.ts';

const args = new Set(Bun.argv.slice(2));
const smoke = args.has('--smoke');
const jsonIndex = Bun.argv.indexOf('--json');
const jsonPath = jsonIndex >= 0 ? Bun.argv[jsonIndex + 1] : undefined;
const samples = smoke ? 1 : 3;

type CredentialMode = 'memory' | 'dpapi-simulated';

interface RunResult {
  readonly temperature: 'cold' | 'warm';
  readonly stages: Readonly<Record<string, number>>;
  readonly firstFrameMs: number;
  readonly usableOverviewMs: number;
  readonly fullyReadyMs: number;
  readonly timeline: StartupTimelineSnapshot;
  readonly frameOk: boolean;
}

interface ScenarioResult {
  readonly pairedServers: number;
  readonly launch: 'local' | 'remote';
  readonly credential: CredentialMode;
  readonly runs: readonly RunResult[];
  readonly stats: Readonly<Record<string, BenchStats>>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A credential store that reports the same secrets but costs a deterministic backend delay. */
function delayedCredentialStore(base: CredentialStore, delayMs: number): CredentialStore {
  if (delayMs <= 0) return base;
  return {
    ...base,
    async get(serverID) {
      await sleep(delayMs);
      return base.get(serverID);
    },
  };
}

function sessionFor(serverID: string, index: number): SessionSummary {
  return {
    id: `ses_${lineage(serverID)}_${index}`,
    serverID,
    projectID: 'p',
    directory: serverID === 'local' ? '/work/startup' : `/srv/startup-${index}`,
    title: `Startup session ${serverID} ${index}`,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
  };
}

function lineage(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_');
}

function profileFor(index: number, launch: 'local' | 'remote') {
  return {
    serverID: `srv_${index}`,
    shortname: `server-${index}`,
    baseUrl:
      launch === 'remote' && index === 0
        ? 'http://launch.test:4096'
        : `http://host-${index}.test:4096`,
    auth: 'bearer' as const,
  };
}

async function prepareFiles(pairedServers: number): Promise<{
  directory: string;
  configPath: string;
  serversPath: string;
  statePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'margarita-startup-bench-'));
  const configPath = join(directory, 'config.json');
  const serversPath = join(directory, 'servers.json');
  const statePath = join(directory, 'state.json');
  await writeFile(configPath, JSON.stringify({}));
  await writeFile(statePath, JSON.stringify({ version: 1 }));
  await writeFile(
    serversPath,
    JSON.stringify({
      schemaVersion: 1,
      profiles: Array.from({ length: pairedServers }, (_, index) => profileFor(index, 'local')),
    }),
  );
  return { directory, configPath, serversPath, statePath };
}

function fakeBackends(pairedServers: number): {
  createBackend: NonNullable<Parameters<typeof createProductionAssembly>[0]['createBackend']>;
  local: FakeBackend;
} {
  const local = new FakeBackend();
  local.sessions = [sessionFor('local', 0)];
  const fakes = new Map<string, FakeBackend>();
  for (let index = 0; index < pairedServers; index += 1) {
    const fake = new FakeBackend();
    fake.serverID = `srv_${index}`;
    fake.sessions = [sessionFor(`srv_${index}`, index)];
    fakes.set(`srv_${index}`, fake);
  }
  return {
    local,
    createBackend: (_connection, options) =>
      fakes.get(options?.serverID ?? '') ?? new FakeBackend(),
  };
}

function percentages(values: readonly number[]): BenchStats {
  return summarizeSamples(values);
}

async function runOnce(
  input: Readonly<{
    pairedServers: number;
    launch: 'local' | 'remote';
    credential: CredentialMode;
    temperature: 'cold' | 'warm';
    files: Awaited<ReturnType<typeof prepareFiles>>;
  }>,
): Promise<RunResult> {
  const origin = performance.now();
  const elapsed = (): number => performance.now() - origin;
  const timeline = createStartupTimeline({ clock: elapsed });
  timeline.mark('process-entry');
  timeline.mark('execute-entry');

  // The same loads production main.ts performs before it can draw anything.
  const { loadConfig } = await import('../src/config/config.ts');
  const { loadServerProfiles } = await import('../src/config/server-profiles.ts');
  const { loadState } = await import('../src/config/local-state.ts');
  const configLoad = await loadConfig(input.files.configPath);
  timeline.mark('config-loaded');
  const profiles = await loadServerProfiles(input.files.serversPath);
  timeline.mark('profiles-loaded');
  const state = await loadState(input.files.statePath);
  timeline.mark('state-loaded');

  const { local, createBackend } = fakeBackends(input.pairedServers);
  const credentials = delayedCredentialStore(
    memoryCredentialStore(),
    input.credential === 'dpapi-simulated' ? 120 : 0,
  );
  for (const profile of profiles.profiles.profiles) {
    await credentials.set(profile.serverID, `tok_${profile.serverID}`);
  }
  const remoteLaunch = new FakeBackend();
  remoteLaunch.serverID = 'srv_0';
  remoteLaunch.sessions = [sessionFor('srv_0', 0)];
  const launchConnection: AssemblyConnection = {
    serverID: input.launch === 'remote' ? 'srv_0' : 'local',
    connection:
      input.launch === 'remote'
        ? { baseUrl: 'http://launch.test:4096', headers: {}, origin: 'remote' }
        : { baseUrl: local.baseUrl, headers: {}, origin: 'discovered' },
    backend: input.launch === 'remote' ? remoteLaunch : local,
    remoteFilesystem: input.launch === 'remote',
    ...(input.launch === 'remote' ? { platform: 'linux' as const } : {}),
  };
  const assembly = await createProductionAssembly({
    config: configLoad.config,
    platform: process.platform,
    cwd: '/work/startup',
    version: '0.0.0-bench',
    paths: {
      stateFile: input.files.statePath,
      serversFile: input.files.serversPath,
      stateDir: input.files.directory,
    },
    env: {},
    credentials,
    connections: [launchConnection],
    profiles: profiles.profiles,
    localState: state.state,
    remoteFilesystem: input.launch === 'remote',
    now: Date.now,
    monotonic: elapsed,
    deferSavedServers: true,
    createBackend,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
  });
  timeline.mark('assembly-ready');

  const bootstrap = assembly.controller.bootstrap();
  const setup = await testRender(
    () =>
      App({
        controller: assembly.controller,
        keymap: buildKeymap({}).keymap,
        theme: pickTheme({}),
        animate: false,
        ascii: false,
        env: {},
      }),
    { width: 100, height: 30 },
  );
  timeline.mark('ui-mounted');
  try {
    // The test renderer does not expose a native frame callback. One explicit render of the
    // mounted shell is the first frame boundary this harness can observe.
    await setup.renderOnce();
    timeline.mark('first-frame');
    // Production starts this from the first native frame, after the shell has painted.
    const maintenance = assembly.runDeferredMaintenance().then(() => {
      timeline.mark('post-mount-maintenance');
    });
    await bootstrap;
    const startup = assembly.controller.state.startup;
    if (startup.sessionsReadyAt !== undefined) {
      timeline.markAt('session-page-ready', startup.sessionsReadyAt);
    }
    if (startup.catalogReadyAt !== undefined) {
      timeline.markAt('catalog-ready', startup.catalogReadyAt);
    }
    if (startup.readyAt !== undefined) {
      timeline.markAt('composer-ready', startup.readyAt);
    } else {
      timeline.mark('composer-ready');
    }
    await maintenance;
    await assembly.controller.settleSessionIndex();
    await assembly.controller.settleRequestHydration();
    const settled = assembly.controller.state.startup;
    if (settled.indexCompleteAt !== undefined) {
      timeline.markAt('session-index-complete', settled.indexCompleteAt);
    }
    if (settled.hydrationReadyAt !== undefined) {
      timeline.markAt('request-hydration-ready', settled.hydrationReadyAt);
    }
    await setup.renderOnce();
    const snapshot = timeline.snapshot();
    const at = (stage: string): number =>
      snapshot.stages.find((entry) => entry.stage === stage)?.atMs ?? 0;
    const frame = setup.captureCharFrame();
    return {
      temperature: input.temperature,
      stages: Object.fromEntries(snapshot.stages.map((entry) => [entry.stage, entry.atMs])),
      firstFrameMs: at('first-frame'),
      usableOverviewMs: Math.max(at('first-frame'), at('composer-ready')),
      fullyReadyMs: Math.max(
        at('post-mount-maintenance'),
        at('session-index-complete'),
        at('request-hydration-ready'),
        at('composer-ready'),
      ),
      timeline: snapshot,
      frameOk: frame.includes('Startup session') || frame.includes('Loading'),
    };
  } finally {
    setup.renderer.destroy();
    assembly.controller.dispose();
    await assembly.servers.dispose();
    await assembly.clipboard.dispose();
  }
}

async function runScenario(
  pairedServers: number,
  launch: 'local' | 'remote',
  credential: CredentialMode,
): Promise<ScenarioResult> {
  const files = await prepareFiles(pairedServers);
  const runs: RunResult[] = [];
  try {
    for (let index = 0; index < samples; index += 1) {
      runs.push(
        await runOnce({
          pairedServers,
          launch,
          credential,
          temperature: index === 0 ? 'cold' : 'warm',
          files,
        }),
      );
    }
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
  const stageNames = [
    'config-loaded',
    'profiles-loaded',
    'state-loaded',
    'assembly-ready',
    'ui-mounted',
    'first-frame',
    'session-page-ready',
    'catalog-ready',
    'composer-ready',
    'post-mount-maintenance',
  ];
  const stats: Record<string, BenchStats> = {
    firstFrameMs: percentages(runs.map((run) => run.firstFrameMs)),
    usableOverviewMs: percentages(runs.map((run) => run.usableOverviewMs)),
    fullyReadyMs: percentages(runs.map((run) => run.fullyReadyMs)),
  };
  for (const stage of stageNames) {
    stats[stage] = percentages(
      runs.map((run) => run.stages[stage] ?? 0).filter((value) => value >= 0),
    );
  }
  return { pairedServers, launch, credential, runs, stats };
}

const serverCounts = smoke ? [0] : [0, 1, 5, 20];
const scenarios: ScenarioResult[] = [];
for (const count of serverCounts) {
  for (const launchMode of ['local', 'remote'] as const) {
    scenarios.push(await runScenario(count, launchMode, 'memory'));
  }
}
scenarios.push(await runScenario(smoke ? 0 : 5, 'local', 'dpapi-simulated'));

const report = {
  kind: 'margarita-startup-bench' as const,
  version: 1,
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  windowsCredentialPath: process.platform === 'win32',
  bun: Bun.version,
  note: 'Synthetic local fixtures. Windows credential mode simulates a 120 ms per-secret DPAPI read; it does not touch the user keyring.',
  samplesPerScenario: samples,
  scenarios,
};

if (jsonPath !== undefined) {
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
