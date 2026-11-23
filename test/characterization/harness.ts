/**
 * Deterministic fixtures for behavior characterization (#306).
 *
 * The helpers here are deliberately small: they control when a promise settles,
 * when "now" advances, which hosts exist, and which RPCs each host observed.
 * Tests using them must assert observable state and exact backend calls, never
 * that a mocked method happened to be invoked.
 */
import { AppController, type ControllerDeps, type ServerAdmin } from '../../src/app/controller.ts';
import { defaultConfig } from '../../src/config/config.ts';
import { emptyState } from '../../src/config/local-state.ts';
import type { BackendEvent } from '../../src/domain/backend-event.ts';
import type { SessionSummary } from '../../src/domain/session.ts';
import { FakeBackend } from '../fake-backend.ts';
import { FakeScheduler } from './scheduler.ts';

/** A promise whose resolution the test controls. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

/** Creates a controllable promise without real timers. */
export function deferred<T = void>(): Deferred<T> {
  const result = Promise.withResolvers<T>();
  return { promise: result.promise, resolve: result.resolve, reject: result.reject };
}

/**
 * Drains queued microtasks to a stable point without sleeping. Code that needs a
 * timer to fire must use a injected scheduler and advance it explicitly; this
 * barrier never advances wall-clock time (#326).
 */
export async function settle(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve();
}

/** Injectable clock; controller code reads `now`, tests advance it explicitly. */
export interface FakeClock {
  now(): number;
  advance(milliseconds: number): void;
}

/** Creates a monotonic clock starting at `start`. */
export function fakeClock(start = 1000): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

/** One recorded backend call, qualified by the host that received it. */
export interface RpcCall {
  readonly serverID: string;
  /** Zero-based position in that host's call log, for slicing with {@link CallMarks}. */
  readonly index: number;
  readonly name: string;
  readonly args: readonly unknown[];
}

/** Per-host call counts captured so a later slice contains only new calls. */
export type CallMarks = Readonly<Record<string, number>>;

/** A controller under test with colliding hosts and full call visibility. */
export interface CharacterizationHarness {
  readonly controller: AppController;
  readonly backends: ReadonlyMap<string, FakeBackend>;
  readonly registered: Set<string>;
  readonly clock: FakeClock;
  /** Injectable timers owned by this controller; time moves only when advanced. */
  readonly scheduler: FakeScheduler;
  readonly sessionID: string;
  /** Drains microtasks and due zero-delay timers without sleeping. */
  settle(rounds?: number): Promise<void>;
  backend(serverID: string): FakeBackend;
  /** Adds or removes a host registration without touching the other hosts. */
  setRegistered(serverID: string, registered: boolean): void;
  marks(): CallMarks;
  callsSince(marks: CallMarks): readonly RpcCall[];
  emit(serverID: string, events: readonly BackendEvent[], resync?: boolean): void;
  session(serverID: string): SessionSummary | undefined;
  dispose(): void;
}

/** Options for {@link createHarness}. */
export interface HarnessOptions {
  readonly serverIDs?: readonly string[];
  readonly sessionID?: string;
  /** Shared virtual-time source for the clock and all controller timers. */
  readonly scheduler?: FakeScheduler;
  /** Seed data or hooks before the controller bootstraps. */
  readonly prepare?: (backends: ReadonlyMap<string, FakeBackend>) => void;
  /** Extra controller dependencies; cannot override the injected backends or clock. */
  readonly deps?: Partial<ControllerDeps>;
  readonly admin?: ServerAdmin;
}

/** A session summary with the same ID on two hosts but distinct, checkable titles. */
export function collidingSession(
  serverID: string,
  sessionID: string,
  title: string,
): SessionSummary {
  return {
    id: sessionID,
    serverID,
    projectID: 'p',
    directory: '/work',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    title,
  };
}

/** Builds and bootstraps a multi-host controller with server-qualified state. */
export async function createHarness(
  options: HarnessOptions = {},
): Promise<CharacterizationHarness> {
  const ids = options.serverIDs ?? ['local', 'remote'];
  const sessionID = options.sessionID ?? 'ses_same';
  const scheduler = options.scheduler ?? new FakeScheduler();
  const clock: FakeClock = {
    now: () => scheduler.now(),
    advance: (milliseconds) => scheduler.advanceBy(milliseconds),
  };
  const backends = new Map<string, FakeBackend>();
  for (const serverID of ids) {
    const backend = new FakeBackend();
    backend.serverID = serverID;
    backend.sessions = [collidingSession(serverID, sessionID, `${serverID} session`)];
    backends.set(serverID, backend);
  }
  options.prepare?.(backends);

  const registered = new Set(ids);
  const local = backends.get(ids[0] ?? 'local');
  if (local === undefined) throw new Error('harness: at least one server is required');
  const controller = new AppController({
    backend: local,
    backendFor: (serverID) => (registered.has(serverID) ? backends.get(serverID) : undefined),
    serverIDs: () => [...registered],
    config: defaultConfig,
    localState: emptyState,
    platform: 'linux',
    cwd: '/work',
    version: 'test',
    now: () => scheduler.now(),
    scheduler,
    saveLocalState: async () => {},
    listFiles: async () => [],
    requestExit: () => {},
    transcriptRetryBaseDelayMs: 1,
    ancestryVerifyTimeoutMs: 50,
    ...(options.admin === undefined ? {} : { serverAdmin: options.admin }),
    ...options.deps,
  });
  await controller.bootstrap();

  function snapshot(): RpcCall[] {
    const calls: RpcCall[] = [];
    for (const [serverID, backend] of backends) {
      for (const [index, call] of backend.calls.entries()) {
        calls.push({ serverID, index, name: call.name, args: call.args });
      }
    }
    return calls;
  }

  return {
    controller,
    backends,
    registered,
    clock,
    scheduler,
    sessionID,
    async settle(rounds = 8): Promise<void> {
      for (let round = 0; round < rounds; round += 1) {
        await Promise.resolve();
        scheduler.runDue();
      }
    },
    backend(serverID: string): FakeBackend {
      const backend = backends.get(serverID);
      if (backend === undefined) throw new Error(`harness: unknown server ${serverID}`);
      return backend;
    },
    setRegistered(serverID: string, isRegistered: boolean): void {
      if (isRegistered) {
        registered.add(serverID);
      } else {
        registered.delete(serverID);
      }
    },
    marks(): CallMarks {
      const marks: Record<string, number> = {};
      for (const [serverID, backend] of backends) marks[serverID] = backend.calls.length;
      return marks;
    },
    callsSince(marks: CallMarks): readonly RpcCall[] {
      return snapshot().filter((call) => call.index >= (marks[call.serverID] ?? 0));
    },
    emit(serverID: string, events: readonly BackendEvent[], resync = false): void {
      controller.onEvents(serverID, events, resync);
    },
    session(serverID: string): SessionSummary | undefined {
      return controller.state.sessions[`${serverID}:${sessionID}`];
    },
    dispose(): void {
      controller.dispose();
    },
  };
}

/** Throws when any new call matches, with the exact offending calls in the message. */
export function assertNoCalls(
  calls: readonly RpcCall[],
  matches: (call: RpcCall) => boolean,
  description: string,
): void {
  const offending = calls.filter(matches);
  if (offending.length > 0) {
    throw new Error(
      `${description}: ${offending.map((call) => `${call.serverID}.${call.name}`).join(', ')}`,
    );
  }
}
