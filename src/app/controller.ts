import { isAbsolute, posix, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

import { batch } from 'solid-js';
import { createStore, produce, reconcile, type SetStoreFunction } from 'solid-js/store';

import {
  type Backend,
  BackendError,
  type Delivery,
  type DiffRange,
  type PermissionDecision,
  type PromptFile,
  type QueuedInput,
} from '../adapter/backend.ts';
import type { StreamStatus } from '../adapter/event-pump.ts';
import { nextQueuedUser } from '../adapter/wire-mapping.ts';
import type { AppConfig } from '../config/config.ts';
import { GoalConflictError, type GoalStore, memoryGoalStore } from '../config/goal-store.ts';
import type { LocalState, SaveResult } from '../config/local-state.ts';
import { mergeState } from '../config/local-state.ts';
import { defaultAgent, nextAgent, selectableAgents } from '../domain/agent-cycle.ts';
import {
  type Attachment,
  attachmentLimitBytes,
  attachmentMimeForName,
  attachmentPromptFile,
  detectAttachmentMime,
  makeAttachment,
  pastedAttachmentName,
  splitPastedPaths,
} from '../domain/attachment.ts';
import type { BackendEvent } from '../domain/backend-event.ts';
import {
  type Composer,
  composerFrom,
  emptyComposer,
  insertText,
  restoreComposer,
} from '../domain/composer.ts';
import { type DiffScope, type FileDiff, patchLines, turnStart } from '../domain/diff.ts';
import { hasOversizedDiff } from '../domain/edit-diff.ts';
import { projectExecution } from '../domain/execution.ts';
import {
  activeMention,
  agentMentions,
  findFileMentions,
  rankPaths,
  withLineRange,
} from '../domain/file-reference.ts';
import {
  buildAnswer,
  editorKey,
  type FormKey,
  type FormRequest,
  startEditor,
} from '../domain/form.ts';
import {
  acceptProposal,
  addEvidence,
  emptyGoalPlan,
  forkGoalPlan,
  type GoalPlanV1,
  nextTaskState,
  parseSteps,
  progress,
  proposePlan,
  rejectProposal,
  setAcceptance,
  setTaskState,
  setUserPlan,
  type TaskState,
} from '../domain/goal-plan.ts';
import { greetingPeriod } from '../domain/greeting-time.ts';
import { selectGreeting } from '../domain/greetings.ts';
import { formatModelRef, type ModelSelection, sameModel } from '../domain/model-ref.ts';
import { resolveModel } from '../domain/model-resolution.ts';
import {
  type GoalQueryFailure,
  type NativeGoal,
  type NativeGoalState,
  verifiedGoal,
} from '../domain/native-goal.ts';
import {
  groupRows,
  groupSessions,
  loadMoreRowKey,
  type OverviewRow,
  type ProjectGroup,
} from '../domain/overview-groups.ts';
import {
  filterSessions,
  nextTab,
  type OverviewTab,
  overviewTabLabels,
  tabCounts,
} from '../domain/overview-tabs.ts';
import {
  PairingError,
  type PairRequest,
  parsePairArgs,
  redactPairingCode,
} from '../domain/pairing.ts';
import { directoryKey } from '../domain/path-identity.ts';
import {
  historyBack,
  historyForward,
  recordEntry,
  searchHistory,
} from '../domain/prompt-history.ts';
import {
  legacyProjectKeys,
  localServerID,
  parseSessionKey,
  projectKey,
  type ProjectRef,
  sessionKey,
  type SessionRef,
} from '../domain/server-identity.ts';
import {
  baseServerPath,
  isServerAbsolutePath,
  joinServerPath,
  normalizeServerPath,
  relativeServerPath,
  serverFileUri,
  serverPathShape,
} from '../domain/server-path.ts';
import { classifySessionStatus, type SessionStatus } from '../domain/session-status.ts';
import type { Execution, SessionSummary } from '../domain/session.ts';
import {
  completeCommand,
  isLocalCommand,
  type LocalCommandName,
  parseInput,
} from '../domain/slash-command.ts';
import {
  foldTranscript,
  type TranscriptMessage,
  type TranscriptNode,
  transcriptWindowStep,
} from '../domain/transcript.ts';
import {
  type AppState,
  type DiffOverlay,
  initialState,
  type Overlay,
  type Route,
} from './app-state.ts';
import { type DebugLog, noDebugLog } from './debug-log.ts';

/** A point an edit can be undone/redone back to. Attachments are kept, never duplicated. */
type UndoSnapshot = Readonly<{ composer: Composer }>;

const undoLimit = 100;
const typingCoalesceMs = 750;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** True when two texts differ by exactly one grapheme cluster (an insertion or deletion). */
function isSingleGraphemeStep(before: string, after: string): boolean {
  if (before === after) return false;
  const a = [...graphemes.segment(before)].map((part) => part.segment);
  const b = [...graphemes.segment(after)].map((part) => part.segment);
  if (Math.abs(a.length - b.length) !== 1) return false;
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return b.length > a.length
    ? a.slice(index).join('') === b.slice(index + 1).join('')
    : a.slice(index + 1).join('') === b.slice(index).join('');
}

/** One row of the `/servers` list. Never contains a secret. */
export type ServerListing = Readonly<{
  serverID: string;
  label: string;
  baseUrl: string;
  state: string;
  active: boolean;
}>;

/**
 * Everything presentation code needs about the attached conversation, already resolved
 * through its server-qualified key. Nothing here is keyed by a bare session ID.
 */
export type ConversationView = Readonly<{
  serverID: string;
  sessionID: string;
  /** `sessionKey({serverID, sessionID})`: the key every per-session map uses. */
  key: string;
  session?: SessionSummary;
  /** Pending user follow-ups; compactions share the inbox but are not listed here. */
  queued: readonly QueuedInput[];
  nativeGoal: NativeGoalState | undefined;
  awaitingSteer: string | undefined;
  /** The viewed host's stream status, for the footer's stale/reconnecting presentation. */
  stream: StreamStatus;
  execution: Execution;
}>;

export type ServerAdmin = Readonly<{
  list(): readonly ServerListing[];
  rename(serverID: string, label: string): Promise<readonly ServerListing[]>;
  /** Forgets the server and its local credentials; never stops remote work. */
  unpair(serverID: string): Promise<void>;
}>;

export type ControllerDeps = Readonly<{
  backend: Backend;
  /** Resolves a backend by server identity; absent means single-server mode. */
  backendFor?: (serverID: string) => Backend | undefined;
  /** Margarita-managed identity of the connected server; defaults to the reserved local one. */
  serverID?: string;
  config: AppConfig;
  localState: LocalState;
  platform: NodeJS.Platform;
  cwd: string;
  version: string;
  now: () => number;
  saveLocalState: (state: LocalState) => Promise<SaveResult | void>;
  listFiles: (root: string) => Promise<string[]>;
  /**
   * True when the connection has no shared filesystem with the server (explicit remote
   * URL). Remote mentions are resolved via the server's file APIs instead of Bun.file.
   */
  remoteFilesystem?: boolean;
  requestExit: () => void;
  /** Writes an exported file; defaults to Bun.write. */
  writeFile?: (path: string, text: string) => Promise<void>;
  /** Goal/plan sidecar storage; defaults to memory (tests). */
  goalStore?: GoalStore;
  /** Frontend-local pairing; implemented by main so the controller owns no network setup. */
  pair?: (request: PairRequest) => Promise<{ shortname: string }>;
  /** Server registry management for /servers and /unpair. */
  serverAdmin?: ServerAdmin;
  /** Display metadata for grouping: shortname and whether a server is currently online. */
  serverInfo?: (serverID: string) => { label?: string; online: boolean } | undefined;
  /** Reports one host's API/reconnect health; the manager maps it to online/offline/unauthorized. */
  setServerHealth?: (
    serverID: string,
    result: { ok: true } | { ok: false; error: unknown },
  ) => void;
  /**
   * The owning server's own path style, recorded from its authenticated metadata when paired.
   * Absent/undefined means unknown: callers fall back to case-preserving POSIX semantics.
   */
  platformFor?: (serverID: string) => NodeJS.Platform | undefined;
  /** Every server to aggregate in the overview; defaults to the launch server only. */
  serverIDs?: () => readonly string[];
  /** Opt-in diagnostics sink (--debug-log); defaults to a silent no-op. */
  debugLog?: DebugLog;
}>;

const transcriptPageSize = 120;
const transcriptCacheLimit = 8;
const sessionPageLimit = 5;
const reconcileConcurrency = 8;
const exportPageSize = 500;
/** Lines a diff patch scrolls per PageUp/PageDown; matches the rendered window. */
export const diffPageLines = 18;

/**
 * Owns all frontend state and every server interaction. Views read `state` and call
 * methods; they never talk to the backend. Leaving a session is a pure view change:
 * nothing here calls interrupt/background/delete on navigation.
 */
/** Pause reason the goal plugin records when the user interrupts a running goal. */
const stoppedByUserReason = 'Stopped by the user';

export class AppController {
  readonly state: AppState;
  private readonly setState: SetStoreFunction<AppState>;
  private noticeCounter = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Timestamp (ms, from `deps.now`) of the most recent idle Escape tap, for double-tap detection. */
  private escapeAt: number | undefined;
  private escapeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly transcriptInFlight = new Map<string, Promise<void>>();
  private readonly transcriptDirty = new Set<string>();
  private readonly summaryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private transcriptOrder: string[] = [];
  /** Per-host stream status: the viewed conversation's footer must reflect its own host,
   *  not the launch server's badge (issue #109). */
  private readonly streamByServer = new Map<string, StreamStatus>();
  private readonly modelSwitches = new Map<string, Promise<boolean>>();
  private readonly failedModelSwitches = new Set<string>();
  private readonly modelSwitchRevisions = new Map<string, number>();
  /** Last killed composer text for Ctrl+Y; each kill replaces it (documented policy). */
  private killBuffer = '';
  /** Greetings chosen once per route; process-lifetime only, never sent to a server. */
  private readonly greetingCache = new Map<string, string>();
  private readonly recentGreetings: string[] = [];
  /** Bounded, route-scoped undo/redo of user edits; never shared across drafts. */
  private readonly undoStacks = new Map<string, UndoSnapshot[]>();
  private readonly redoStacks = new Map<string, UndoSnapshot[]>();
  private lastEditAt = 0;
  private lastEditRoute = '';
  private readonly debugLog: DebugLog;

  /**
   * Opt-in `--debug-log` diagnostics for key routing: which key the TUI saw and with
   * which modifiers. Never logs typed characters — only the key identity — so session
   * text cannot leak into the log.
   */
  debugKey(event: {
    name: string;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    eventType: string;
    sequenceLength: number;
  }): void {
    this.debugLog.write('keypress', event);
  }
  private fileCache: { root: string; files: string[] } | undefined;
  private readonly fileScans = new Map<string, Promise<string[]>>();
  private completionRequest = 0;
  /** Bumped whenever the completion context changes (route, project, tab or server), so an
   * in-flight file scan can be rejected even when its directory string and mention did not. */
  private completionGeneration = 0;
  private disposed = false;
  private persisted: LocalState;
  /** In-flight saves, serialized per controller. */
  private saveChain: Promise<void> = Promise.resolve();
  private saveError: string | undefined;
  /** In-flight pastes, serialized in arrival order so a route switch mid-paste cannot
   * interleave two paste transactions. */
  private pasteChain: Promise<void> = Promise.resolve();
  private readonly goalStore: GoalStore;
  /** Identity of the server this controller talks to; part of every session key. */
  readonly serverID: string;

  /** Maximum gap (ms, measured with `deps.now`) between two Escape taps for a double-tap. */
  private static readonly ESCAPE_DOUBLE_TAP_MS = 400;

  constructor(private readonly deps: ControllerDeps) {
    this.serverID = deps.serverID ?? localServerID;
    this.debugLog = deps.debugLog ?? noDebugLog;
    const [state, setState] = createStore<AppState>(initialState(deps.cwd, this.serverID));
    this.state = state;
    this.setState = setState;
    this.persisted = deps.localState;
    this.goalStore = deps.goalStore ?? memoryGoalStore();
    setState('recentModels', [...deps.localState.recentModels]);
    this.loadHistoryFor(deps.cwd);
  }

  dispose(): void {
    this.disposed = true;
    if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer);
    this.resetEscapeTimer();
    for (const timer of this.summaryTimers.values()) clearTimeout(timer);
    this.summaryTimers.clear();
  }

  /**
   * Waits for every queued state save to land. Call before exiting so the last
   * history/model updates are not lost. Rejects if any save failed, so the caller can warn.
   */
  async flushLocalState(): Promise<void> {
    await this.saveChain;
    if (this.saveError !== undefined) {
      const message = this.saveError;
      this.saveError = undefined;
      throw new Error(message);
    }
  }

  // ---------------------------------------------------------------- identity

  /**
   * Resolves a backend by server. Fails closed: when a resolver is provided, an unknown or
   * removed server throws instead of silently falling back to the launch backend; legacy
   * single-backend callers provide no resolver and keep the launch backend explicitly.
   */
  private backendFor(serverID: string): Backend {
    if (this.deps.backendFor === undefined) return this.deps.backend;
    const resolved = this.deps.backendFor(serverID);
    if (resolved === undefined) throw new Error(`Unknown server: ${serverID}`);
    return resolved;
  }

  /**
   * Whether a server lacks this machine's filesystem. Every non-local server is remote;
   * the legacy `remoteFilesystem` flag still marks a directly configured launch server
   * (older single-server tests and `--server` callers) as remote.
   */
  private isRemoteServer(serverID: string): boolean {
    if (serverID !== localServerID) return true;
    return serverID === this.serverID && this.deps.remoteFilesystem === true;
  }

  /**
   * Server of the current route. `new` is explicit; `overview` follows the selected
   * project row, so catalog/model/agent actions there resolve against the host the user
   * actually picked, not the launch server (issue #79).
   */
  private activeServerID(): string {
    const route = this.state.route;
    if (route.kind === 'overview') return this.state.overview.project.serverID;
    return route.serverID;
  }

  /**
   * The project the composer operates on, with its owning server. Overview selection
   * always travels as (server, directory) so a new session can never be created on the
   * wrong host with a remote path.
   */
  currentProject(): ProjectRef {
    const route = this.state.route;
    if (route.kind === 'new') return { serverID: route.serverID, directory: route.directory };
    const session = this.currentSession();
    if (session !== undefined) return { serverID: session.serverID, directory: session.directory };
    return this.state.overview.project;
  }

  /** Backend for user actions and loads on the current route. Fails closed by server. */
  private get backend(): Backend {
    return this.backendFor(this.activeServerID());
  }

  /** Canonical project key for a directory on this server. */
  projectKeyOf(directory: string, serverID: string = this.serverID): string {
    return projectKey({ serverID, directory }, this.platformFor(serverID));
  }

  // ---------------------------------------------------------------- selectors

  /** The viewed host's stream status, falling back to the launch server's badge. */
  streamStatusOf(serverID: string): StreamStatus {
    return this.streamByServer.get(serverID) ?? this.state.stream;
  }

  executionOf(sessionID: string, serverID: string = this.activeServerID()): Execution {
    const key = this.keyFor(serverID, sessionID);
    const permissions = this.state.permissions[key] ?? [];
    return projectExecution({
      connected: this.streamStatusOf(serverID) !== 'reconnecting',
      loaded: this.state.sessions[key] !== undefined,
      running: this.state.running[key] === true,
      outcome: this.state.sessions[key]?.outcome,
      permissionIDs: permissions.map((permission) => permission.id),
      formCount: (this.state.forms[key] ?? []).length,
    });
  }

  /** The single classifier for dots, counts, and tabs; never a per-view heuristic. */
  statusOf(session: SessionSummary): SessionStatus {
    return classifySessionStatus({
      online: this.deps.serverInfo?.(session.serverID)?.online ?? true,
      execution: this.executionOf(session.id, session.serverID),
      archived: session.archived,
    });
  }

  currentSession(): SessionSummary | undefined {
    const route = this.state.route;
    return route.kind === 'conversation'
      ? this.state.sessions[this.keyFor(route.serverID, route.sessionID)]
      : undefined;
  }

  /**
   * Everything the attached conversation exposes to presentation code, read through the
   * one server-qualified key. Views and key handlers must use this instead of rebuilding
   * identity from `session.id`: two hosts can both own `ses_same`, and a bare ID would
   * show the other host's queue/goal/execution state (issue #78).
   */
  currentView(): ConversationView | undefined {
    const route = this.state.route;
    if (route.kind !== 'conversation') return undefined;
    const session = this.state.sessions[this.keyFor(route.serverID, route.sessionID)];
    const key = this.keyFor(route.serverID, route.sessionID);
    return {
      serverID: route.serverID,
      sessionID: route.sessionID,
      key,
      ...(session === undefined ? {} : { session }),
      queued: (this.state.inbox[key] ?? []).filter((item) => item.kind === 'user'),
      nativeGoal: this.state.nativeGoals[key],
      awaitingSteer: this.state.awaitingSteer[key],
      stream: this.streamStatusOf(route.serverID),
      execution: this.executionOf(route.sessionID, route.serverID),
    };
  }

  /** Counts for the tab bar, based on the same classifier as the dot. */
  tabCounts(): Record<OverviewTab, number> {
    return tabCounts(Object.values(this.state.sessions), {
      statusOf: (session) => this.statusOf(session),
      online: (serverID) => this.deps.serverInfo?.(serverID)?.online ?? true,
    });
  }

  overviewTab(): OverviewTab {
    return this.state.overview.tab;
  }

  cycleOverviewTab(direction: -1 | 1): void {
    this.setState('overview', 'tab', nextTab(this.state.overview.tab, direction));
    this.invalidateCompletion();
  }

  setOverviewTab(tab: OverviewTab): void {
    this.setState('overview', 'tab', tab);
    this.invalidateCompletion();
  }

  tabLabel(tab: OverviewTab): string {
    return overviewTabLabels[tab];
  }

  groups(): ProjectGroup[] {
    const filtered = filterSessions(Object.values(this.state.sessions), this.state.overview.tab, {
      statusOf: (session) => this.statusOf(session),
      online: (serverID) => this.deps.serverInfo?.(serverID)?.online ?? true,
    });
    return groupSessions(filtered, {
      platformFor: (serverID) => this.platformFor(serverID),
      showArchived: this.deps.config.sessions.showArchived,
      showChildren: this.deps.config.sessions.showChildren,
      activityOf: (session) => this.lastUsed(session),
      serverLabelOf: (serverID) => this.deps.serverInfo?.(serverID)?.label,
      serverOnline: (serverID) => this.deps.serverInfo?.(serverID)?.online ?? true,
    });
  }

  /** Most recent use: server activity or this frontend opening the session. */
  lastUsed(session: SessionSummary): number {
    return Math.max(
      session.updatedAt,
      this.state.openedAt[this.keyFor(session.serverID, session.id)] ?? 0,
    );
  }

  /** Flattened selectable overview rows in display order, for keyboard navigation. */
  overviewRows(): OverviewRow[] {
    const rows = this.groups().flatMap((group) =>
      groupRows(group, this.state.overview.expanded[group.key] === true),
    );
    // Offer pagination once the server says the first pages are not everything.
    if (!this.state.sessionsComplete) rows.push({ kind: 'loadmore', key: loadMoreRowKey });
    return rows;
  }

  /** Injected clock, so ages and recency are testable. */
  now(): number {
    return this.deps.now();
  }

  /**
   * Returns the greeting chosen for `key`, selecting it once on first use and keeping it
   * stable across re-renders, remounts and route revisits. Selection uses this client's
   * local clock; history is bounded and stays in this process (local state has no schema
   * for it yet, so it is intentionally not persisted across restarts).
   */
  greetingFor(key: string): string {
    const cached = this.greetingCache.get(key);
    if (cached !== undefined) return cached;
    const greeting = selectGreeting(greetingPeriod(new Date(this.now())), this.recentGreetings);
    this.greetingCache.set(key, greeting);
    this.recentGreetings.push(greeting);
    if (this.recentGreetings.length > 8) this.recentGreetings.shift();
    return greeting;
  }

  get version(): string {
    return this.deps.version;
  }

  get cwd(): string {
    return this.deps.cwd;
  }

  get serverUrl(): string {
    return this.backend.baseUrl;
  }

  // ---------------------------------------------------------------- startup

  /** Loads catalogs and sessions. Errors propagate so startup can report them. */
  async bootstrap(): Promise<void> {
    await Promise.all([this.loadCatalog(this.deps.cwd, this.serverID), this.loadSessions()]);
    // A remote server failing to load must not abort startup; the launch server failing
    // still propagates so the CLI can report it with an actionable message.
    if (this.launchLoadError !== undefined) throw this.launchLoadError;
  }

  private catalogGeneration = 0;
  private catalogInFlight: Promise<void> | undefined;
  private catalogInFlightScope: string | undefined;

  /** Catalog scope: server identity plus canonical directory, never directory alone. */
  private catalogScope(directory: string, serverID: string): string {
    return `${serverID}\u0000${directoryKey(directory, this.platformFor(serverID))}`;
  }

  async loadCatalog(directory: string, serverID: string = this.activeServerID()): Promise<void> {
    const generation = ++this.catalogGeneration;
    const scope = this.catalogScope(directory, serverID);
    const promise = this.innerLoadCatalog(directory, serverID, generation, scope);
    this.catalogInFlight = promise;
    this.catalogInFlightScope = scope;
    try {
      await promise;
    } finally {
      if (this.catalogInFlight === promise) {
        this.catalogInFlight = undefined;
        this.catalogInFlightScope = undefined;
      }
    }
  }

  private async innerLoadCatalog(
    directory: string,
    serverID: string,
    generation: number,
    scope: string,
  ): Promise<void> {
    this.setState('catalogDirectory', directoryKey(directory, this.platformFor(serverID)));
    this.setState('catalogServerID', serverID);
    this.setState('catalogLoading', true);
    this.setState('catalogError', undefined);
    const backend = this.backendFor(serverID);
    try {
      const [agents, models, fallback, commands, mcp] = await Promise.all([
        backend.listAgents(directory),
        backend.listModels(directory),
        backend.defaultModel(directory),
        backend.listCommands(directory).catch(() => []),
        backend.listMcpServers(directory).catch(() => undefined),
      ]);
      // Reject a late response from a server/project the user has already left.
      if (generation !== this.catalogGeneration || this.catalogScope(directory, serverID) !== scope)
        return;
      batch(() => {
        this.setState('catalogDirectory', directoryKey(directory, this.platformFor(serverID)));
        this.setState('catalogServerID', serverID);
        this.setState('agents', selectableAgents(agents, this.deps.config.agents.cycle));
        this.setState('models', models);
        this.setState('defaultModel', fallback);
        this.setState('serverCommands', commands);
        if (mcp !== undefined) {
          const directoryID = directoryKey(directory, this.platformFor(serverID));
          this.setState('mcpCatalogs', serverID, {
            ...this.state.mcpCatalogs[serverID],
            [directoryID]: mcp,
          });
        }
        this.setState('catalogLoading', false);
      });
    } catch (error) {
      if (generation !== this.catalogGeneration) return;
      // Never leave another project's or server's catalog usable after a failed reload.
      batch(() => {
        this.setState('agents', []);
        this.setState('models', []);
        this.setState('defaultModel', undefined);
        this.setState('serverCommands', []);
        this.setState('catalogLoading', false);
        this.setState('catalogError', errorText(error));
      });
      throw error;
    }
  }

  mcpServersFor(serverID: string, directory: string): string[] {
    return (
      this.state.mcpCatalogs[serverID]?.[directoryKey(directory, this.platformFor(serverID))] ?? []
    );
  }

  /** True when the loaded catalog is exactly the one for `(server, directory)` and usable. */
  catalogFresh(directory: string, serverID: string = this.activeServerID()): boolean {
    return (
      this.state.catalogServerID === serverID &&
      this.state.catalogDirectory === directoryKey(directory, this.platformFor(serverID)) &&
      !this.state.catalogLoading &&
      this.state.catalogError === undefined
    );
  }

  /** Reloads in the background when the catalog does not match the project right now. */
  private refreshCatalogIfStale(directory: string, serverID: string = this.activeServerID()): void {
    if (this.catalogFresh(directory, serverID)) return;
    if (
      this.state.catalogLoading &&
      this.state.catalogServerID === serverID &&
      this.state.catalogDirectory === directoryKey(directory, this.platformFor(serverID))
    ) {
      return; // already loading exactly this project's catalog
    }
    // A load for another scope may be in flight; starting this one now supersedes it.
    void this.track('catalog', this.loadCatalog(directory, serverID));
  }

  /** Guarantees the catalog matches `(server, directory)`, reloading it if needed. */
  private async ensureCatalog(
    directory: string,
    serverID: string = this.activeServerID(),
  ): Promise<boolean> {
    if (this.catalogFresh(directory, serverID)) return true;
    const scope = this.catalogScope(directory, serverID);
    if (this.catalogInFlight !== undefined && this.catalogInFlightScope === scope) {
      // A load for this exact scope is already in flight; wait for it instead of restarting.
      try {
        await this.catalogInFlight;
      } catch {
        // Error already recorded on state; freshness check below reports failure.
      }
      return this.catalogFresh(directory, serverID);
    }
    try {
      await this.loadCatalog(directory, serverID);
      // A competing navigation/catalog load may have superseded this response.
      // Do not admit a prompt against another project's model catalog.
      return this.catalogFresh(directory, serverID);
    } catch (error) {
      this.showNotice(`Could not load project catalog: ${errorText(error)}`, 'error');
      return false;
    }
  }

  /** Every server the overview aggregates, launch server first and deduplicated. */
  private serverIDs(): string[] {
    return [...new Set([this.serverID, ...(this.deps.serverIDs?.() ?? [])])];
  }

  private keyFor(serverID: string, sessionID: string): string {
    return sessionKey({ serverID, sessionID });
  }

  /**
   * The owning server's path style. The launch server uses what the server advertised at
   * pair time (or what its saved profile recorded); the frontend's own OS applies only to
   * an actually-local launch host. Paired servers: their advertised platform. Unknown
   * (legacy profiles): case-preserving POSIX — never the frontend's OS, so distinct
   * directories on a case-sensitive server are never silently merged by a Windows
   * frontend.
   */
  platformFor(serverID: string): NodeJS.Platform {
    const advertised = this.deps.platformFor?.(serverID);
    if (advertised !== undefined) return advertised;
    // The frontend's own OS is meaningful only for the local host it runs on.
    if (serverID === this.serverID && this.deps.remoteFilesystem !== true)
      return this.deps.platform;
    // Remote launch/paired server with no recorded platform: case-preserving POSIX.
    return 'linux';
  }

  /**
   * Monotonic sequence for execution events, per qualified session key, plus the counter
   * they draw from. A session refresh stores the counter when its request begins; an event
   * stamped later is newer than that snapshot and must win over it (issue #80).
   */
  private runningEventSequence = 0;
  private readonly runningEventSeq = new Map<string, number>();

  /**
   * Reconciles one host's running flags against a complete active set. A session the host no
   * longer reports running is cleared — including a flag left behind by a completion event
   * missed while disconnected (#80). Only this host's keys are touched, and a per-key event
   * that arrived after the snapshot began is newer than the snapshot, so it wins in both
   * directions instead of being resurrected or cleared by stale data.
   */
  private reconcileRunning(
    serverID: string,
    active: ReadonlySet<string>,
    snapshotSeq: number,
  ): void {
    const superseded = (key: string) => (this.runningEventSeq.get(key) ?? 0) > snapshotSeq;
    this.setState(
      produce((state) => {
        for (const key of Object.keys(state.running)) {
          const ref = parseSessionKey(key);
          if (ref.serverID !== serverID || active.has(ref.sessionID) || superseded(key)) continue;
          delete state.running[key];
        }
        for (const sessionID of active) {
          const key = this.keyFor(serverID, sessionID);
          if (!superseded(key)) state.running[key] = true;
        }
      }),
    );
  }

  /** Set when the launch server failed to refresh; bootstrap re-throws it for the CLI. */
  private launchLoadError: unknown;

  async loadSessions(serverID?: string): Promise<void> {
    if (serverID === undefined || serverID === this.serverID) this.launchLoadError = undefined;
    const servers = serverID === undefined ? this.serverIDs() : [serverID];
    // One host's failure never aborts the refresh for the others: a failed server keeps its
    // cached rows and records the error, healthy servers update normally.
    type SessionLoadResult = Readonly<{
      serverID: string;
      epoch: number;
      ok: boolean;
      error: string | undefined;
      cause: unknown;
      fresh: Record<string, SessionSummary>;
      active: Set<string>;
      cursor: string | undefined;
      snapshotSeq: number;
    }>;
    const results = await Promise.all<SessionLoadResult>(
      servers.map(async (targetID): Promise<SessionLoadResult> => {
        const epoch = this.nextRefreshEpoch(targetID);
        // Captured before the first request: any execution event stamped after this point is
        // newer than the snapshot and must not be overwritten by it.
        const snapshotSeq = this.runningEventSequence;
        try {
          const loaded = await this.loadServerSessions(targetID, epoch);
          return {
            serverID: loaded.serverID,
            epoch: loaded.epoch,
            ok: true,
            error: undefined as string | undefined,
            cause: undefined as unknown,
            fresh: loaded.fresh,
            active: loaded.active,
            cursor: loaded.cursor ?? undefined,
            snapshotSeq,
          };
        } catch (error) {
          this.debugLog.write('load-sessions-failed', {
            serverID: targetID,
            errorKind: error instanceof BackendError ? error.kind : 'unknown',
          });
          if (targetID === this.serverID) this.launchLoadError = error;
          return {
            serverID: targetID,
            epoch,
            ok: false,
            error: error instanceof Error ? error.message : 'Could not reach the server',
            cause: error,
            fresh: {},
            active: new Set<string>(),
            cursor: undefined,
            snapshotSeq,
          };
        }
      }),
    );
    // Only the freshest refresh for a still-registered host may be applied; anything older
    // or whose server was removed mid-flight is dropped so it cannot resurrect rows.
    const registered = new Set(this.serverIDs());
    const applied = results.filter(
      (result) =>
        registered.has(result.serverID) && this.isRefreshCurrent(result.serverID, result.epoch),
    );
    for (const result of applied) {
      this.deps.setServerHealth?.(
        result.serverID,
        result.ok ? { ok: true } : { ok: false, error: result.cause },
      );
    }
    const healthy = new Set(applied.filter((result) => result.ok).map((result) => result.serverID));

    // Reconcile and commit per host, rechecking registration and freshness after every
    // asynchronous stage: an old response must never clobber a newer refresh, and a host
    // removed mid-flight must not resurrect its rows, active flags, or page metadata.
    const committed: string[] = [];
    const activeByServer = new Map<string, Set<string>>();
    // Live registration: a host may be unpaired while its refresh is in flight.
    const isRegistered = (id: string) => this.serverIDs().includes(id);
    for (const result of applied) {
      if (!isRegistered(result.serverID) || !this.isRefreshCurrent(result.serverID, result.epoch))
        continue;

      const missed = Object.keys(this.state.sessions)
        .filter((key) => result.fresh[key] === undefined)
        .map(parseSessionKey)
        .filter((ref) => healthy.has(ref.serverID) && ref.serverID === result.serverID);

      const reconciled = await this.reconcileKnownSessions(missed);

      if (!isRegistered(result.serverID) || !this.isRefreshCurrent(result.serverID, result.epoch))
        continue;

      batch(() => {
        this.setState('sessions', (current) => ({
          ...current,
          ...reconciled.found,
          ...result.fresh,
        }));
        for (const ref of reconciled.deleted) this.forgetSession(ref.sessionID, ref.serverID);
        const page: { cursor?: string; complete: boolean; loading: boolean; error?: string } = {
          ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
          complete: result.cursor === undefined,
          loading: false,
          ...(result.ok ? {} : { error: result.error ?? 'Could not reach the server' }),
        };
        this.setState('serverPages', result.serverID, page);
        if (result.ok) this.reconcileRunning(result.serverID, result.active, result.snapshotSeq);
      });
      committed.push(result.serverID);
      if (result.ok) activeByServer.set(result.serverID, result.active);
    }

    batch(() => {
      if (serverID === undefined) {
        this.setState(
          'sessionsComplete',
          applied.every((result) => result.ok && result.cursor === undefined),
        );
        this.setState(
          'sessionsCursor',
          applied.find((result) => result.cursor !== undefined)?.cursor,
        );
      } else {
        // A single-server resync updates that host's page only; the rest keep their state.
        this.setState(
          'sessionsComplete',
          this.serverIDs().every((id) => this.state.serverPages[id]?.complete === true),
        );
      }
      // Only a refresh that actually applied a host may clear the loading flag; a newer
      // or unrelated refresh keeps it set until that operation completes.
      if (committed.length > 0) this.setState('sessionsLoading', false);
      this.setState('sessionsError', applied.find((result) => !result.ok)?.error);
    });

    // Running sessions are the ones that can be blocked on input right now.
    await Promise.all(
      servers.flatMap((targetID) =>
        [...(activeByServer.get(targetID) ?? [])].map((sessionID) =>
          this.refreshInputRequests(sessionID, targetID).catch(() => {
            // Unreachable host: its stale permission/form state stays as-is.
          }),
        ),
      ),
    );
  }

  /** Per-host refresh epochs: a host whose load starts a newer refresh retires the older. */
  private readonly refreshEpoch = new Map<string, number>();

  private nextRefreshEpoch(serverID: string): number {
    const next = (this.refreshEpoch.get(serverID) ?? 0) + 1;
    this.refreshEpoch.set(serverID, next);
    return next;
  }

  private isRefreshCurrent(serverID: string, epoch: number): boolean {
    return this.refreshEpoch.get(serverID) === epoch;
  }

  private async loadServerSessions(
    serverID: string,
    epoch?: number,
  ): Promise<{
    serverID: string;
    epoch: number;
    fresh: Record<string, SessionSummary>;
    active: Set<string>;
    cursor?: string;
  }> {
    const effectiveEpoch = epoch ?? this.nextRefreshEpoch(serverID);
    const backend = this.backendFor(serverID);
    const loaded: SessionSummary[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await backend.listSessions(cursor === undefined ? {} : { cursor });
      // Trust the backend's server stamp when present; otherwise this server owns the row.
      loaded.push(...page.sessions.map((session) => ({ ...session, serverID })));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < sessionPageLimit);
    const active = await backend.activeSessionIDs();
    return {
      serverID,
      fresh: Object.fromEntries(
        loaded.map((session) => [this.keyFor(serverID, session.id), session]),
      ),
      active,
      epoch: effectiveEpoch,
      ...(cursor === undefined ? {} : { cursor }),
    };
  }

  /** Looks up cached sessions the listing did not return; only a definite not-found deletes. */
  private async reconcileKnownSessions(
    refs: readonly SessionRef[],
  ): Promise<{ found: Record<string, SessionSummary>; deleted: SessionRef[] }> {
    const found: Record<string, SessionSummary> = {};
    const deleted: SessionRef[] = [];
    for (let start = 0; start < refs.length; start += reconcileConcurrency) {
      await Promise.all(
        refs.slice(start, start + reconcileConcurrency).map(async (ref) => {
          try {
            found[sessionKey(ref)] = {
              ...(await this.backendFor(ref.serverID).getSession(ref.sessionID)),
              serverID: ref.serverID,
            };
          } catch (error) {
            if (error instanceof BackendError && error.kind === 'not-found') deleted.push(ref);
            // Any other failure proves nothing: keep the row. A host removed mid-
            // reconciliation is not reconcilable here and is skipped entirely.
          }
        }),
      );
    }
    return { found, deleted };
  }

  /** Drops every cached trace of a session the server no longer has. */
  private forgetSession(sessionID: string, serverID: string = this.activeServerID()): void {
    const key = this.keyFor(serverID, sessionID);
    const expansionPrefix = `${key} `;
    this.setState(
      produce((state) => {
        delete state.sessions[key];
        delete state.transcripts[key];
        delete state.inbox[key];
        delete state.permissions[key];
        delete state.forms[key];
        delete state.goals[key];
        delete state.nativeGoals[key];
        delete state.awaitingSteer[key];
        delete state.running[key];
        delete state.openedAt[key];
        delete state.transcriptWindow[key];
        for (const expansionKey of Object.keys(state.expandedGroups)) {
          if (expansionKey.startsWith(expansionPrefix)) delete state.expandedGroups[expansionKey];
        }
        for (const expansionKey of Object.keys(state.expandedDiffs)) {
          if (expansionKey.startsWith(expansionPrefix)) delete state.expandedDiffs[expansionKey];
        }
      }),
    );
    this.transcriptOrder = this.transcriptOrder.filter((entry) => entry !== key);
    this.goalVersions.delete(key);
    this.runningEventSeq.delete(key);
    const route = this.state.route;
    if (
      route.kind === 'conversation' &&
      route.serverID === serverID &&
      route.sessionID === sessionID
    ) {
      this.setState('route', { kind: 'overview' });
      this.showNotice('This session was deleted on the server.', 'warn');
    }
  }

  /**
   * Fetch the next older page of sessions (the row the overview offers once the first
   * pages fail to cover everything). Merges by id, so retrying after a failure never
   * duplicates rows and never discards earlier pages.
   */
  async loadMoreSessions(): Promise<void> {
    if (this.state.sessionsLoading) return;
    const servers = this.serverIDs().filter(
      (serverID) => this.state.serverPages[serverID]?.complete === false,
    );
    if (servers.length === 0) return;
    this.setState('sessionsLoading', true);
    for (const serverID of servers) {
      this.setState('serverPages', serverID, (current) => ({
        ...(current ?? { complete: false }),
        loading: true,
      }));
    }
    const results = await Promise.all(
      servers.map(async (serverID) => {
        const epoch = this.nextRefreshEpoch(serverID);
        // Snapshot boundary: events stamped after this are newer than the active set below.
        const snapshotSeq = this.runningEventSequence;
        let backend;
        try {
          backend = this.backendFor(serverID);
        } catch (error) {
          return {
            serverID,
            epoch,
            snapshotSeq,
            ok: false as const,
            error: error instanceof Error ? error.message : 'Unknown server',
            cause: error,
          };
        }
        const cursor = this.state.serverPages[serverID]?.cursor;
        try {
          const [page, active] = await Promise.all([
            backend.listSessions(cursor === undefined ? {} : { cursor }),
            backend.activeSessionIDs(),
          ]);
          return { serverID, epoch, snapshotSeq, ok: true as const, page, active };
        } catch (error) {
          return {
            serverID,
            epoch,
            snapshotSeq,
            ok: false as const,
            error: error instanceof Error ? error.message : 'Unknown error loading sessions',
            cause: error,
          };
        }
      }),
    );
    const registered = new Set(this.serverIDs());
    const applied = results.filter(
      (result) =>
        registered.has(result.serverID) && this.isRefreshCurrent(result.serverID, result.epoch),
    );
    for (const result of applied) {
      this.deps.setServerHealth?.(
        result.serverID,
        result.ok ? { ok: true } : { ok: false, error: result.cause },
      );
    }
    batch(() => {
      let anyError: string | undefined;
      for (const result of applied) {
        if (!result.ok) {
          anyError = result.error;
          this.setState('serverPages', result.serverID, (current) => ({
            ...(current ?? { complete: false }),
            loading: false,
            ...(result.error === undefined ? {} : { error: result.error }),
          }));
          continue;
        }
        this.setState('sessions', (current) => {
          const merged = { ...current };
          for (const session of result.page.sessions) {
            merged[this.keyFor(result.serverID, session.id)] = {
              ...session,
              serverID: result.serverID,
            };
          }
          return merged;
        });
        this.setState('serverPages', result.serverID, {
          ...(result.page.nextCursor === undefined ? {} : { cursor: result.page.nextCursor }),
          complete: result.page.nextCursor === undefined,
          loading: false,
        });
        this.reconcileRunning(result.serverID, result.active, result.snapshotSeq);
      }
      const all = this.serverIDs().map((serverID) => this.state.serverPages[serverID]);
      this.setState(
        'sessionsComplete',
        all.every((page) => page?.complete === true),
      );
      this.setState(
        'sessionsCursor',
        this.serverIDs().find((serverID) => this.state.serverPages[serverID]?.cursor !== undefined)
          ? this.state.serverPages[
              this.serverIDs().find(
                (serverID) => this.state.serverPages[serverID]?.cursor !== undefined,
              ) ?? this.serverID
            ]?.cursor
          : undefined,
      );
      this.setState('sessionsLoading', false);
      this.setState('sessionsError', anyError);
    });
    for (const result of results) {
      if ('error' in result) continue;
      await Promise.all(
        [...result.active].map((sessionID) =>
          this.refreshInputRequests(sessionID, result.serverID),
        ),
      );
    }
    this.debugLog.write('action', { action: 'load-more-sessions', ok: true });
    if (this.state.sessionsComplete && this.state.overview.selectedRow === loadMoreRowKey) {
      const rows = this.overviewRows();
      const last = rows[rows.length - 1];
      if (last !== undefined) this.selectRow(last);
      else this.setState('overview', 'selectedRow', undefined);
    }
  }

  /** Agent and model for a brand-new session in the overview. */
  setNewSessionDefaults(agent: string | undefined, model: ModelSelection | undefined): void {
    this.setState('overview', 'agent', agent);
    this.setState('overview', 'model', model);
  }

  resolveCliModel(request: {
    provider?: string;
    model?: string;
    effort?: string;
  }): { ok: true; model?: ModelSelection } | { ok: false; message: string } {
    const result = resolveModel(request, this.state.models);
    if (result.kind === 'error') return { ok: false, message: result.message };
    return result.kind === 'resolved' ? { ok: true, model: result.model } : { ok: true };
  }

  resolveCliAgent(
    requested: string | undefined,
  ): { ok: true; agent?: string } | { ok: false; message: string } {
    if (requested === undefined) {
      const fallback = defaultAgent(this.state.agents, this.deps.config.agents.default);
      return fallback === undefined ? { ok: true } : { ok: true, agent: fallback.id };
    }
    if (this.state.agents.some((agent) => agent.id === requested))
      return { ok: true, agent: requested };
    const available = this.state.agents.map((agent) => agent.id).join(', ');
    return {
      ok: false,
      message: `Agent "${requested}" is not selectable. Available: ${available}.`,
    };
  }

  /**
   * Applies explicit `--agent/--provider/--model/--effort` flags to an existing session
   * (`--resume`, `--continue`) before its prompt is admitted. Choices are validated against
   * that session's own project catalog, flags left out change nothing, and any failure is
   * reported so the turn never silently runs with the old selection.
   */
  async applyCliOverrides(
    sessionID: string,
    flags: { agent?: string; provider?: string; model?: string; effort?: string },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const wantsModel =
      flags.provider !== undefined || flags.model !== undefined || flags.effort !== undefined;
    if (flags.agent === undefined && !wantsModel) return { ok: true };
    const session = await this.ensureSession(sessionID);
    if (session === undefined) return { ok: false, message: `session ${sessionID} not found.` };
    if (!(await this.ensureCatalog(session.directory))) {
      return { ok: false, message: `could not load the catalog for ${session.directory}.` };
    }
    let agent: string | undefined;
    if (flags.agent !== undefined) {
      const resolved = this.resolveCliAgent(flags.agent);
      if (!resolved.ok) return resolved;
      agent = resolved.agent;
    }
    let model: ModelSelection | undefined;
    if (wantsModel) {
      const resolved = this.resolveCliModel({
        ...(flags.provider === undefined ? {} : { provider: flags.provider }),
        ...(flags.model === undefined ? {} : { model: flags.model }),
        ...(flags.effort === undefined ? {} : { effort: flags.effort }),
      });
      if (!resolved.ok) return resolved;
      model = resolved.model;
    }
    try {
      if (agent !== undefined) await this.backend.switchAgent(sessionID, agent);
      if (model !== undefined && !(await this.switchSessionModel(session, model))) {
        return { ok: false, message: 'The server did not confirm the requested model.' };
      }
    } catch (error) {
      return { ok: false, message: `could not apply the requested selection: ${errorText(error)}` };
    }
    if (model !== undefined) this.rememberModel(model);
    await this.refreshSummary(sessionID);
    return { ok: true };
  }

  // ---------------------------------------------------------------- events

  onStreamStatus(serverID: string, status: StreamStatus): void {
    this.debugLog.write('stream-status', { serverID, status });
    // Track every host's stream so the viewed conversation's footer reflects its own host,
    // not the launch server's badge (issue #109).
    this.streamByServer.set(serverID, status);
    // The single stream badge belongs to the launch server; per-server health lives on the
    // manager. A remote reconnect resyncs that host only and never touches the badge.
    if (serverID !== this.serverID) return;
    const reconnected = status === 'live' && this.state.stream === 'reconnecting';
    this.setState('stream', status);
    if (status === 'reconnecting') this.showNotice('Connection lost · retrying', 'warn', false);
    if (reconnected) void this.track('resync', this.resync(serverID));
  }

  onEvents(serverID: string, events: readonly BackendEvent[], resync: boolean): void {
    this.debugLog.write('events', {
      serverID,
      count: events.length,
      kinds: [...new Set(events.map((event) => event.kind))],
      resync,
    });
    if (this.disposed) return;
    if (resync) {
      void this.track('resync', this.resync(serverID));
      return;
    }
    batch(() => {
      for (const event of events) this.applyEvent(serverID, event);
    });
  }

  /**
   * A stream (re)connect means we may have missed events for that host: refetch that
   * host's snapshot only. Other servers are untouched; the route keeps what it has.
   */
  private async resync(serverID: string): Promise<void> {
    await this.loadSessions(serverID);
    const route = this.state.route;
    const routeServer =
      route.kind === 'overview' ? this.state.overview.project.serverID : route.serverID;
    // The catalog is one global pair of lists scoped to (directory, server); reload it
    // only when the resyncing server owns the scope the user is looking at.
    if (routeServer === serverID)
      void this.track('catalog', this.loadCatalog(this.currentDirectory(), serverID));
    if (route.kind === 'conversation' && route.serverID === serverID)
      await this.loadConversation(route.sessionID, serverID);
    // Goal reads that failed while disconnected are re-tried; a successful push or read
    // during the outage already superseded them (version guard).
    const unattached = Object.entries(this.state.nativeGoals)
      .filter(
        ([key, goal]) =>
          goal.status === 'unavailable' &&
          parseSessionKey(key).serverID === serverID &&
          (route.kind !== 'conversation' || route.sessionID !== parseSessionKey(key).sessionID),
      )
      .map(([key]) => parseSessionKey(key).sessionID);
    await Promise.all(unattached.map((id) => this.refreshNativeGoal(id, serverID).catch(() => {})));
    for (const key of Object.keys(this.state.transcripts)) {
      if (parseSessionKey(key).serverID === serverID) {
        if (route.kind !== 'conversation' || route.sessionID !== parseSessionKey(key).sessionID) {
          this.setState('transcripts', key, 'stale', true);
        }
      }
    }
    if (serverID === this.serverID && this.state.notice?.text === 'Connection lost · retrying')
      this.clearNotice();
  }

  private applyEvent(serverID: string, event: BackendEvent): void {
    const attached =
      this.state.route.kind === 'conversation' && this.state.route.serverID === serverID
        ? this.state.route.sessionID
        : undefined;
    switch (event.kind) {
      case 'connected':
        return;
      case 'catalog-changed': {
        const route = this.state.route;
        const routeServer =
          route.kind === 'overview' ? this.state.overview.project.serverID : route.serverID;
        if (routeServer !== serverID) return; // another host's catalog is not ours to reload
        void this.track('catalog', this.loadCatalog(this.currentDirectory(), serverID));
        return;
      }
      case 'revert-changed':
        // Immediate reconcile (not debounced): opens the recovery dialog for a staged
        // revert we do not know about, or drops one resolved elsewhere.
        void this.track('revert', this.refreshSummary(event.sessionID, serverID));
        return;
      case 'session-changed':
        this.scheduleSummary(event.sessionID, serverID);
        return;
      case 'session-deleted':
        this.forgetSession(event.sessionID, serverID);
        return;
      case 'usage':
        if (this.state.sessions[this.keyFor(serverID, event.sessionID)] !== undefined) {
          this.setState('sessions', this.keyFor(serverID, event.sessionID), {
            cost: event.cost,
            tokens: event.tokens,
          });
        }
        return;
      case 'execution': {
        const key = this.keyFor(serverID, event.sessionID);
        // Stamp the event so a snapshot that began before it can never overwrite it.
        this.runningEventSeq.set(key, (this.runningEventSequence += 1));
        this.setState('running', key, event.state === 'started');
        this.scheduleSummary(event.sessionID, serverID);
        if (attached === event.sessionID) this.scheduleTranscript(event.sessionID, serverID);
        else this.markStale(event.sessionID, serverID);
        if (event.state !== 'started')
          void this.track('requests', this.refreshInputRequests(event.sessionID, serverID));
        return;
      }
      case 'transcript-changed':
        if (this.state.sessions[this.keyFor(serverID, event.sessionID)] === undefined)
          this.scheduleSummary(event.sessionID, serverID);
        if (attached === event.sessionID) this.scheduleTranscript(event.sessionID, serverID);
        else this.markStale(event.sessionID, serverID);
        return;
      case 'inbox-changed':
        if (attached === event.sessionID)
          void this.track('inbox', this.refreshInbox(event.sessionID, serverID));
        return;
      case 'input-requests-changed':
        void this.track('requests', this.refreshInputRequests(event.sessionID, serverID));
        return;
      case 'goal-changed':
        this.bumpGoalVersion(event.sessionID, serverID);
        this.setNativeGoalState(
          event.sessionID,
          event.goal === null ? { status: 'none' } : { status: 'verified', goal: event.goal },
          serverID,
        );
        return;
      default:
        return;
    }
  }

  private markStale(sessionID: string, serverID: string = this.activeServerID()): void {
    const key = this.keyFor(serverID, sessionID);
    if (this.state.transcripts[key] !== undefined) {
      this.setState('transcripts', key, 'stale', true);
    }
  }

  /** Coalesces bursts of summary-changing events into one `session.get`. */
  private scheduleSummary(sessionID: string, serverID: string = this.activeServerID()): void {
    const key = `${serverID} ${sessionID}`;
    if (this.summaryTimers.has(key)) return;
    this.summaryTimers.set(
      key,
      setTimeout(() => {
        this.summaryTimers.delete(key);
        void this.track('session', this.refreshSummary(sessionID, serverID));
      }, 150),
    );
  }

  private async refreshSummary(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): Promise<void> {
    const key = this.keyFor(serverID, sessionID);
    const revision = this.modelSwitchRevisions.get(key);
    try {
      const session = await this.backendFor(serverID).getSession(sessionID);
      if (this.modelSwitchRevisions.get(key) !== revision) return;
      // reconcile replaces the stored summary wholesale: absent `revert` is removed again.
      // Never lose the server stamp: a backend that omits it must not orphan the row.
      this.setState(
        'sessions',
        key,
        reconcile(this.withConfirmedModel(key, { ...session, serverID })),
      );
      this.reconcileStagedRevert(sessionID, serverID);
    } catch (error) {
      if (error instanceof BackendError && error.kind === 'not-found') return;
      throw error;
    }
  }

  private async refreshInbox(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): Promise<void> {
    const items = await this.backendFor(serverID).listInbox(sessionID);
    this.setState('inbox', this.keyFor(serverID, sessionID), items);
  }

  private async refreshInputRequests(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): Promise<void> {
    const backend = this.backendFor(serverID);
    const [permissions, forms] = await Promise.all([
      backend.listPermissions(sessionID),
      backend.listForms(sessionID),
    ]);
    const key = this.keyFor(serverID, sessionID);
    batch(() => {
      this.setState('permissions', key, permissions);
      this.setState('forms', key, forms);
      if (permissions.length === 0) this.setState('permissionChoice', 0);
    });
  }

  // ---------------------------------------------------------------- transcripts

  /** Throttled canonical refetch: at most one request in flight per session. */
  private scheduleTranscript(sessionID: string, serverID: string = this.activeServerID()): void {
    const key = `${serverID} ${sessionID}`;
    if (this.transcriptInFlight.has(key)) {
      this.transcriptDirty.add(key);
      return;
    }
    const run = (async () => {
      try {
        await this.fetchLatest(sessionID, serverID);
        await delay(80);
      } finally {
        this.transcriptInFlight.delete(key);
      }
      if (this.transcriptDirty.delete(key) && !this.disposed)
        this.scheduleTranscript(sessionID, serverID);
    })();
    this.transcriptInFlight.set(key, run);
    void this.track('transcript', run);
  }

  private async fetchLatest(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): Promise<void> {
    const key = this.keyFor(serverID, sessionID);
    const page = await this.backendFor(serverID).listMessages(sessionID, transcriptPageSize);
    const existing = this.state.transcripts[key];
    const merged = mergeLatest(existing?.messages ?? [], page.messages);
    // Cached messages older than this page keep their own cursor; otherwise the page's
    // cursor is the way further back (an empty placeholder transcript has none).
    // A backend that reports an exhausted page must not keep a phantom "earlier" state,
    // even when it still carries a raw server pagination token.
    const freshCursor = page.hasEarlier === false ? undefined : page.olderCursor;
    const olderCursor = merged.length > page.messages.length ? existing?.olderCursor : freshCursor;
    this.setState(
      'transcripts',
      produce((transcripts) => {
        transcripts[key] = {
          messages: merged,
          loading: false,
          stale: false,
          ...(olderCursor === undefined ? {} : { olderCursor }),
        };
      }),
    );
    this.touchTranscript(key);
  }

  async loadOlder(sessionID: string, serverID: string = this.activeServerID()): Promise<void> {
    const key = this.keyFor(serverID, sessionID);
    const transcript = this.state.transcripts[key];
    if (transcript?.olderCursor === undefined || transcript.loading) return;
    this.setState('transcripts', key, 'loading', true);
    try {
      const page = await this.backendFor(serverID).listMessages(
        sessionID,
        transcriptPageSize,
        transcript.olderCursor,
      );
      const known = new Set(transcript.messages.map((message) => message.id));
      const older = page.messages.filter((message) => !known.has(message.id));
      // Replace via produce: a merging setter would keep a stale cursor after the last page.
      this.setState(
        'transcripts',
        key,
        produce((current) => {
          current.messages = [...older, ...current.messages];
          current.loading = false;
          if (page.hasEarlier === false || page.olderCursor === undefined)
            delete current.olderCursor;
          else current.olderCursor = page.olderCursor;
        }),
      );
    } catch (error) {
      this.setState('transcripts', key, 'loading', false);
      throw error;
    }
  }

  /** Rendered node limit for a session's transcript. */
  transcriptWindow(sessionID: string, serverID: string = this.activeServerID()): number {
    return this.state.transcriptWindow[this.keyFor(serverID, sessionID)] ?? transcriptWindowStep;
  }

  /**
   * Paging past the top: first un-hide already loaded nodes, then fetch the next older
   * page from the server. Returns false when there is nothing earlier.
   */
  revealEarlier(
    sessionID: string,
    hiddenNodes: number,
    serverID: string = this.activeServerID(),
  ): boolean {
    const key = this.keyFor(serverID, sessionID);
    if (hiddenNodes > 0) {
      this.setState(
        'transcriptWindow',
        key,
        this.transcriptWindow(sessionID, serverID) + transcriptWindowStep,
      );
      return true;
    }
    const transcript = this.state.transcripts[key];
    if (transcript?.olderCursor === undefined) return false;
    this.setState(
      'transcriptWindow',
      key,
      this.transcriptWindow(sessionID, serverID) + transcriptWindowStep,
    );
    void this.track('history', this.loadOlder(sessionID, serverID));
    return true;
  }

  /** Bounded LRU of cached transcripts; detached sessions keep summaries only. */
  private touchTranscript(key: string): void {
    this.transcriptOrder = [key, ...this.transcriptOrder.filter((entry) => entry !== key)];
    const evicted = this.transcriptOrder.slice(transcriptCacheLimit);
    this.transcriptOrder = this.transcriptOrder.slice(0, transcriptCacheLimit);
    if (evicted.length === 0) return;
    this.setState(
      produce((state) => {
        for (const entry of evicted) delete state.transcripts[entry];
      }),
    );
  }

  private async loadConversation(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): Promise<void> {
    await Promise.all([
      this.fetchLatest(sessionID, serverID),
      this.refreshInbox(sessionID, serverID),
      this.refreshInputRequests(sessionID, serverID),
      this.refreshSummary(sessionID, serverID),
      this.refreshNativeGoal(sessionID),
    ]);
  }

  // ---------------------------------------------------------------- navigation

  /** View change only: no backend mutation. Drafts are kept per route. */
  openSession(sessionID: string, serverID: string = this.serverID): void {
    this.debugLog.write('route', { kind: 'conversation', serverID, sessionID });
    this.saveDraft();
    this.invalidateCompletion();
    const transcript = this.state.transcripts[this.keyFor(serverID, sessionID)];
    batch(() => {
      this.setState('route', { kind: 'conversation', serverID, sessionID });
      this.setState('overlay', { kind: 'none' });
      this.setState('completion', undefined);
      this.setState('focusedGroup', undefined);
      this.setState('permissionChoice', 0);
      this.setState('openedAt', this.keyFor(serverID, sessionID), this.deps.now());
      this.restoreDraft(this.keyFor(serverID, sessionID));
      if (transcript === undefined) {
        this.setState('transcripts', this.keyFor(serverID, sessionID), {
          messages: [],
          loading: true,
          stale: false,
        });
      }
    });
    const directory = this.state.sessions[this.keyFor(serverID, sessionID)]?.directory;
    if (directory !== undefined) {
      this.loadHistoryFor(directory, serverID);
      this.refreshCatalogIfStale(directory, serverID);
    }
    void this.track('attach', this.loadConversation(sessionID, serverID));
    void this.loadGoal(sessionID);
  }

  /**
   * An unsent conversation in `directory`. Nothing is created on the server until the
   * first prompt is submitted, so opening margarita never leaves empty sessions behind.
   */
  startNewSession(directory: string, serverID: string = this.serverID): void {
    this.debugLog.write('route', { kind: 'new', serverID, directory });
    this.saveDraft();
    this.invalidateCompletion();
    batch(() => {
      this.setState('route', { kind: 'new', serverID, directory });
      this.setState('overlay', { kind: 'none' });
      this.setState('completion', undefined);
      this.setState('focusedGroup', undefined);
      this.setState('overview', 'project', { serverID, directory });
      this.restoreDraft(`new:${this.projectKeyOf(directory, serverID)}`);
    });
    this.loadHistoryFor(directory, serverID);
    this.refreshCatalogIfStale(directory, serverID);
  }

  /**
   * View change only: the session keeps running on the server. The cursor starts on
   * the first row; typing still goes straight to the new-session prompt.
   */
  openOverview(): void {
    this.debugLog.write('route', { kind: 'overview' });
    this.saveDraft();
    this.invalidateCompletion();
    const project = this.currentProject();
    batch(() => {
      this.setState('route', { kind: 'overview' });
      this.setState('overlay', { kind: 'none' });
      this.setState('completion', undefined);
      this.setState('focusedGroup', undefined);
      this.writeComposer(this.state.drafts['overview'] ?? emptyComposer);
      this.setState('attachments', [...(this.state.draftAttachments['overview'] ?? [])]);
      this.setState('overview', 'project', project);
      // Keep the selection on the project we came from instead of jumping to whatever
      // group sorts first; any other host's first row would silently retarget the
      // composer and its catalog actions (issue #79).
      const rows = this.overviewRows();
      const inProject = rows.find(
        (row) =>
          row.kind === 'session' &&
          row.session.serverID === project.serverID &&
          directoryKey(row.session.directory, this.platformFor(row.session.serverID)) ===
            directoryKey(project.directory, this.platformFor(project.serverID)),
      );
      // Preserve the originating project when the active filter excludes its sessions.
      // Do not fall back to rows[0]: selectRow() would silently retarget overview.project
      // (and the composer) to a different host/directory (issue #106). With no matching
      // row, keep the composer focused on the originating project and select nothing.
      if (inProject === undefined) {
        this.setState('overview', 'focus', 'composer');
        this.setState('overview', 'selectedRow', undefined);
      } else {
        this.selectRow(inProject);
      }
    });
    this.loadHistoryFor(
      this.state.overview.project.directory,
      this.state.overview.project.serverID,
    );
  }

  /**
   * Replaces the composer with a fresh object. A path setter would shallow-merge into
   * the stored object, which may be shared (a draft, or the `emptyComposer` constant).
   */
  private writeComposer(composer: Composer): void {
    this.setState({ composer: { ...composer } });
  }

  private saveDraft(): void {
    const key = this.routeKey(this.state.route);
    batch(() => {
      this.setState('drafts', key, { ...this.state.composer });
      this.setState('draftAttachments', key, [...this.state.attachments]);
    });
  }

  /**
   * Stable draft key for a route. Server-qualified so two servers can never overwrite each
   * other's drafts, even with identical session IDs or directory paths.
   */
  private routeKey(route: Route): string {
    switch (route.kind) {
      case 'overview':
        return 'overview';
      case 'new':
        return `new:${this.projectKeyOf(route.directory, route.serverID)}`;
      default:
        return this.keyFor(route.serverID, route.sessionID);
    }
  }

  /** Restores a route's saved text and its attachments together. */
  private restoreDraft(key: string): void {
    batch(() => {
      this.writeComposer(this.state.drafts[key] ?? emptyComposer);
      this.setState('attachments', [...(this.state.draftAttachments[key] ?? [])]);
    });
  }

  private selectRow(row: OverviewRow): void {
    this.setState('overview', 'focus', 'list');
    this.setState('overview', 'selectedRow', row.key);
    const project =
      row.kind === 'session'
        ? { serverID: row.session.serverID, directory: row.session.directory }
        : row.kind === 'toggle'
          ? (() => {
              const group = this.groups().find((entry) => entry.key === row.groupKey);
              return group === undefined
                ? undefined
                : { serverID: group.serverID, directory: group.directory };
            })()
          : undefined; // loadmore keeps the current project
    if (project !== undefined) {
      const current = this.state.overview.project;
      const changed =
        current.serverID !== project.serverID ||
        directoryKey(current.directory, this.platformFor(current.serverID)) !==
          directoryKey(project.directory, this.platformFor(project.serverID));
      this.setState('overview', 'project', project);
      // Reload the newly selected project's persisted history so Up/Down and prompt
      // recording always target the viewed project, never the one just left (#107).
      if (changed) {
        this.loadHistoryFor(project.directory, project.serverID);
        // A choice made on the previous host must not be carried into a session on this
        // one: reset new-session defaults so they are scoped to the new catalog (#108).
        this.setState('overview', 'agent', undefined);
        this.setState('overview', 'model', undefined);
        // A project switch retargets new-session completion, so an in-flight file scan for
        // the previous project must not land here (issue #112).
        this.invalidateCompletion();
      }
    }
  }

  selectedOverviewRow(): OverviewRow | undefined {
    const key = this.state.overview.selectedRow;
    return key === undefined ? undefined : this.overviewRows().find((row) => row.key === key);
  }

  moveOverviewSelection(direction: -1 | 1): void {
    const rows = this.overviewRows();
    if (rows.length === 0) return;
    const current = this.state.overview.selectedRow;
    const index = current === undefined ? -1 : rows.findIndex((row) => row.key === current);
    let next: number;
    if (this.state.overview.focus === 'composer') {
      if (direction === 1) return;
      next = rows.length - 1;
    } else {
      next = index + direction;
      if (next >= rows.length) {
        this.setState('overview', 'focus', 'composer');
        return;
      }
      if (next < 0) next = 0;
    }
    const row = rows[next];
    if (row !== undefined) batch(() => this.selectRow(row));
  }

  focusOverviewComposer(): void {
    this.setState('overview', 'focus', 'composer');
  }

  /**
   * Focus the overview composer and insert text as one action. Both typed keys and pasted
   * text use this so input can never land in a composer that is not focused (issue 15).
   */
  activateOverviewComposer(text: string): void {
    this.focusOverviewComposer();
    this.setComposer(insertText(this.state.composer, text));
  }

  /**
   * One terminal paste. Text is inserted as before, except when the whole paste names local
   * image/PDF files: those become attachments. Non-text bytes are accepted only when they
   * carry a known image/PDF signature; arbitrary binary is rejected instead of being decoded
   * into placeholder characters.
   */
  async pasteBytes(bytes: Uint8Array): Promise<void> {
    // Serialize paste transactions in arrival order. The originating route is captured
    // synchronously here (before `run` is deferred onto the microtask queue) so a route
    // switch while files are read cannot retarget the paste (issue #87).
    if (this.disposed) return;
    const originKey = this.routeKey(this.state.route);

    const run = async (): Promise<void> => {
      if (this.disposed) return;

      const text = decodePastedText(bytes);
      if (text !== undefined) {
        const consumed = await this.attachPastedPaths(text, originKey);
        if (consumed) return;
        this.insertPastedText(text, originKey);
        return;
      }

      const mime = detectAttachmentMime(bytes);
      if (mime === undefined) {
        this.showNotice('Pasted data is not text or a supported image.', 'warn');
        return;
      }
      const name = `clipboard.${mime.split('/').at(-1) ?? 'bin'}`;
      this.attachImage(bytes, mime, name);
    };
    this.pasteChain = this.pasteChain.then(run).catch(() => undefined);
    await this.pasteChain;
  }

  /** True when no route or overlay change has occurred since `originKey` was captured. */
  private pasteStillCurrent(originKey: string): boolean {
    return (
      !this.disposed &&
      this.routeKey(this.state.route) === originKey &&
      this.state.overlay.kind === 'none'
    );
  }

  /**
   * Inserts pasted text into the originating route. If the route changed while the paste was
   * in flight, the text is stashed into the originating draft instead of another route's
   * composer.
   */
  private insertPastedText(text: string, originKey: string): void {
    if (!this.pasteStillCurrent(originKey)) {
      this.stashPasteText(originKey, text);
      return;
    }
    this.activateOverviewComposer(text);
  }

  /** Stashes already-read attachments into the originating draft when the route changed. */
  private stashPaste(originKey: string, added: readonly Attachment[]): void {
    const current = this.state.draftAttachments[originKey] ?? [];
    batch(() => {
      this.setState('draftAttachments', originKey, [...current, ...added]);
    });
    this.showNotice(
      `Paste stashed: the route changed while reading ${added.length} file(s); they await in the originating draft.`,
      'warn',
    );
  }

  /** Stashes pasted text into the originating draft when the route changed. */
  private stashPasteText(originKey: string, text: string): void {
    const draft = this.state.drafts[originKey] ?? emptyComposer;
    batch(() => {
      this.setState('drafts', originKey, insertText(draft, text));
    });
    this.showNotice(
      'Paste stashed: the route changed before the text landed; it awaits in the originating draft.',
      'warn',
    );
  }

  /** Attaches an image from any source that already decoded it (tests, future clipboards). */
  attachImage(bytes: Uint8Array, mime: string, name: string): boolean {
    const result = makeAttachment(name, mime, bytes);
    if (!result.ok) {
      this.showNotice(result.error, 'warn');
      return false;
    }
    this.addAttachments([result.attachment], `${name} attached`);
    return true;
  }

  /** Removes the most recently attached image; Backspace on an empty composer calls this. */
  detachLastAttachment(): boolean {
    const current = this.state.attachments;
    const last = current.at(-1);
    if (last === undefined) return false;
    this.setState(
      'attachments',
      current.filter((attachment) => attachment.id !== last.id),
    );
    this.showNotice(`${last.name} removed`, 'dim');
    return true;
  }

  removeAttachment(id: string): void {
    this.setState(
      'attachments',
      this.state.attachments.filter((attachment) => attachment.id !== id),
    );
  }

  private addAttachments(added: readonly Attachment[], notice?: string): void {
    this.focusOverviewComposer();
    this.setState('attachments', (current) => [...current, ...added]);
    if (notice !== undefined) this.showNotice(notice, 'dim');
  }

  /**
   * A pasted path (or several) becomes an attachment only when every token names an existing
   * supported file. Anything else falls through to normal text insertion, so pasting a
   * sentence or a code path never silently swallows it.
   */
  private async attachPastedPaths(text: string, originKey: string): Promise<boolean> {
    const trimmed = text.trim();
    if (trimmed === '') return false;
    const paths = splitPastedPaths(trimmed, this.deps.platform);
    if (paths.length === 0) return false;
    const added: Attachment[] = [];
    for (const path of paths) {
      const result = await this.readLocalAttachment(path);
      if (result === undefined) return false;
      if ('error' in result) {
        this.showNotice(result.error, 'warn');
        return true;
      }
      added.push(result.attachment);
    }
    if (added.length === 0) return false;
    if (!this.pasteStillCurrent(originKey)) {
      // A route or overlay change while reading: stash the whole group into the
      // originating draft and leave the current route untouched.
      this.stashPaste(originKey, added);
      return true;
    }
    this.addAttachments(
      added,
      added.length === 1
        ? `${added[0]?.name ?? 'File'} attached`
        : `${added.length} files attached`,
    );
    return true;
  }

  private async readLocalAttachment(
    path: string,
  ): Promise<{ attachment: Attachment } | { error: string } | undefined> {
    if (path === '' || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return undefined;
    const mime = attachmentMimeForName(path);
    if (mime === undefined) return undefined;
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;
    if (file.size > attachmentLimitBytes) {
      return { error: `${pastedAttachmentName(path)} is larger than 20 MB` };
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return { error: `Could not read ${pastedAttachmentName(path)}` };
    }
    const result = makeAttachment(pastedAttachmentName(path), mime, bytes);
    return result.ok ? { attachment: result.attachment } : { error: result.error };
  }

  /** Enter on a row: attach a session, expand/collapse a project, or page in more sessions. */
  attachSelected(): void {
    const row = this.selectedOverviewRow();
    if (row === undefined) return;
    if (row.kind === 'toggle') {
      this.toggleOverviewGroup(row.groupKey);
      return;
    }
    if (row.kind === 'loadmore') {
      void this.loadMoreSessions();
      return;
    }
    this.openSession(row.session.id, row.session.serverID);
  }

  toggleOverviewGroup(groupKey: string): void {
    this.setState(
      produce((state) => {
        if (state.overview.expanded[groupKey] === true) delete state.overview.expanded[groupKey];
        else state.overview.expanded[groupKey] = true;
      }),
    );
  }

  // ---------------------------------------------------------------- composer

  /** Records a user edit so it can be undone; consecutive typing collapses into one step. */
  private recordEdit(next: Composer): void {
    const key = this.routeKey(this.state.route);
    const before = this.state.composer;
    if (before.text === next.text) return;
    const coalesce =
      this.lastEditRoute === key &&
      this.now() - this.lastEditAt <= typingCoalesceMs &&
      isSingleGraphemeStep(before.text, next.text);
    if (!coalesce) {
      const stack = this.undoStacks.get(key) ?? [];
      stack.push({ composer: { ...before } });
      if (stack.length > undoLimit) stack.shift();
      this.undoStacks.set(key, stack);
      this.redoStacks.set(key, []);
    }
    this.lastEditAt = this.now();
    this.lastEditRoute = key;
  }

  /** Undo the last edit on this route; restoring does not touch attachments. */
  undo(): void {
    const key = this.routeKey(this.state.route);
    const stack = this.undoStacks.get(key) ?? [];
    const previous = stack.pop();
    if (previous === undefined) return;
    const redo = this.redoStacks.get(key) ?? [];
    redo.push({ composer: { ...this.state.composer } });
    this.undoStacks.set(key, stack);
    this.redoStacks.set(key, redo);
    this.lastEditRoute = '';
    this.writeComposer(previous.composer);
  }

  /** Redo an edit that was just undone on this route. */
  redo(): void {
    const key = this.routeKey(this.state.route);
    const stack = this.redoStacks.get(key) ?? [];
    const next = stack.pop();
    if (next === undefined) return;
    const undo = this.undoStacks.get(key) ?? [];
    undo.push({ composer: { ...this.state.composer } });
    this.redoStacks.set(key, stack);
    this.undoStacks.set(key, undo);
    this.lastEditRoute = '';
    this.writeComposer(next.composer);
  }

  /** Sending an acknowledged prompt checkpoints the draft: no undo across sent turns. */
  private clearEdits(): void {
    const key = this.routeKey(this.state.route);
    this.undoStacks.delete(key);
    this.redoStacks.delete(key);
    this.lastEditRoute = '';
  }

  setComposer(composer: Composer): void {
    this.recordEdit(composer);
    batch(() => {
      this.writeComposer(composer);
      this.setState('exitArmed', false);
      if (composer.text !== '' && this.state.focusedGroup !== undefined) {
        this.setState('focusedGroup', undefined);
      }
      if (this.state.history.index !== undefined) {
        this.setState('history', { entries: this.state.history.entries, savedDraft: '' });
      }
    });
    this.updateCompletion();
  }

  private updateCompletion(): void {
    const { text, cursor } = this.state.composer;
    if (text.startsWith('/') && !/\s/.test(text)) {
      const directory = this.currentDirectory();
      const fresh = this.catalogFresh(directory);
      if (!fresh) {
        // Keep local commands available while the target catalog reloads.
        this.refreshCatalogIfStale(directory);
      }
      const items = completeCommand(text, fresh ? this.state.serverCommands : []).map((item) => ({
        label: `/${item.name}`,
        detail: item.description,
        insert: `/${item.name} `,
      }));
      this.setState(
        'completion',
        items.length === 0 || (items.length === 1 && items[0]?.label === text)
          ? undefined
          : { kind: 'command', items, index: 0, start: 0 },
      );
      return;
    }
    const mention = activeMention(text, cursor);
    if (mention !== undefined) {
      void this.track('files', this.completeMentions(mention.path, mention.start));
      return;
    }
    if (this.state.completion !== undefined) this.setState('completion', undefined);
  }

  /** Bump so any in-flight file scan is rejected even if its directory string and mention
   * are unchanged (issue #112). */
  private invalidateCompletion(): void {
    this.completionGeneration += 1;
  }

  private async completeMentions(partial: string, start: number): Promise<void> {
    const request = ++this.completionRequest;
    const root = this.currentDirectory();
    // The selected route's server decides the filesystem, not the launch connection.
    const serverID = this.activeServerID();
    const generation = this.completionGeneration;
    const remote = this.isRemoteServer(serverID);
    const files = remote
      ? await this.backendFor(serverID)
          .findProjectFiles(root, partial, 50)
          .catch(() => [] as string[]) // best-effort completion; unreadable server is silent here
      : await this.filesFor(root);
    const mention = activeMention(this.state.composer.text, this.state.composer.cursor);
    if (
      request !== this.completionRequest || // a newer mention superseded this one
      this.activeServerID() !== serverID || // switched to a different host mid-scan
      this.completionGeneration !== generation || // route/project/tab switched mid-scan
      mention === undefined ||
      mention.start !== start ||
      mention.path !== partial || // same offset, different query (`@a` → `@src`)
      this.currentDirectory() !== root // project switched mid-scan
    ) {
      return;
    }
    // Agents complete bare `@name` mentions from this server's scoped catalog, visibly
    // distinguished from files by their detail label (issue #99).
    const agentItems =
      partial === '' || /[\\/.]/.test(partial)
        ? []
        : this.state.agents
            .filter((agent) => agent.id.toLowerCase().startsWith(partial.toLowerCase()))
            .slice(0, 8)
            .map((agent) => ({
              label: `@${agent.id}`,
              detail: 'agent',
              insert: `@${agent.id} `,
            }));
    // Remote results arrive ranked by the server's own fuzzy search; trust that order.
    const fileItems = (remote ? files.slice(0, 8) : rankPaths(files, partial, 8))
      .filter((path) => !agentItems.some((item) => item.label === `@${path}`))
      .map((path) => ({ label: `@${path}`, detail: '', insert: `@${path} ` }));
    const items = [...agentItems, ...fileItems];
    this.setState(
      'completion',
      items.length === 0 ? undefined : { kind: 'file', items, index: 0, start },
    );
  }

  /**
   * Shared, single-flight scan per directory. Concurrent mentions during one scan all await the
   * same traversal; the result is cached per root until the project changes.
   */
  private filesFor(root: string): Promise<string[]> {
    const cache = this.fileCache;
    if (cache?.root === root) return Promise.resolve(cache.files);
    const existing = this.fileScans.get(root);
    if (existing !== undefined) return existing;
    const work = this.deps
      .listFiles(root)
      .then((files) => {
        this.fileCache = { root, files };
        return files;
      })
      .finally(() => {
        this.fileScans.delete(root);
      });
    this.fileScans.set(root, work);
    return work;
  }

  moveCompletion(direction: -1 | 1): void {
    const completion = this.state.completion;
    if (completion === undefined) return;
    const count = completion.items.length;
    this.setState('completion', {
      ...completion,
      index: (completion.index + direction + count) % count,
    });
  }

  acceptCompletion(): boolean {
    const completion = this.state.completion;
    const item = completion?.items[completion.index];
    if (completion === undefined || item === undefined) return false;
    const { text, cursor } = this.state.composer;
    const next = text.slice(0, completion.start) + item.insert + text.slice(cursor);
    batch(() => {
      this.writeComposer({ text: next, cursor: completion.start + item.insert.length });
      this.setState('completion', undefined);
      this.setState('focusedGroup', undefined);
    });
    return true;
  }

  dismissCompletion(): void {
    this.setState('completion', undefined);
  }

  historyUp(): boolean {
    const step = historyBack(this.state.history, this.state.composer.text);
    if (step === undefined) return false;
    batch(() => {
      this.setState('history', step.history);
      this.writeComposer(composerFrom(step.text));
    });
    return true;
  }

  historyDown(): boolean {
    const step = historyForward(this.state.history);
    if (step === undefined) return false;
    batch(() => {
      this.setState('history', step.history);
      this.writeComposer(composerFrom(step.text));
    });
    return true;
  }

  /** Records text removed by a kill command; an empty kill leaves the buffer intact. */
  killText(text: string): void {
    if (text !== '') this.killBuffer = text;
  }

  /** Text restored by Ctrl+Y at the cursor. */
  yankText(): string {
    return this.killBuffer;
  }

  toggleStash(): void {
    const route = this.state.route;
    const key =
      route.kind === 'overview'
        ? `overview:${this.projectKeyOf(this.currentDirectory(), this.activeServerID())}`
        : this.routeKey(route);
    const stash = this.state.stashes[key];
    if (this.state.composer.text !== '' || this.state.attachments.length > 0) {
      batch(() => {
        this.setState('stashes', key, {
          composer: { ...this.state.composer },
          attachments: [...this.state.attachments],
        });
        this.writeComposer(emptyComposer);
        this.setState('attachments', []);
      });
      this.showNotice('Draft stashed · Ctrl+S to restore', 'dim');
    } else if (stash !== undefined) {
      batch(() => {
        this.writeComposer(restoreComposer(stash.composer));
        this.setState('attachments', [...stash.attachments]);
        this.setState('stashes', key, undefined);
      });
    } else {
      const index = this.state.recovered.findIndex(
        (item) => this.keyFor(item.serverID, item.sessionID) === key,
      );
      const next = this.state.recovered[index];
      if (next === undefined) return;
      batch(() => {
        this.writeComposer(composerFrom(next.text));
        this.setState('attachments', [...(next.attachments ?? [])]);
        this.setState('recovered', (items) => items.filter((_, itemIndex) => itemIndex !== index));
      });
    }
  }

  openHistorySearch(): void {
    const overlay = this.state.overlay;
    if (overlay.kind === 'history-search') {
      const match = searchHistory(this.state.history, overlay.query, overlay.before);
      if (match !== undefined) this.setState('overlay', { ...overlay, before: match.index });
      return;
    }
    this.setState('overlay', {
      kind: 'history-search',
      query: '',
      before: this.state.history.entries.length,
    });
  }

  setHistoryQuery(query: string): void {
    this.setState('overlay', {
      kind: 'history-search',
      query,
      before: this.state.history.entries.length,
    });
  }

  historySearchMatch(): string | undefined {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'history-search' || overlay.query === '') return undefined;
    return searchHistory(this.state.history, overlay.query, overlay.before)?.text;
  }

  acceptHistorySearch(): void {
    const match = this.historySearchMatch();
    batch(() => {
      if (match !== undefined) this.writeComposer(composerFrom(match));
      this.setState('overlay', { kind: 'none' });
    });
  }

  /**
   * History entries for a project: the current key plus, for hosts paired before path-style
   * stamping existed, guarded legacy buckets. A POSIX directory on a Windows frontend was
   * stored win32-folded (case-insensitive, separators `\`); the fold is lossy, so entries
   * are adopted only when this directory is the only raw directory on the server claiming
   * the folded key — otherwise the two projects would share each other's prompt history.
   */
  private historyEntriesFor(directory: string, serverID: string, key: string): string[] {
    const limit = this.deps.config.history.limit;
    const current = [...(this.persisted.history[key] ?? [])];
    const entries = [...current];
    const seen = new Set(entries);
    for (const candidate of legacyProjectKeys(
      { serverID, directory },
      this.platformFor(serverID),
    )) {
      if (candidate.platform === 'win32' && this.win32FoldClaims(candidate.key, serverID) !== 1)
        continue;
      for (const entry of this.persisted.history[candidate.key] ?? []) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        entries.push(entry);
      }
    }
    return entries.slice(-limit);
  }

  /** How many distinct directories on the server win32-fold onto `key`. */
  private win32FoldClaims(key: string, serverID: string): number {
    const raws = new Set(
      Object.values(this.state.sessions)
        .filter((session) => session.serverID === serverID)
        .map((session) => session.directory),
    );
    let claims = 0;
    for (const raw of raws) {
      if (projectKey({ serverID, directory: raw }, 'win32') === key) claims += 1;
    }
    return claims;
  }

  private loadHistoryFor(directory: string, serverID: string = this.serverID): void {
    const key = this.projectKeyOf(directory, serverID);
    // Read the live snapshot: prompts recorded this run live in `persisted`, not in the
    // startup copy from `deps.localState`. Returning to a project must not hide them.
    // Replace each field rather than merge the object: a stale browse index from the
    // previous project would otherwise make historyUp() look like the end of this list.
    // A fresh array reference also keeps store mutations away from the persisted snapshot.
    this.setState('history', {
      entries: this.historyEntriesFor(directory, serverID, key),
      index: undefined,
      savedDraft: '',
    });
  }

  private rememberPrompt(text: string, directory: string, serverID: string = this.serverID): void {
    const key = this.projectKeyOf(directory, serverID);
    // Derive prior entries from the target project's persisted bucket, never from whichever
    // project's state.history happens to be in memory (issue #107).
    const prior = this.historyEntriesFor(directory, serverID, key);
    const history = recordEntry(
      { entries: prior, savedDraft: '' },
      text,
      this.deps.config.history.limit,
    );
    this.setState('history', history);
    this.persist({ history: { ...this.persisted.history, [key]: history.entries } });
  }

  // ---------------------------------------------------------------- submit

  /** Enter. Clears the composer only after the server accepted the input. */
  async submit(deliveryOverride?: Delivery): Promise<void> {
    if (this.state.admitting) return;
    const routeAtSubmit = this.state.route;
    const text = this.state.composer.text;
    if (text.trim() === '' && this.state.attachments.length === 0) return;
    const localName = /^\/(\S+)/.exec(text.trimStart())?.[1];
    const isLocal = localName !== undefined && isLocalCommand(localName);
    if (text.trimStart().startsWith('/')) {
      // Local control commands are frontend-local and must keep working when the server or
      // its catalog is broken; only server and plugin commands need the server catalog.
      if (!isLocal && !(await this.ensureCatalog(this.currentDirectory()))) return;
    }
    if (this.state.route !== routeAtSubmit || this.state.composer.text !== text) return;
    const parsed = parseInput(
      text,
      new Set(this.state.serverCommands.map((command) => command.name)),
    );
    if (parsed.kind === 'local') {
      if (
        routeAtSubmit.kind === 'conversation' &&
        (parsed.name === 'compact' ||
          parsed.name === 'steer' ||
          (parsed.name === 'plan' && parsed.args === 'propose')) &&
        this.modelDispatchBlocked(routeAtSubmit.serverID, routeAtSubmit.sessionID)
      ) {
        return;
      }
      this.clearComposer(text);
      await this.runLocalCommand(parsed.name, parsed.args);
      return;
    }
    if (parsed.kind === 'unknown-command') {
      this.showNotice(`Unknown command /${parsed.name}. Type / to see commands.`, 'warn');
      return;
    }
    if (this.state.route.kind !== 'conversation') {
      if (parsed.kind !== 'prompt') {
        this.showNotice('Start a session before running commands.', 'warn');
        return;
      }
      await this.createSessionWithPrompt(this.currentProject(), text);
      return;
    }
    // Capture the originating host/session before any await: a user may navigate to another
    // host while this request is in flight, and every RPC plus every composer side effect
    // must target the originating session, never the route the user happens to be on now.
    const origin: SessionRef = {
      serverID: this.state.route.serverID,
      sessionID: this.state.route.sessionID,
    };
    const directory =
      this.state.sessions[this.keyFor(origin.serverID, origin.sessionID)]?.directory ??
      this.deps.cwd;
    const commandNotice =
      'The request may or may not have been delivered (connection problem); check for its effects before resending.';
    const isPromptDelivery = parsed.kind === 'prompt';
    const sentAttachments = isPromptDelivery ? [...this.state.attachments] : [];
    const admitted = await this.admit(
      origin,
      text,
      directory,
      async () => {
        const backend = this.backendFor(origin.serverID);
        switch (parsed.kind) {
          case 'shell':
            await backend.runShell(origin.sessionID, parsed.command);
            return true;
          case 'server':
            await backend.runCommand(origin.sessionID, parsed.name, parsed.args);
            return true;
          case 'prompt': {
            const running =
              this.state.running[this.keyFor(origin.serverID, origin.sessionID)] === true;
            const delivery =
              deliveryOverride ?? (running ? this.deps.config.input.enterWhileRunning : undefined);
            const { files, agents } = await this.promptFiles(
              text,
              directory,
              sentAttachments,
              origin.serverID,
            );
            if (this.modelDispatchBlocked(origin.serverID, origin.sessionID)) return false;
            await backend.prompt(origin.sessionID, {
              text,
              files,
              ...(agents.length === 0 ? {} : { agents }),
              ...(delivery === undefined ? {} : { delivery }),
            });
            await this.refreshInbox(origin.sessionID, origin.serverID);
            return true;
          }
          default:
            return false;
        }
      },
      isPromptDelivery ? undefined : commandNotice,
      sentAttachments,
    );
    if (admitted) {
      // Only act on the originating session: if the route moved on, the draft was already
      // parked by admit and no follow-up should land on another host.
      const route = this.state.route;
      if (
        route.kind === 'conversation' &&
        route.serverID === origin.serverID &&
        route.sessionID === origin.sessionID
      ) {
        if (parsed.kind === 'prompt') {
          // The follow-up landed; reactivate the goal that Esc interrupted (if any).
          await this.maybeResumeInterruptedGoal(origin.sessionID, origin.serverID);
        } else if (parsed.kind === 'server' && parsed.name === 'goal') {
          const command = parsed.args.trim().toLowerCase();
          if (command === 'pause' || command === 'resume' || command === 'clear') {
            this.clearSteerIntent(origin.sessionID, origin.serverID);
          }
          await this.refreshNativeGoal(origin.sessionID, origin.serverID);
        }
      }
    }
  }

  /** Sends the current draft with steer delivery (F6, or Ctrl+Enter where the terminal reports it, or /steer). */
  async steer(): Promise<void> {
    if (this.state.route.kind !== 'conversation') return;
    await this.submit('steer');
  }

  private async admit(
    origin: SessionRef,
    text: string,
    directory: string,
    send: () => Promise<boolean>,
    transportNotice = 'Delivery unknown (connection problem). Check the transcript before resending.',
    sentAttachments: readonly Attachment[] = [],
  ): Promise<boolean> {
    if (this.state.admitting || this.modelDispatchBlocked(origin.serverID, origin.sessionID))
      return false;
    this.setState('admitting', true);
    try {
      if (!(await send())) return false;
      this.debugLog.write('action', { action: 'submit', ok: true });
      if (text.trim() !== '') this.rememberPrompt(text, directory, origin.serverID);
      // Only clear the composer if we are still on the originating session: a route change
      // mid-request means the composer now belongs to another session and must not be wiped.
      const route = this.state.route;
      if (
        route.kind === 'conversation' &&
        route.serverID === origin.serverID &&
        route.sessionID === origin.sessionID
      ) {
        this.clearComposer(text, sentAttachments);
      }
      return true;
    } catch (error) {
      this.debugLog.write('action', {
        action: 'submit',
        ok: false,
        errorKind: error instanceof BackendError ? error.kind : 'unknown',
      });
      if (error instanceof BackendError && error.kind === 'transport') {
        // The request may have landed. Show server state instead of resending blindly.
        this.showNotice(transportNotice, 'error');
        if (
          this.state.route.kind === 'conversation' &&
          this.state.route.serverID === origin.serverID &&
          this.state.route.sessionID === origin.sessionID
        ) {
          this.scheduleTranscript(origin.sessionID);
          void this.track('inbox', this.refreshInbox(origin.sessionID, origin.serverID));
        }
      } else {
        this.showNotice(errorText(error), 'error');
      }
      return false;
    } finally {
      this.setState('admitting', false);
    }
  }

  private clearComposer(submitted: string, sentAttachments: readonly Attachment[] = []): void {
    const sent = new Set(sentAttachments.map((attachment) => attachment.id));
    batch(() => {
      if (this.state.composer.text === submitted) {
        this.writeComposer(emptyComposer);
        this.clearEdits();
        this.setState('completion', undefined);
        this.setState('focusedGroup', undefined);
      }
      // Sent attachments are gone even if the user typed more while the request was in flight.
      if (sent.size > 0) {
        this.setState(
          'attachments',
          this.state.attachments.filter((attachment) => !sent.has(attachment.id)),
        );
      }
    });
  }

  private resolveFiles(
    text: string,
    directory: string,
    serverID: string = this.activeServerID(),
    exclude?: ReadonlySet<number>,
  ): Promise<PromptFile[]> {
    if (this.isRemoteServer(serverID))
      return this.resolveRemoteFiles(text, directory, serverID, exclude);
    return this.resolveLocalFiles(text, directory, exclude);
  }

  /**
   * Prompt files for a send: `@` mentions resolved for this server, then image/PDF
   * attachments. Attachments are inline `data:` URIs so a remote server never needs the
   * local path.
   */
  private async promptFiles(
    text: string,
    directory: string,
    attachments: readonly Attachment[] = this.state.attachments,
    serverID: string = this.activeServerID(),
  ): Promise<{
    files: PromptFile[];
    agents: readonly { name: string; mention?: { start: number; end: number; text: string } }[];
  }> {
    const agentRefs = agentMentions(
      findFileMentions(text),
      new Set(this.state.agents.map((a) => a.id)),
    );
    const excluded = new Set(agentRefs.map((mention) => mention.start));
    const mentioned = await this.resolveFiles(text, directory, serverID, excluded);
    return {
      files: [...mentioned, ...attachments.map((attachment) => attachmentPromptFile(attachment))],
      agents: agentRefs.map((mention) => ({
        name: mention.path,
        mention: { start: mention.start, end: mention.end, text: mention.text },
      })),
    };
  }

  private async resolveLocalFiles(
    text: string,
    directory: string,
    exclude?: ReadonlySet<number>,
  ): Promise<PromptFile[]> {
    const files: PromptFile[] = [];
    const missing: string[] = [];
    for (const mention of findFileMentions(text)) {
      if (exclude?.has(mention.start) === true) continue;
      if (mention.rangeError !== undefined) {
        missing.push(`${mention.text}: ${mention.rangeError}`);
        continue;
      }
      const path = isAbsolute(mention.path) ? mention.path : resolve(directory, mention.path);
      if (!(await Bun.file(path).exists())) {
        missing.push(mention.text);
        continue;
      }
      files.push({
        uri: withLineRange(pathToFileURL(path).href, mention.range),
        name: mention.path,
        mention: { start: mention.start, end: mention.end, text: mention.text },
      });
    }
    this.reportUnresolved(missing);
    return files;
  }

  /**
   * Remote mode: the server's filesystem is not this machine's. Relative references are
   * resolved lexically against the session's project directory on the server (posix vs
   * windows semantics) and verified through the server's file search; unverifiable references
   * are reported and omitted instead of being sent as unreadable local paths.
   */
  private async resolveRemoteFiles(
    text: string,
    directory: string,
    serverID: string = this.activeServerID(),
    exclude?: ReadonlySet<number>,
  ): Promise<PromptFile[]> {
    const backend = this.backendFor(serverID);
    const shape = serverPathShape(directory);
    const files: PromptFile[] = [];
    const missing: string[] = [];
    for (const mention of findFileMentions(text)) {
      if (exclude?.has(mention.start) === true) continue;
      if (mention.rangeError !== undefined) {
        missing.push(`${mention.text}: ${mention.rangeError}`);
        continue;
      }
      if (isServerAbsolutePath(mention.path) && serverPathShape(mention.path) !== shape) {
        missing.push(mention.text); // e.g. `C:\…` mentioned to a posix server
        continue;
      }
      const serverPath = isServerAbsolutePath(mention.path)
        ? mention.path
        : joinServerPath(directory, mention.path);
      const relative = relativeServerPath(directory, serverPath);
      if (relative === undefined) {
        missing.push(mention.text); // outside the project directory; cannot verify
        continue;
      }
      let matched: string | undefined;
      try {
        // Exact path verified against the server's fuzzy search over the project; the base
        // name as query guarantees the entry appears in the hits when it exists. Try files
        // first, then directories so `@src` can attach a folder when no file matches.
        const query = baseServerPath(relative);
        const fileHits = await backend.findProjectFiles(directory, query, 100);
        matched = fileHits.find((hit) => normalizeServerPath(hit, shape) === relative);
        if (matched === undefined) {
          const dirHits = await backend.findProjectDirectories(directory, query, 100);
          matched = dirHits.find((hit) => normalizeServerPath(hit, shape) === relative);
        }
      } catch {
        matched = undefined;
      }
      if (matched === undefined) {
        missing.push(mention.text);
        continue;
      }
      // Use the server's own spelling so case/separator differences do not leak into the URI.
      const canonical = isServerAbsolutePath(matched)
        ? matched
        : joinServerPath(directory, matched);
      files.push({
        uri: withLineRange(serverFileUri(canonical), mention.range),
        name: mention.path,
        mention: { start: mention.start, end: mention.end, text: mention.text },
      });
    }
    this.reportUnresolved(missing, true);
    return files;
  }

  private reportUnresolved(missing: readonly string[], remote = false): void {
    if (missing.length === 0) return;
    const where = remote ? ' on the server' : '';
    this.showNotice(
      `Could not resolve${where}: ${missing.join(', ')}. The reference was not sent.`,
      'warn',
    );
  }

  /** Creates a session in `project`, sends the first prompt, then attaches. */
  async createSessionWithPrompt(
    project: ProjectRef,
    text: string | undefined,
  ): Promise<string | undefined> {
    const agent = this.state.overview.agent;
    const model = this.state.overview.model;
    const { serverID, directory } = project;
    // Submission envelope, captured before any route or draft change: opening the new
    // session restores its own (empty) draft, so reading the composer back afterwards
    // silently dropped the user's prompt and attachments (issue #77).
    const attachments = [...this.state.attachments];
    // Remember where the user was when the request started: if they navigate away while
    // createSession is in flight, the completion must not steal focus or overwrite the
    // route they are viewing (issue #113).
    const originKey = this.routeKey(this.state.route);
    const originProject = this.currentProject();
    this.setState('admitting', true);
    // Scope agent/model to the target project's catalog before creating: a choice made on
    // another host must not be carried into a session here (issue #108). Wait for the
    // correct scoped catalog and reject stale results after navigation.
    if (!(await this.ensureCatalog(directory, serverID))) {
      this.setState('admitting', false);
      return undefined;
    }
    const scopedAgent =
      agent !== undefined && this.state.agents.some((a) => a.id === agent) ? agent : undefined;
    // A catalog model describes its available variants, not a selected variant:
    // comparing it with sameModel() falsely rejects every explicit #variant.
    // Never replace an explicit choice with a default: that could bill a different provider.
    const scopedModel = model ?? this.state.defaultModel;
    if (
      scopedModel !== undefined &&
      !this.state.models.some(
        (available) =>
          available.enabled &&
          available.providerID === scopedModel.providerID &&
          available.modelID === scopedModel.modelID &&
          (scopedModel.variant === undefined || available.variants.includes(scopedModel.variant)),
      )
    ) {
      this.setState('admitting', false);
      this.showNotice(
        `Model ${formatModelRef(scopedModel)} is unavailable for ${directory} on ${serverID}. No prompt sent.`,
        'error',
      );
      return undefined;
    }
    let session: SessionSummary;
    try {
      session = await this.backendFor(serverID).createSession({
        directory,
        ...(scopedAgent === undefined ? {} : { agent: scopedAgent }),
        ...(scopedModel === undefined ? {} : { model: scopedModel }),
      });
      this.debugLog.write('action', { action: 'create-session', ok: true });
    } catch (error) {
      this.debugLog.write('action', {
        action: 'create-session',
        ok: false,
        errorKind: error instanceof BackendError ? error.kind : 'unknown',
      });
      this.setState('admitting', false);
      this.showNotice(errorText(error), 'error');
      return undefined;
    }
    if (model !== undefined) {
      // V2 resolves a missing model at first prompt. Verify the server actually stored
      // our explicit selection before admitting anything billable. Repair an ignored
      // create-time selection once, and fail closed if it still does not match.
      const backend = this.backendFor(serverID);
      try {
        let confirmed = await backend.getSession(session.id);
        if (confirmed.model === undefined || !sameModel(confirmed.model, model)) {
          await backend.switchModel(session.id, model);
          confirmed = await backend.getSession(session.id);
        }
        if (confirmed.model === undefined || !sameModel(confirmed.model, model)) {
          throw new Error(
            `server reported ${confirmed.model === undefined ? 'no model' : formatModelRef(confirmed.model)}`,
          );
        }
        session = confirmed;
      } catch (error) {
        this.setState('admitting', false);
        this.showNotice(
          `Session ${session.id} created, but model ${formatModelRef(model)} was not confirmed. Prompt not sent: ${errorText(error)}`,
          'error',
        );
        return session.id;
      }
    }
    this.setState('admitting', false);
    const sessionServerID = session.serverID ?? serverID;
    this.setState('sessions', this.keyFor(sessionServerID, session.id), {
      ...session,
      serverID: sessionServerID,
    });
    if (text === undefined) {
      this.openSession(session.id, sessionServerID);
      return session.id;
    }
    const stillOrigin =
      this.routeKey(this.state.route) === originKey &&
      originProject.serverID === project.serverID &&
      originProject.directory === project.directory;
    if (stillOrigin) {
      // Empty the route we are leaving (its draft must not keep a copy of the sent prompt),
      // then restore the envelope into the created session until the server acknowledges it.
      this.clearComposer(text, attachments);
      this.openSession(session.id, sessionServerID);
      this.writeComposer(composerFrom(text));
      this.setState('attachments', [...attachments]);
    }
    const sent = await this.admit(
      { serverID: sessionServerID, sessionID: session.id },
      text,
      directory,
      async () => {
        const { files, agents } = await this.promptFiles(
          text,
          directory,
          attachments,
          sessionServerID,
        );
        if (this.modelDispatchBlocked(sessionServerID, session.id)) return false;
        await this.backendFor(sessionServerID).prompt(session.id, {
          text,
          files,
          ...(agents.length === 0 ? {} : { agents }),
        });
        return true;
      },
      undefined,
      attachments,
    );
    if (!sent) {
      // Prompt delivery failed or was ambiguous: park the unsent text and files in the
      // created session's draft so they can be recovered, and report against the new
      // session without touching the route the user is viewing.
      this.stashPromptDraft(sessionServerID, session.id, text, attachments);
      this.showNotice(`Session ${session.id} was created but the prompt was not sent.`, 'error');
    }
    return session.id;
  }

  /** Parks unsent prompt text and attachments in the created session's draft for recovery. */
  private stashPromptDraft(
    serverID: string,
    sessionID: string,
    text: string,
    attachments: readonly Attachment[],
  ): void {
    const key = this.keyFor(serverID, sessionID);
    const draft = this.state.drafts[key] ?? emptyComposer;
    batch(() => {
      this.setState('drafts', key, insertText(draft, text));
      this.setState('draftAttachments', key, [
        ...(this.state.draftAttachments[key] ?? []),
        ...attachments,
      ]);
    });
  }

  /**
   * Directory-targeted search for the most recent session in `directory`. Unlike the
   * overview listing (which only covers the first pages), this pages until the server
   * says everything for that directory is loaded, so --continue works beyond the first
   * 500 global sessions. Archived and child sessions are filtered here; the result is
   * stored in state before attach so directory/model metadata is correct.
   */
  async findLatestSessionIn(directory: string): Promise<SessionSummary | undefined> {
    const key = directoryKey(directory, this.platformFor(this.serverID));
    const directoryQuery = { directory };
    let cursor: string | undefined;
    let pages = 0;
    let best: SessionSummary | undefined;
    try {
      do {
        const page = await this.backend.listSessions(
          cursor === undefined ? directoryQuery : { directory, cursor },
        );
        for (const session of page.sessions) {
          if (session.archived || session.parentID !== undefined) continue;
          if (directoryKey(session.directory, this.platformFor(this.serverID)) !== key) continue;
          if (best === undefined || session.updatedAt > best.updatedAt) best = session;
        }
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== undefined && pages < 50);
    } catch (error) {
      // Directory filtering unsupported by this server (older builds ignored the
      // parameter): pages already handled by the overview load are the best effort fallback.
      if (best === undefined) {
        this.debugLog.write('find-latest-fallback', { error: errorText(error) });
        return this.latestSessionInState(directory);
      }
    }
    if (best !== undefined) this.storeSessionSummary(best);
    return best;
  }

  /** Fallback used only when the server cannot filter by directory: match loaded pages. */
  private latestSessionInState(directory: string): SessionSummary | undefined {
    const key = directoryKey(directory, this.platformFor(this.serverID));
    return Object.values(this.state.sessions)
      .filter(
        (session) =>
          !session.archived &&
          session.parentID === undefined &&
          directoryKey(session.directory, this.platformFor(this.serverID)) === key,
      )
      .toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
  }

  /** Stores a fetched/resolved summary before it is attached or prompted. */
  private storeSessionSummary(session: SessionSummary): void {
    const serverID = session.serverID ?? this.serverID;
    const key = this.keyFor(serverID, session.id);
    this.setState('sessions', key, this.withConfirmedModel(key, { ...session, serverID }));
  }

  /**
   * Makes sure a session the user asked for (e.g. --resume <id>) is known before we
   * open or prompt it. Returns the summary, or undefined when the server cannot find it.
   */
  async ensureSession(
    sessionID: string,
    active = this.activeServerID(),
  ): Promise<SessionSummary | undefined> {
    // The session may belong to any registered host, not just the one the route currently
    // shows: qualify by session ID across every server before picking a backend.
    for (const serverID of [active, ...this.serverIDs().filter((id) => id !== active)]) {
      const known = this.state.sessions[this.keyFor(serverID, sessionID)];
      if (known !== undefined) {
        try {
          await this.refreshSummary(sessionID, serverID);
          return this.state.sessions[this.keyFor(serverID, sessionID)] ?? known;
        } catch {
          return known;
        }
      }
    }
    try {
      const session = {
        ...(await this.backendFor(active).getSession(sessionID)),
        serverID: active,
      };
      this.storeSessionSummary(session);
      return session;
    } catch (error) {
      if (error instanceof BackendError && error.kind === 'not-found') return undefined;
      throw error;
    }
  }

  async sendToSession(sessionID: string, text: string): Promise<boolean> {
    const route = this.state.route;
    const composer = this.state.composer;
    const originServerID = this.activeServerID();
    const sentAttachments = [...this.state.attachments];
    const session = await this.ensureSession(sessionID, originServerID);
    const serverID = session?.serverID ?? originServerID;
    const activeKey = this.keyFor(serverID, sessionID);
    const directory = session?.directory ?? this.deps.cwd;
    if (this.state.route === route && this.state.composer === composer) {
      this.writeComposer(composerFrom(text));
    }
    const running = this.state.running[activeKey] === true;
    return this.admit(
      { serverID, sessionID },
      text,
      directory,
      async () => {
        const { files, agents } = await this.promptFiles(
          text,
          directory,
          sentAttachments,
          serverID,
        );
        if (this.modelDispatchBlocked(serverID, sessionID)) return false;
        await this.backendFor(serverID).prompt(sessionID, {
          text,
          files,
          ...(agents.length === 0 ? {} : { agents }),
          ...(running ? { delivery: this.deps.config.input.enterWhileRunning } : {}),
        });
        return true;
      },
      undefined,
      sentAttachments,
    );
  }

  // ---------------------------------------------------------------- local commands

  private async runLocalCommand(name: LocalCommandName, args: string): Promise<void> {
    switch (name) {
      case 'sessions':
      case 'bg':
      case 'resume':
        this.openOverview();
        return;
      case 'new':
        this.startNewSession(this.currentDirectory(), this.currentProject().serverID);
        return;
      case 'agent':
        if (args === '') await this.cycleAgent(1);
        else await this.setAgent(args);
        return;
      case 'model':
        if (args === '') await this.openModelPicker();
        else await this.setModelFromRef(args);
        return;
      case 'effort':
        await this.setEffort(args);
        return;
      case 'diff':
        await this.openDiff(args.trim() === 'turn' ? 'turn' : 'session');
        return;
      case 'transcript':
        this.toggleDetails();
        return;
      case 'usage':
        this.setOverlay({ kind: 'usage' });
        return;
      case 'btw':
        this.showNotice(
          'Side questions (/btw) are desktop-only; the OpenCode HTTP API has no equivalent endpoint. Nothing was sent.',
          'warn',
        );
        return;
      case 'status':
        this.setOverlay({ kind: 'status' });
        return;
      case 'queue':
        this.setOverlay({ kind: 'queue', index: 0 });
        return;
      case 'export':
        await this.exportChat(args);
        return;
      case 'compact':
        await this.compactCommand(args);
        return;
      case 'criteria':
        await this.changeGoal(
          (doc) => setAcceptance(doc, parseSteps(args), this.isoNow()),
          'Criteria saved',
        );
        return;
      case 'plan':
        await this.planCommand(args);
        return;
      case 'rename':
        await this.renameCurrent(args);
        return;
      case 'fork':
        await this.forkCurrent();
        return;
      case 'revert':
        await this.stageRevert();
        return;
      case 'keys':
      case 'help':
        this.setOverlay({ kind: 'help' });
        return;
      case 'interrupt':
        await this.interrupt();
        return;
      case 'steer':
        if (args === '') {
          this.showNotice('Usage: /steer <text>', 'warn');
          return;
        }
        this.writeComposer(composerFrom(args));
        await this.steer();
        return;
      case 'quit':
        this.deps.requestExit();
        return;
      case 'pair':
        await this.pairCommand(args);
        return;
      case 'servers':
        await this.serversCommand(args);
        return;
      case 'unpair':
        await this.unpairCommand(args);
        return;
      case 'server':
        return; // parsed into a server command before reaching here
      default:
        return;
    }
  }

  /**
   * `/pair` is frontend-local: it never enters the agent inbox and never interrupts a
   * running turn. Codes and tokens are redacted from every message this method emits.
   */
  private async pairCommand(args: string): Promise<void> {
    let request: PairRequest;
    try {
      request = parsePairArgs(args);
    } catch (error) {
      this.showNotice(
        error instanceof PairingError ? error.message : 'Invalid /pair arguments.',
        'warn',
      );
      return;
    }
    if (this.deps.pair === undefined) {
      this.showNotice('Pairing is not available in this build.', 'warn');
      return;
    }
    this.showNotice(`Pairing ${request.baseUrl}…`, 'dim');
    try {
      const result = await this.deps.pair(request);
      this.showNotice(`Paired ${result.shortname}.`, 'dim');
    } catch (error) {
      this.showNotice(redactPairingCode(errorText(error), request.code), 'error');
    }
  }

  /** Rows for the `/servers` overlay; secrets are never part of a listing. */
  serverList(): readonly ServerListing[] {
    return (
      this.deps.serverAdmin?.list() ?? [
        {
          serverID: this.serverID,
          label: this.serverID === localServerID ? 'local' : this.serverID,
          baseUrl: this.backend.baseUrl,
          state: this.state.stream === 'live' ? 'online' : 'connecting',
          active: true,
        },
      ]
    );
  }

  private async serversCommand(args: string): Promise<void> {
    const admin = this.deps.serverAdmin;
    if (admin === undefined) {
      this.showNotice('Server management is not available in this build.', 'warn');
      return;
    }
    const tokens = args.split(/\s+/).filter((token) => token !== '');
    if (tokens[0] !== 'rename') {
      this.setOverlay({ kind: 'servers', index: 0 });
      return;
    }
    const from = tokens[1];
    const to = tokens[2];
    if (from === undefined || to === undefined || tokens.length > 3) {
      this.showNotice('Usage: /servers rename <old> <new>', 'warn');
      return;
    }
    const target = this.findServer(from);
    if (target === undefined) {
      this.showNotice(`Unknown server "${from}".`, 'warn');
      return;
    }
    try {
      await admin.rename(target.serverID, to);
      this.showNotice(`Renamed ${target.label} to ${to}.`, 'dim');
    } catch (error) {
      this.showNotice(errorText(error), 'error');
    }
  }

  private async unpairCommand(args: string): Promise<void> {
    const admin = this.deps.serverAdmin;
    if (admin === undefined) {
      this.showNotice('Server management is not available in this build.', 'warn');
      return;
    }
    const name = args.split(/\s+/).find((token) => token !== '');
    if (name === undefined) {
      this.showNotice('Usage: /unpair <name>', 'warn');
      return;
    }
    const target = this.findServer(name);
    if (target === undefined) {
      this.showNotice(`Unknown server "${name}".`, 'warn');
      return;
    }
    // Reject unpairing the launch/active server or the local service;
    // these are immutable backend assumptions and removing them would break
    // the controller's state and subsequent loads/interactions.
    if (target.serverID === this.serverID) {
      this.showNotice(
        'Cannot unpair the launch/server you are currently connected to. ' +
          'Switch to another host or restart margarita without it first.',
        'error',
      );
      return;
    }
    await this.performUnpair(target);
  }

  /** Confirms the `unpair-confirm` overlay. */
  async confirmUnpair(): Promise<void> {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'unpair-confirm') return;
    const target = this.findServer(overlay.serverID);
    this.setOverlay({ kind: 'none' });
    await this.performUnpair(
      target ?? {
        serverID: overlay.serverID,
        label: overlay.label,
        baseUrl: '',
        state: 'offline',
        active: overlay.serverID === this.serverID,
      },
    );
  }

  private findServer(name: string): ServerListing | undefined {
    const needle = name.toLowerCase();
    return this.serverList().find(
      (server) =>
        server.serverID === name ||
        server.label.toLowerCase() === needle ||
        server.serverID.toLowerCase() === needle,
    );
  }

  private async performUnpair(target: ServerListing): Promise<void> {
    const admin = this.deps.serverAdmin;
    if (admin === undefined) return;
    const wasActive = target.serverID === this.serverID;
    if (wasActive) {
      this.saveDraft();
      this.openOverview();
    }
    try {
      await admin.unpair(target.serverID);
    } catch (error) {
      this.showNotice(errorText(error), 'error');
      // If unpair itself failed, do not attempt further cleanup that would be
      // based on a now-absent admin state.
      return;
    }
    // Forget all cached frontend records bound to this server so no route,
    // in-flight request, stream, or overview selection remains attached to
    // a removed host.
    this.forgetServer(target.serverID);
    this.showNotice(
      `Unpaired ${target.label}. Remote sessions keep running; this only removed local access.`,
      'dim',
    );
  }

  /** True when a key belongs to `serverID`'s qualified namespace (expansion keys). */
  private ownsKey(key: string, serverID: string): boolean {
    return serverID === localServerID
      ? !key.startsWith('server:')
      : key.startsWith(`server:${encodeURIComponent(serverID)}/session:`);
  }

  /** Drops every cached frontend record for one server without touching other servers. */
  private forgetServer(serverID: string): void {
    this.setState(
      produce((state) => {
        delete state.mcpCatalogs[serverID];
        for (const [key, summary] of Object.entries(state.sessions)) {
          if (summary.serverID === serverID) delete state.sessions[key];
        }
        for (const key of Object.keys(state.transcripts)) {
          if (parseSessionKey(key).serverID === serverID) delete state.transcripts[key];
        }
        for (const map of [
          state.inbox,
          state.permissions,
          state.forms,
          state.goals,
          state.nativeGoals,
          state.awaitingSteer,
          state.running,
          state.openedAt,
          state.drafts,
          state.draftAttachments,
          state.transcriptWindow,
        ]) {
          for (const key of Object.keys(map)) {
            if (parseSessionKey(key).serverID === serverID) delete map[key];
          }
        }
        // Qualified expansion entries are `<server-qualified session key> <node key>`; match
        // them by the session-key prefix of this host only.
        for (const map of [state.expandedGroups, state.expandedDiffs]) {
          for (const key of Object.keys(map)) {
            if (this.ownsKey(key, serverID)) delete map[key];
          }
        }
      }),
    );
    if (this.state.overview.selectedRow?.includes(sessionKey({ serverID, sessionID: '' }))) {
      this.setState('overview', 'selectedRow', undefined);
    }
  }

  // ---------------------------------------------------------------- agents & models

  async cycleAgent(direction: 1 | -1): Promise<void> {
    if (!(await this.ensureCatalog(this.currentDirectory()))) return;
    const session = this.currentSession();
    const current = session === undefined ? this.state.overview.agent : session.agent;
    const next = nextAgent(this.state.agents, current, direction);
    if (next === undefined) {
      this.showNotice('No selectable agents on this server.', 'warn');
      return;
    }
    await this.setAgent(next.id);
  }

  private async setAgent(agentID: string): Promise<void> {
    if (!this.state.agents.some((agent) => agent.id === agentID)) {
      this.showNotice(`Agent "${agentID}" is not selectable.`, 'warn');
      return;
    }
    const session = this.currentSession();
    if (session === undefined) {
      this.setState('overview', 'agent', agentID);
      return;
    }
    // Optimistic footer update, confirmed by the summary refetch.
    this.setState('sessions', this.keyFor(session.serverID, session.id), {
      ...session,
      agent: agentID,
    });
    try {
      await this.backend.switchAgent(session.id, agentID);
      if (this.state.running[this.keyFor(session.serverID, session.id)] === true)
        this.showNotice(`Agent: ${agentID} (next turn)`, 'dim');
    } catch (error) {
      this.showNotice(errorText(error), 'error');
    }
    await this.refreshSummary(session.id);
  }

  async openModelPicker(): Promise<void> {
    if (!(await this.ensureCurrentModelCatalog())) return;
    this.setOverlay({ kind: 'model-picker', query: '', index: 0 });
  }

  /** Picker rows: every enabled model plus each of its variants. */
  modelChoices(query: string): ModelSelection[] {
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token !== '');
    const choices: ModelSelection[] = [];
    for (const model of this.state.models) {
      if (!model.enabled) continue;
      const haystack = `${model.providerID}/${model.modelID} ${model.name}`.toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) continue;
      choices.push({ providerID: model.providerID, modelID: model.modelID });
      for (const variant of model.variants) {
        choices.push({ providerID: model.providerID, modelID: model.modelID, variant });
      }
    }
    return choices;
  }

  setModelPickerQuery(query: string): void {
    this.setState('overlay', { kind: 'model-picker', query, index: 0 });
  }

  moveModelPicker(direction: -1 | 1): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'model-picker') return;
    const count = this.modelChoices(overlay.query).length;
    if (count === 0) return;
    this.setState('overlay', { ...overlay, index: (overlay.index + direction + count) % count });
  }

  async acceptModelPicker(): Promise<void> {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'model-picker') return;
    const choice = this.modelChoices(overlay.query)[overlay.index];
    this.setOverlay({ kind: 'none' });
    if (choice !== undefined) await this.setModel(choice);
  }

  private async setModelFromRef(ref: string): Promise<void> {
    if (!(await this.ensureCurrentModelCatalog())) return;
    const resolved = resolveModel({ model: ref }, this.state.models);
    if (resolved.kind === 'error') {
      this.showNotice(resolved.message, 'warn');
      return;
    }
    if (resolved.kind === 'resolved') await this.setModel(resolved.model);
  }

  private async setEffort(variant: string): Promise<void> {
    if (!(await this.ensureCurrentModelCatalog())) return;
    const current =
      this.currentSession()?.model ?? this.state.overview.model ?? this.state.defaultModel;
    if (current === undefined) {
      this.showNotice('No model selected.', 'warn');
      return;
    }
    const catalog = this.state.models.find(
      (model) => model.providerID === current.providerID && model.modelID === current.modelID,
    );
    if (variant === '') {
      this.showNotice(`Variants: ${catalog?.variants.join(', ') || 'none'}`, 'dim');
      return;
    }
    if (catalog === undefined || !catalog.variants.includes(variant)) {
      this.showNotice(
        `No variant "${variant}". Available: ${catalog?.variants.join(', ') || 'none'}.`,
        'warn',
      );
      return;
    }
    await this.setModel({ providerID: current.providerID, modelID: current.modelID, variant });
  }

  private async ensureCurrentModelCatalog(): Promise<boolean> {
    const route = this.state.route;
    const directory = this.currentDirectory();
    const serverID = this.activeServerID();
    return (
      (await this.ensureCatalog(directory, serverID)) &&
      this.routeKey(this.state.route) === this.routeKey(route) &&
      this.currentDirectory() === directory &&
      this.activeServerID() === serverID
    );
  }

  async setModel(model: ModelSelection): Promise<void> {
    this.rememberModel(model);
    const session = this.currentSession();
    if (session === undefined) {
      this.setState('overview', 'model', model);
      return;
    }
    await this.switchSessionModel(session, model);
  }

  private modelDispatchBlocked(serverID: string, sessionID: string): boolean {
    const key = this.keyFor(serverID, sessionID);
    if (this.modelSwitches.has(key)) {
      this.showNotice(
        'Model selection pending. Send again once the server confirms it.',
        'dim',
        false,
      );
      return true;
    }
    if (this.failedModelSwitches.has(key)) {
      this.showNotice(
        'Model selection is unconfirmed. Select a model again before sending.',
        'error',
        false,
      );
      return true;
    }
    return false;
  }

  private withConfirmedModel(key: string, session: SessionSummary): SessionSummary {
    if (!this.modelSwitches.has(key) && !this.failedModelSwitches.has(key)) return session;
    const { model: _unconfirmed, ...rest } = session;
    const model = this.state.sessions[key]?.model;
    return model === undefined ? rest : { ...rest, model };
  }

  private async switchSessionModel(
    session: SessionSummary,
    model: ModelSelection,
  ): Promise<boolean> {
    const key = this.keyFor(session.serverID, session.id);
    const previous = this.modelSwitches.get(key);
    this.modelSwitchRevisions.set(key, (this.modelSwitchRevisions.get(key) ?? 0) + 1);
    this.showNotice(`Confirming ${formatModelRef(model)} with the server…`, 'dim', false);
    const operation = (async (): Promise<boolean> => {
      if (previous !== undefined) await previous;
      try {
        const backend = this.backendFor(session.serverID);
        await backend.switchModel(session.id, model);
        const confirmed = await backend.getSession(session.id);
        if (confirmed.model === undefined || !sameModel(confirmed.model, model)) {
          throw new Error('Server did not confirm the requested model');
        }
        this.setState('sessions', key, { ...confirmed, serverID: session.serverID });
        this.failedModelSwitches.delete(key);
        return true;
      } catch (error) {
        this.failedModelSwitches.add(key);
        this.showNotice(
          `Model selection failed: ${errorText(error)}. Select a model again before sending.`,
          'error',
          false,
        );
        return false;
      }
    })();
    this.modelSwitches.set(key, operation);
    const confirmed = await operation;
    if (this.modelSwitches.get(key) === operation) {
      this.modelSwitches.delete(key);
      this.modelSwitchRevisions.set(key, (this.modelSwitchRevisions.get(key) ?? 0) + 1);
      if (confirmed) this.showNotice(`Model confirmed: ${formatModelRef(model)}`, 'dim');
    }
    return confirmed;
  }

  /** F2: next recently used model still present in the catalog. */
  async nextRecentModel(): Promise<void> {
    if (!(await this.ensureCurrentModelCatalog())) return;
    const current = this.currentSession()?.model ?? this.state.overview.model;
    const available = this.state.recentModels.filter((recent) =>
      this.state.models.some(
        (model) =>
          model.enabled &&
          model.providerID === recent.providerID &&
          model.modelID === recent.modelID &&
          (recent.variant === undefined || model.variants.includes(recent.variant)),
      ),
    );
    if (available.length === 0) {
      this.showNotice('No recent models yet · Alt+P to pick one', 'dim');
      return;
    }
    const index =
      current === undefined ? -1 : available.findIndex((model) => sameModel(model, current));
    const next = available[(index + 1) % available.length];
    if (next !== undefined) await this.setModel(next);
  }

  private rememberModel(model: ModelSelection): void {
    const recent = [
      model,
      ...this.state.recentModels.filter((entry) => !sameModel(entry, model)),
    ].slice(0, this.deps.config.models.recentLimit);
    this.setState('recentModels', recent);
    this.persist({ recentModels: recent });
  }

  // ---------------------------------------------------------------- execution control

  /** Ctrl+C: interrupt via server and report the authoritative result. */
  async interrupt(): Promise<void> {
    const session = this.currentSession();
    if (session === undefined) return;
    try {
      const interrupted = await this.backend.interrupt(session.id);
      this.debugLog.write('action', { action: 'interrupt', ok: interrupted });
      this.showNotice(interrupted ? 'Interrupted' : 'Nothing was running', 'dim');
      if (interrupted) await this.captureInterruptSteerIntent(session.id, session.serverID);
    } catch (error) {
      this.debugLog.write('action', {
        action: 'interrupt',
        ok: false,
        errorKind: error instanceof BackendError ? error.kind : 'unknown',
      });
      this.showNotice(errorText(error), 'error');
    }
  }

  /** Ctrl+B: running tool calls continue in the background; the turn keeps going. */
  async backgroundTools(): Promise<void> {
    const session = this.currentSession();
    if (
      session === undefined ||
      this.state.running[this.keyFor(session.serverID, session.id)] !== true
    ) {
      this.showNotice('Nothing running to background.', 'dim');
      return;
    }
    try {
      await this.backend.backgroundTools(session.id);
      // The confirmation belongs to the tool call, rendered inside the transcript.
      // A global notice would occupy a composer/footer row and shift the prompt bar (#129).
      const running = this.runningToolIDs(session.id, session.serverID);
      this.setState('backgrounded', this.keyFor(session.serverID, session.id), {
        text: running.length > 1 ? 'Running tools moved to background' : 'Moved to background',
        ...(running.at(-1) === undefined ? {} : { toolID: running.at(-1)! }),
      });
    } catch (error) {
      this.showNotice(`Background failed: ${errorText(error)}`, 'error');
    }
  }

  /** IDs still running for a session, used to attach the background status to its tool row. */
  private runningToolIDs(sessionID: string, serverID: string): string[] {
    const messages = this.state.transcripts[this.keyFor(serverID, sessionID)]?.messages ?? [];
    const ids: string[] = [];
    for (const message of messages) {
      if (message.kind !== 'assistant') continue;
      for (const part of message.parts) {
        if (
          part.kind === 'tool' &&
          (part.tool.status === 'running' || part.tool.status === 'streaming')
        ) {
          ids.push(part.tool.id);
        }
      }
    }
    return ids;
  }

  /**
   * Fetches every page of the attached session (not just the cached window) and writes
   * session metadata, messages and the local goal/plan as JSON.
   */
  async exportChat(target: string): Promise<void> {
    const session = this.currentSession();
    if (session === undefined) {
      this.showNotice('Open a session to export it.', 'warn');
      return;
    }
    // Exports are always written to the LOCAL machine. Never derive the output location
    // from session.directory, which is a path on the (possibly remote) server and may use
    // a different OS's syntax (#89). Relative targets resolve against the local cwd;
    // absolute targets are used as-is on the client OS. An absolute target that looks
    // like it belongs to the remote host on a cross-platform launch is refused with a
    // clarifying notice instead of being written to an unexpected local place.
    const nativeShape = this.deps.platform === 'win32' ? 'windows' : 'posix';
    if (
      target !== '' &&
      this.isRemoteServer(session.serverID) &&
      isServerAbsolutePath(target) &&
      serverPathShape(target) !== nativeShape
    ) {
      this.showNotice(
        `Refusing to export to "${target}": that looks like a ${serverPathShape(target)} path on the ` +
          `remote server, but exports are written locally to ${this.deps.cwd}. Use a local path.`,
        'warn',
      );
      return;
    }
    const paths = this.deps.platform === 'win32' ? win32 : posix;
    const fileName = target === '' ? `marg-${session.id}.json` : target;
    const outputPath = paths.resolve(this.deps.cwd, fileName);
    try {
      const pages: TranscriptMessage[][] = [];
      let cursor: string | undefined;
      do {
        const page = await this.backend.listMessages(session.id, exportPageSize, cursor);
        pages.unshift(page.messages);
        cursor = page.olderCursor;
      } while (cursor !== undefined);
      const goal = this.state.goals[this.keyFor(session.serverID, session.id)];
      const log = {
        format: 'margarita.chatlog.v1',
        exportedAt: new Date(this.deps.now()).toISOString(),
        server: this.backend.baseUrl,
        session,
        messages: pages.flat(),
        ...(goal === undefined ? {} : { goal }),
      };
      const write =
        this.deps.writeFile ?? (async (file, text) => void (await Bun.write(file, text)));
      await write(
        outputPath,
        `${JSON.stringify(log, null, 2)}
`,
      );
      this.showNotice(`Exported ${log.messages.length} messages to ${outputPath}`, 'dim');
    } catch (error) {
      this.showNotice(`Export failed: ${errorText(error)}`, 'error');
    }
  }

  /**
   * /compact: asks OpenCode to compact the session via the native v2 endpoint. The reply
   * confirms acceptance, never completion — state comes from session.compaction.* events
   * and the compaction transcript message, never from this call returning.
   */
  private async compactCommand(args: string): Promise<void> {
    const session = this.requireSession();
    if (session === undefined) return;
    if (args !== '') {
      this.showNotice('Usage: /compact', 'warn');
      return;
    }
    // A pending compaction is already in the inbox; requesting again would be a no-op.
    const pending = (this.state.inbox[this.keyFor(session.serverID, session.id)] ?? []).some(
      (item) => item.kind === 'compaction',
    );
    if (pending) {
      this.showNotice('Compaction already pending', 'dim');
      return;
    }
    try {
      await this.backend.compactSession(session.id);
    } catch (error) {
      this.showNotice(`Compaction not requested (connection problem): ${errorText(error)}`, 'warn');
      return;
    }
    this.showNotice('Compaction requested', 'dim');
    await this.refreshInbox(session.id);
  }

  isRunning(): boolean {
    const session = this.currentSession();
    return (
      session !== undefined &&
      this.state.running[this.keyFor(session.serverID, session.id)] === true
    );
  }

  /** Ctrl+C / Ctrl+D on an empty, idle composer: first press arms, second exits. */
  armOrExit(key: string): void {
    if (this.state.exitArmed) {
      this.deps.requestExit();
      return;
    }
    this.setState('exitArmed', true);
    this.showNotice(`Press ${key} again to exit · sessions keep running`, 'dim');
  }

  async cancelQueued(inboxID: string): Promise<void> {
    const view = this.currentView();
    if (view === undefined) return;
    const { serverID, sessionID, key } = view;
    // The item must belong to the session the queue dialog is showing (issue #78); a stale
    // index from another host's queue can never cancel here.
    const item = (this.state.inbox[key] ?? []).find((entry) => entry.id === inboxID);
    if (item === undefined) return;
    try {
      await this.backendFor(serverID).cancelQueued(sessionID, inboxID);
    } catch (error) {
      // The most likely race: the server delivered the item between our listing and the cancel.
      if (
        error instanceof BackendError &&
        (error.kind === 'not-found' || error.kind === 'conflict')
      ) {
        this.showNotice('Already delivered; it could not be cancelled.', 'warn');
      } else {
        this.showNotice(errorText(error), 'error');
      }
      await this.refreshInbox(sessionID, serverID);
      return;
    }
    await this.refreshInbox(sessionID, serverID);
    // Restore the full text into the composer, never into a different session's composer.
    const sameSession =
      this.state.route.kind === 'conversation' &&
      this.state.route.serverID === serverID &&
      this.state.route.sessionID === sessionID;
    if (
      sameSession &&
      this.state.composer.text === '' &&
      this.state.attachments.length === 0 &&
      this.state.completion === undefined
    ) {
      this.writeComposer(composerFrom(item.text));
      this.setState('attachments', [...(item.attachments ?? [])]);
      return;
    }
    // Never clobber a draft the user typed during the cancel; park the recalled text instead.
    const stashKey = this.keyFor(serverID, sessionID);
    if (this.state.stashes[stashKey] === undefined) {
      this.setState('stashes', stashKey, {
        composer: composerFrom(item.text),
        attachments: [...(item.attachments ?? [])],
      });
      this.showNotice('Queued message parked · Ctrl+S to restore', 'dim');
      return;
    }
    // Both slots are busy: keep the text in its own recovery entry, never lost.
    this.setState('recovered', (list) => [
      ...list,
      {
        serverID,
        sessionID,
        inboxID,
        text: item.text,
        ...(item.attachments === undefined ? {} : { attachments: [...item.attachments] }),
      },
    ]);
    this.showNotice(
      'Queued message cancelled and kept aside · clear the composer, then Ctrl+S to restore',
      'warn',
    );
  }

  /**
   * Up on an empty composer recalls the newest pending queued user message into the editor so
   * it can be edited and resent. The fast path is cancellation + restore; until the server
   * acknowledges, nothing has been changed. When the session is no longer you (switched or
   * parked elsewhere), the text parks into the paste/stash draft rather than another session's
   * composer.
   */
  async recallQueuedUp(): Promise<void> {
    if (this.state.route.kind !== 'conversation') {
      this.historyUp();
      return;
    }
    const routeServerID = this.state.route.serverID;
    const sessionID = this.state.route.sessionID;
    const items = this.state.inbox[this.keyFor(routeServerID, sessionID)] ?? [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.kind === 'user') {
        await this.cancelQueued(item.id);
        return;
      }
    }
    this.historyUp();
  }

  async promoteQueued(inboxID: string): Promise<void> {
    const view = this.currentView();
    if (view === undefined) return;
    const { serverID, sessionID, key } = view;
    // Steer only the item the shown session actually owns (#78).
    if (!(this.state.inbox[key] ?? []).some((entry) => entry.id === inboxID)) return;
    try {
      await this.backendFor(serverID).changeDelivery(sessionID, inboxID, 'steer');
    } catch (error) {
      this.showNotice(errorText(error), 'error');
      await this.refreshInbox(sessionID, serverID);
      return;
    }
    await this.refreshInbox(sessionID, serverID);
    await this.maybeResumeInterruptedGoal(sessionID, serverID);
  }

  /**
   * F6 (or Ctrl+Enter where the terminal reports modified Enter) on an empty composer sends now the next pending queued user message (FIFO):
   * the same promote mechanism, offered positionally as the send-now hint above the active
   * task. With no queued follow-up it falls back to steering whatever the empty composer
   * would have meant before.
   */
  async promoteNextQueued(): Promise<void> {
    if (this.state.route.kind !== 'conversation') {
      await this.steer();
      return;
    }
    const routeServerID = this.state.route.serverID;
    const sessionID = this.state.route.sessionID;
    const next = nextQueuedUser(this.state.inbox[this.keyFor(routeServerID, sessionID)] ?? []);
    if (next === undefined) {
      await this.steer();
      return;
    }
    await this.promoteQueued(next.id);
  }

  // ---------------------------------------------------------------- native goal

  /**
   * Per-session version guard for opencode.goal/get: a newer read or a goal-changed push
   * for the same session supersedes an in-flight read; other sessions never interfere.
   */
  private goalVersions = new Map<string, number>();

  private bumpGoalVersion(sessionID: string, serverID: string = this.activeServerID()): number {
    const key = this.keyFor(serverID, sessionID);
    const next = (this.goalVersions.get(key) ?? 0) + 1;
    this.goalVersions.set(key, next);
    return next;
  }

  /**
   * Native OpenCode goal for a session, re-read from the plugin. A confirmed `null` means
   * "no goal"; any failure is `unavailable` and keeps the last verified reading, marked
   * stale. The last known value is never presented as authoritative after a failure.
   */
  async refreshNativeGoal(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): Promise<NativeGoal | null> {
    const version = this.bumpGoalVersion(sessionID, serverID);
    const key = this.keyFor(serverID, sessionID);
    const directory = this.state.sessions[key]?.directory;
    const previous = this.state.nativeGoals[key];
    // Only show a spinner from a genuine unknown; a known reading stays on screen while the
    // refresh runs, so a routine re-read never blinks the badge away.
    if (previous === undefined || previous.status === 'unknown') {
      this.setNativeGoalState(sessionID, { status: 'loading' }, serverID);
    }
    try {
      const goal = await this.backendFor(serverID).getGoal(sessionID, directory);
      if (version !== this.goalVersions.get(key)) return this.nativeGoalOf(sessionID, serverID);
      this.setNativeGoalState(
        sessionID,
        goal === null ? { status: 'none' } : { status: 'verified', goal },
        serverID,
      );
      return goal;
    } catch (error) {
      const kind = error instanceof BackendError ? error.kind : 'unknown';
      this.debugLog.write('backend-error', { operation: 'opencode.goal.get', kind });
      if (version !== this.goalVersions.get(key)) return this.nativeGoalOf(sessionID, serverID);
      const last = this.lastVerifiedGoal(sessionID, serverID);
      this.setNativeGoalState(
        sessionID,
        {
          status: 'unavailable',
          reason: goalFailureReason(kind),
          message: errorText(error),
          sessionID,
          ...(directory === undefined ? {} : { directory }),
          ...(last === undefined ? {} : { last }),
        },
        serverID,
      );
      return this.nativeGoalOf(sessionID, serverID);
    }
  }

  /**
   * Replaces the whole reading. A path setter would merge into the previous state and
   * leave fields from another status (a stale `goal`, or an old failure) behind.
   */
  private setNativeGoalState(
    sessionID: string,
    goal: NativeGoalState,
    serverID: string = this.activeServerID(),
  ): void {
    this.setState(
      'nativeGoals',
      produce((goals) => {
        goals[this.keyFor(serverID, sessionID)] = goal;
      }),
    );
  }

  /** The last goal the plugin actually returned, if that reading still exists. */
  private lastVerifiedGoal(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): NativeGoal | undefined {
    const current = this.state.nativeGoals[this.keyFor(serverID, sessionID)];
    if (current?.status === 'verified') return current.goal;
    if (current?.status === 'unavailable') return current.last;
    return undefined;
  }

  /** The goal currently believed to exist. A stale reading is never used for actions. */
  nativeGoalOf(sessionID: string, serverID: string = this.activeServerID()): NativeGoal | null {
    return verifiedGoal(this.state.nativeGoals[this.keyFor(serverID, sessionID)]);
  }

  /** Full goal knowledge for a session, including stale/unavailable readings (for display). */
  nativeGoalStateOf(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): NativeGoalState | undefined {
    return this.state.nativeGoals[this.keyFor(serverID, sessionID)];
  }

  private clearSteerIntent(sessionID: string, serverID: string = this.activeServerID()): void {
    this.setState(
      produce((state) => {
        delete state.awaitingSteer[this.keyFor(serverID, sessionID)];
      }),
    );
  }

  /**
   * Esc interrupts the execution but must not abandon the goal. The plugin pauses the
   * active goal with reason 'Stopped by the user'; record that as a frontend-only intent
   * so the user's next follow-up reactivates the same goal without /goal resume.
   */
  private async captureInterruptSteerIntent(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): Promise<void> {
    const goal = await this.refreshNativeGoal(sessionID, serverID);
    // The plugin's pause event may not have landed yet, so a still-active goal also
    // qualifies; the resume re-reads and re-checks it before acting.
    const stoppedByUser = goal?.status === 'paused' && goal.reason === stoppedByUserReason;
    if (goal !== null && (stoppedByUser || goal.status === 'active')) {
      this.setState('awaitingSteer', this.keyFor(serverID, sessionID), goal.id);
      return;
    }
    this.clearSteerIntent(sessionID, serverID);
  }

  /**
   * The user's follow-up is already admitted by the time this runs, so its backend call
   * executes after the follow-up prompt; the plugin's resume drives the next continuation
   * from idle instead of racing it. The goal is re-read first: only the same goal, still
   * paused by the interrupt, is resumed, so another client's pause, clear or replacement wins.
   */
  private async maybeResumeInterruptedGoal(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): Promise<void> {
    const intent = this.state.awaitingSteer[this.keyFor(serverID, sessionID)];
    if (intent === undefined) return;
    const goal = await this.refreshNativeGoal(sessionID, serverID);
    this.clearSteerIntent(sessionID, serverID);
    if (goal?.id !== intent || goal.status !== 'paused' || goal.reason !== stoppedByUserReason) {
      return;
    }
    if (this.modelDispatchBlocked(serverID, sessionID)) return;
    try {
      // The goal belongs to this session's host, never to whatever route is active now.
      await this.backendFor(serverID).runCommand(sessionID, 'goal', 'resume');
    } catch (error) {
      this.showNotice(`Could not resume the goal: ${errorText(error)}`, 'error');
    }
    await this.refreshNativeGoal(sessionID, serverID);
  }

  // ---------------------------------------------------------------- permissions

  pendingPermission() {
    const session = this.currentSession();
    if (session === undefined) return undefined;
    return (this.state.permissions[this.keyFor(session.serverID, session.id)] ?? [])[0];
  }

  permissionChoices(): PermissionDecision[] {
    const pending = this.pendingPermission();
    if (pending === undefined) return [];
    return pending.save.length > 0 ? ['once', 'always', 'reject'] : ['once', 'reject'];
  }

  movePermissionChoice(direction: -1 | 1): void {
    const count = this.permissionChoices().length;
    if (count === 0) return;
    this.setState('permissionChoice', (this.state.permissionChoice + direction + count) % count);
  }

  async answerPermission(decision?: PermissionDecision): Promise<void> {
    const session = this.currentSession();
    const pending = this.pendingPermission();
    if (pending === undefined || session === undefined || this.state.answering) return;
    const choice = decision ?? this.permissionChoices()[this.state.permissionChoice] ?? 'reject';
    this.setState('answering', true);
    try {
      // The permission belongs to its owning host, not whatever route is active now.
      await this.backendFor(session.serverID).replyPermission(
        pending.sessionID,
        pending.id,
        choice,
      );
    } catch (error) {
      if (
        error instanceof BackendError &&
        (error.kind === 'not-found' || error.kind === 'conflict')
      ) {
        this.showNotice('Already answered elsewhere.', 'dim');
      } else {
        this.showNotice(errorText(error), 'error');
      }
    }
    // Close only after the server confirms the request is gone.
    try {
      await this.refreshInputRequests(pending.sessionID, session.serverID);
    } finally {
      this.setState('answering', false);
    }
  }

  /** Loads `session.diff` for the attached session into the diff viewer. */
  async openDiff(scope: DiffScope): Promise<void> {
    const session = this.currentSession();
    if (session === undefined) {
      this.showNotice('Open a session to see its changes.', 'warn');
      return;
    }
    const range: DiffRange = {};
    if (scope === 'turn') {
      const from = turnStart(
        this.state.transcripts[this.keyFor(session.serverID, session.id)]?.messages ?? [],
      );
      if (from === undefined) {
        this.showNotice('No turn yet; showing the whole session.', 'dim');
        await this.openDiff('session');
        return;
      }
      Object.assign(range, { from });
    }
    const base: DiffOverlay = {
      kind: 'diff',
      sessionID: session.id,
      scope,
      loading: true,
      files: [],
      index: 0,
      open: false,
      offset: 0,
    };
    this.setState('overlay', base);
    try {
      const files = await this.backend.sessionDiff(session.id, range);
      if (this.isDiffOverlay(session.id, scope)) {
        this.setState('overlay', { ...base, loading: false, files });
      }
    } catch (error) {
      if (this.isDiffOverlay(session.id, scope)) {
        this.setState('overlay', { ...base, loading: false, error: errorText(error) });
      }
    }
  }

  private isDiffOverlay(sessionID: string, scope: DiffScope): boolean {
    const overlay = this.state.overlay;
    return overlay.kind === 'diff' && overlay.sessionID === sessionID && overlay.scope === scope;
  }

  /** List: ↑↓ select, Enter open, t toggles turn/session. Patch: ↑↓/PgUp/PgDn scroll, ← back. */
  diffKey(key: { name: string; text?: string }): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'diff') return;
    const update = (patch: Partial<DiffOverlay>) =>
      this.setState('overlay', { ...overlay, ...patch });
    if (overlay.open) {
      const lines = patchLines(overlay.files[overlay.index]?.patch ?? '').length;
      const clamp = (offset: number) => Math.max(0, Math.min(offset, Math.max(0, lines - 1)));
      if (key.name === 'escape' || key.name === 'left' || key.name === 'q') {
        update({ open: false, offset: 0 });
      } else if (key.name === 'up') update({ offset: clamp(overlay.offset - 1) });
      else if (key.name === 'down') update({ offset: clamp(overlay.offset + 1) });
      else if (key.name === 'pageup') update({ offset: clamp(overlay.offset - diffPageLines) });
      else if (key.name === 'pagedown') update({ offset: clamp(overlay.offset + diffPageLines) });
      return;
    }
    const count = overlay.files.length;
    if (key.name === 'escape' || key.name === 'q') this.closeOverlay();
    else if (key.name === 'up' && count > 0) update({ index: (overlay.index - 1 + count) % count });
    else if (key.name === 'down' && count > 0) update({ index: (overlay.index + 1) % count });
    else if ((key.name === 'return' || key.name === 'right') && count > 0) {
      update({ open: true, offset: 0 });
    } else if (key.text === 't') {
      void this.openDiff(overlay.scope === 'turn' ? 'session' : 'turn');
    }
  }

  /** Oldest pending agent question for the attached session; permissions go first. */
  pendingForm(): FormRequest | undefined {
    const session = this.currentSession();
    if (session === undefined) return undefined;
    return (this.state.forms[this.keyFor(session.serverID, session.id)] ?? [])[0];
  }

  openForm(): void {
    const form = this.pendingForm();
    if (form === undefined) return;
    this.setState('overlay', {
      kind: 'form',
      sessionID: form.sessionID,
      editor: startEditor(form),
    });
  }

  /** The form an open form overlay is editing, if it is still pending. */
  openFormRequest(): FormRequest | undefined {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'form') return undefined;
    return (this.state.forms[this.keyFor(this.activeServerID(), overlay.sessionID)] ?? []).find(
      (form) => form.id === overlay.editor.formID,
    );
  }

  formKey(key: FormKey): void {
    const overlay = this.state.overlay;
    const form = this.openFormRequest();
    if (overlay.kind !== 'form' || form === undefined) {
      this.closeOverlay();
      return;
    }
    const { editor, outcome } = editorKey(form, overlay.editor, key);
    if (outcome === 'close') {
      this.closeOverlay();
      return;
    }
    this.setState('overlay', { kind: 'form', sessionID: overlay.sessionID, editor });
    if (outcome === 'submit') {
      void this.finishForm(form, () =>
        this.backend.replyForm(form.sessionID, form.id, buildAnswer(form, editor.answers)),
      );
    } else if (outcome === 'decline') {
      void this.finishForm(form, () => this.backend.cancelForm(form.sessionID, form.id));
    }
  }

  private async finishForm(form: FormRequest, send: () => Promise<void>): Promise<void> {
    if (this.state.answering) return;
    this.setState('answering', true);
    try {
      await send();
      this.closeOverlay();
    } catch (error) {
      if (
        error instanceof BackendError &&
        (error.kind === 'not-found' || error.kind === 'conflict')
      ) {
        this.closeOverlay();
        this.showNotice('Already answered elsewhere.', 'dim');
      } else {
        this.showNotice(errorText(error), 'error');
      }
    }
    try {
      await this.refreshInputRequests(form.sessionID);
    } finally {
      this.setState('answering', false);
    }
  }

  // ---------------------------------------------------------------- presentation

  toggleDetails(): void {
    this.clearGroupFocus();
    this.setState('detailed', !this.state.detailed);
  }

  /**
   * Expansion state for the attached conversation, re-keyed per render. Expansion entries are
   * stored qualified (`<session key> <node key>`) so two hosts with identical session and
   * tool IDs never share them.
   */
  private expansionPrefix(): string | undefined {
    const route = this.state.route;
    return route.kind === 'conversation'
      ? `${this.keyFor(route.serverID, route.sessionID)} `
      : undefined;
  }

  expandedSets(): { groups: Set<string>; diffs: Set<string> } {
    const prefix = this.expansionPrefix();
    if (prefix === undefined) return { groups: new Set(), diffs: new Set() };
    const strip = (key: string): string => key.slice(prefix.length);
    return {
      groups: new Set(
        Object.keys(this.state.expandedGroups)
          .filter((key) => key.startsWith(prefix))
          .map(strip),
      ),
      diffs: new Set(
        Object.keys(this.state.expandedDiffs)
          .filter((key) => key.startsWith(prefix))
          .map(strip),
      ),
    };
  }

  toggleGroup(key: string): void {
    const prefix = this.expansionPrefix();
    if (prefix === undefined) return;
    const qualified = `${prefix}${key}`;
    this.setState(
      produce((state) => {
        if (state.expandedGroups[qualified] === true) delete state.expandedGroups[qualified];
        else state.expandedGroups[qualified] = true;
      }),
    );
  }

  /** Folded nodes for the attached conversation; empty elsewhere. */
  private conversationNodes(): TranscriptNode[] {
    if (this.state.route.kind !== 'conversation') return [];
    const route = this.state.route;
    const target = route.sessionID;
    const messages = this.state.transcripts[this.keyFor(route.serverID, target)]?.messages ?? [];
    const expanded = this.expandedSets();
    return foldTranscript(messages, {
      detailed: this.state.detailed,
      expandedGroups: expanded.groups,
      expandedDiffs: expanded.diffs,
      mcpServers: this.mcpServersFor(
        route.serverID,
        this.state.sessions[this.keyFor(route.serverID, target)]?.directory ?? '',
      ),
    });
  }

  /** Tool groups in render order; empty outside conversations and in detailed mode. */
  toolGroups(): Extract<TranscriptNode, { kind: 'tool-group' }>[] {
    return this.conversationNodes().filter((node) => node.kind === 'tool-group');
  }

  /**
   * Collapsible transcript items in render order: tool groups and standalone edit
   * tools whose inline diff exceeds the compact preview budget (keys `diff:<toolID>`).
   * Empty in detailed mode, where everything is already shown expanded.
   */
  collapsibleItems(): { key: string; kind: 'group' | 'diff' }[] {
    if (this.state.detailed) return [];
    return this.conversationNodes().flatMap((node): { key: string; kind: 'group' | 'diff' }[] => {
      if (node.kind === 'tool-group') return [{ key: node.key, kind: 'group' as const }];
      if (node.kind === 'tool' && node.tool.status !== 'error' && hasOversizedDiff(node.tool)) {
        return [{ key: `diff:${node.tool.id}`, kind: 'diff' as const }];
      }
      return [];
    });
  }

  /** Ctrl+↑/↓ while reading: move the lightweight selection between collapsible items. */
  moveGroupFocus(direction: -1 | 1): void {
    const items = this.collapsibleItems();
    if (items.length === 0) return;
    const current = this.state.focusedGroup;
    const index = current === undefined ? -1 : items.findIndex((item) => item.key === current);
    const next =
      index === -1
        ? direction === -1
          ? items.length - 1
          : 0
        : Math.min(items.length - 1, Math.max(0, index + direction));
    const item = items[next];
    if (item !== undefined) this.setState('focusedGroup', item.key);
  }

  /** Enter on an empty prompt expands/collapses only the selected item. */
  toggleFocusedGroup(): boolean {
    const key = this.state.focusedGroup;
    if (key === undefined) return false;
    const item = this.collapsibleItems().find((entry) => entry.key === key);
    if (item === undefined) {
      this.setState('focusedGroup', undefined);
      return false;
    }
    if (item.kind === 'diff') this.toggleDiffExpanded(item.key.slice('diff:'.length));
    else this.toggleGroup(item.key);
    return true;
  }

  toggleDiffExpanded(id: string): void {
    const prefix = this.expansionPrefix();
    if (prefix === undefined) return;
    const qualified = `${prefix}${id}`;
    this.setState(
      produce((state) => {
        if (state.expandedDiffs[qualified] === true) delete state.expandedDiffs[qualified];
        else state.expandedDiffs[qualified] = true;
      }),
    );
  }

  clearGroupFocus(): void {
    if (this.state.focusedGroup !== undefined) this.setState('focusedGroup', undefined);
  }

  setOverlay(overlay: Overlay): void {
    this.setState('overlay', overlay);
  }

  closeOverlay(): void {
    this.setState('overlay', { kind: 'none' });
  }

  showNotice(text: string, tone: 'dim' | 'warn' | 'error', autoClear = true): void {
    this.noticeCounter += 1;
    const id = this.noticeCounter;
    this.setState('notice', { text, tone, id });
    if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
    if (autoClear) {
      this.noticeTimer = setTimeout(
        () => {
          if (this.state.notice?.id === id) this.setState('notice', undefined);
        },
        tone === 'error' ? 8000 : 3500,
      );
    }
  }

  clearNotice(): void {
    this.setState('notice', undefined);
  }

  /**
   * Escape handling with contextual priority:
   * - While a run is active and no higher-priority control owns Esc, one Esc interrupts the
   *   owning server and preserves the composer draft.
   * - While idle, a single Esc cancels selection/notice and arms a double-tap window; a
   *   second Esc within the window enters rewind selection (empty composer) or clears the
   *   draft with safe restore (nonempty draft). Repeat Esc never submits or exits.
   */
  handleEscapeKey(): boolean {
    const state = this.state;
    // While a run is active and no higher-priority control owns Esc, one Esc interrupts the
    // owning server; the composer draft is preserved.
    if (this.isRunning()) {
      this.resetEscapeDoubleTap();
      void this.interrupt();
      return true;
    }
    // Idle: a second Esc within the double-tap window triggers rewind/clear.
    const now = this.deps.now();
    if (this.escapeAt !== undefined && now - this.escapeAt <= AppController.ESCAPE_DOUBLE_TAP_MS) {
      this.resetEscapeDoubleTap();
      if (state.composer.text === '') {
        this.enterRewindSelection();
      } else {
        // Clear the draft with a safe restore path: Ctrl+S brings it back.
        this.toggleStash();
      }
      return true;
    }
    // First tap of a potential double-tap: arm the window, then cancel selection/notice.
    this.armEscapeDoubleTap(now);
    this.clearGroupFocus();
    if (state.exitArmed || state.notice !== undefined) this.clearNotice();
    return true;
  }

  private armEscapeDoubleTap(now: number): void {
    this.escapeAt = now;
    this.resetEscapeTimer();
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = undefined;
      this.escapeAt = undefined;
    }, AppController.ESCAPE_DOUBLE_TAP_MS);
  }

  private resetEscapeDoubleTap(): void {
    this.escapeAt = undefined;
    this.resetEscapeTimer();
  }

  private resetEscapeTimer(): void {
    if (this.escapeTimer !== undefined) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = undefined;
    }
  }

  /** Enter rewind selection without mutating files; confirmation is separate work (#102). */
  private enterRewindSelection(): void {
    this.setState('rewindPending', true);
    this.showNotice('Rewind selection — confirm to discard working changes', 'dim');
  }

  currentDirectory(): string {
    return this.currentProject().directory;
  }

  describeModel(model: ModelSelection | undefined): string {
    return model === undefined ? 'server default' : formatModelRef(model);
  }

  // ---------------------------------------------------------------- persistence & supervision

  private persist(patch: Partial<Omit<LocalState, 'schemaVersion'>>): void {
    this.persisted = { ...this.persisted, ...patch };
    const snapshot = this.persisted;
    this.saveChain = this.saveChain.then(async () => {
      try {
        const result = await this.deps.saveLocalState(snapshot);
        const merged = result?.state;
        if (merged !== undefined) {
          // Adopt the post-merge snapshot so later patches build on what is actually on
          // disk. If this process applied a newer patch while the save was in flight,
          // re-merge that patch over the disk state instead of dropping either.
          const latest = this.persisted;
          this.persisted = latest === snapshot ? merged : mergeState(latest, merged);
        }
        if (result?.warning !== undefined) {
          this.showNotice(`Local state warning: ${result.warning}`, 'warn');
        }
      } catch (error) {
        const message = errorText(error);
        this.debugLog.write('backend-error', { operation: 'save', kind: 'unknown' });
        this.saveError = message;
        this.showNotice(`Could not persist local state: ${message}`, 'error');
      }
    });
  }

  /** Every background promise ends here: failures become visible notices, never silence. */
  // ---------------------------------------------------------------- goals & plans

  private isoNow(): string {
    return new Date(this.deps.now()).toISOString();
  }

  goalOf(sessionID: string, serverID: string = this.activeServerID()): GoalPlanV1 | undefined {
    return this.state.goals[this.keyFor(serverID, sessionID)];
  }

  /** The attached session's plan progress, for the footer and overview. */
  planProgress(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): { done: number; total: number } | undefined {
    const plan = this.state.goals[this.keyFor(serverID, sessionID)]?.plan;
    return plan === undefined || plan.tasks.length === 0 ? undefined : progress(plan);
  }

  private async loadGoal(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): Promise<void> {
    try {
      const doc = await this.goalStore.load({ serverID, sessionID });
      if (doc !== undefined) this.setState('goals', this.keyFor(serverID, sessionID), doc);
    } catch (error) {
      this.showNotice(`Goal file unreadable: ${errorText(error)}`, 'warn');
    }
  }

  private requireSession(): SessionSummary | undefined {
    const session = this.currentSession();
    if (session === undefined) this.showNotice('Open a session first.', 'warn');
    return session;
  }

  /**
   * Applies an edit and saves with compare-and-swap. If another process saved first, the
   * same edit is re-applied on top of its version (task IDs keep merges stable), so
   * nothing is silently lost.
   */
  private async changeGoal(
    change: (doc: GoalPlanV1) => GoalPlanV1,
    notice?: string,
    current = this.currentSession(),
  ): Promise<GoalPlanV1 | undefined> {
    if (current === undefined) {
      this.showNotice('Open a session first.', 'warn');
      return undefined;
    }
    const serverID = current.serverID;
    const sessionID = current.id;
    const key = this.keyFor(serverID, sessionID);
    const session = this.state.sessions[key];
    const base =
      this.state.goals[key] ?? emptyGoalPlan(serverID, sessionID, session?.projectID ?? '');
    let saved: GoalPlanV1;
    try {
      saved = await this.goalStore.save(change(base));
    } catch (error) {
      if (!(error instanceof GoalConflictError)) {
        this.showNotice(`Goal not saved: ${errorText(error)}`, 'error');
        return undefined;
      }
      try {
        saved = await this.goalStore.save(change(error.current));
        notice = `${notice ?? 'Saved'} · merged with a change from another window`;
      } catch (retry) {
        this.showNotice(`Goal not saved: ${errorText(retry)}`, 'error');
        return undefined;
      }
    }
    this.setState('goals', key, saved);
    if (notice !== undefined) this.showNotice(notice, 'dim');
    return saved;
  }

  private async planCommand(args: string): Promise<void> {
    const session = this.requireSession();
    if (session === undefined) return;
    const now = this.isoNow();
    switch (args) {
      case '':
        this.setOverlay({ kind: 'tasks', index: 0 });
        return;
      case 'propose': {
        // A visible, ordinary prompt; the reply is only a proposal until adopted.
        const goal = this.state.goals[this.keyFor(session.serverID, session.id)]?.goal?.title;
        const text = `Propose a short numbered plan${goal === undefined ? '' : ` for this goal: ${goal}`}. Reply with the numbered steps only; do not start working yet.`;
        this.writeComposer(composerFrom(text));
        await this.submit();
        this.showNotice('When the reply arrives, /plan adopt to review it.', 'dim');
        return;
      }
      case 'adopt': {
        const steps = parseSteps(this.latestAssistantText(session.id));
        if (steps.length === 0) {
          this.showNotice('No list found in the latest reply.', 'warn');
          return;
        }
        await this.changeGoal(
          (doc) => proposePlan(doc, steps, now),
          'Proposed plan · a accept · r reject',
        );
        this.setOverlay({ kind: 'tasks', index: 0 });
        return;
      }
      case 'accept':
        await this.acceptPlan();
        return;
      case 'reject':
        await this.rejectPlan();
        return;
      case 'clear':
        await this.changeGoal((doc) => {
          const { plan: _plan, proposal: _proposal, ...rest } = doc;
          return rest;
        }, 'Plan cleared');
        return;
      default: {
        const steps = parseSteps(args);
        await this.changeGoal(
          (doc) => setUserPlan(doc, steps, now),
          `Plan saved · ${steps.length} tasks · Ctrl+T`,
        );
      }
    }
  }

  async acceptPlan(current = this.currentSession()): Promise<void> {
    if (
      current === undefined ||
      this.state.goals[this.keyFor(current.serverID, current.id)]?.proposal === undefined
    )
      return;
    await this.changeGoal((doc) => acceptProposal(doc, this.isoNow()), 'Plan accepted', current);
  }

  async rejectPlan(current = this.currentSession()): Promise<void> {
    if (
      current === undefined ||
      this.state.goals[this.keyFor(current.serverID, current.id)]?.proposal === undefined
    )
      return;
    await this.changeGoal(rejectProposal, 'Proposal rejected; plan unchanged', current);
  }

  private latestAssistantText(sessionID: string, serverID: string = this.activeServerID()): string {
    const messages = this.state.transcripts[this.keyFor(serverID, sessionID)]?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.kind !== 'assistant') continue;
      const text = message.parts
        .map((part) => (part.kind === 'text' ? part.text : ''))
        .join('\n')
        .trim();
      if (text !== '') return text;
    }
    return '';
  }

  private latestAssistantID(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): string | undefined {
    const messages = this.state.transcripts[this.keyFor(serverID, sessionID)]?.messages ?? [];
    return messages.findLast((message) => message.kind === 'assistant')?.id;
  }

  tasksSession(): SessionSummary | undefined {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'tasks') return undefined;
    const target = overlay.target;
    return target === undefined
      ? this.currentSession()
      : this.state.sessions[this.keyFor(target.serverID, target.sessionID)];
  }

  openTasks(): void {
    const row = this.state.route.kind === 'overview' ? this.selectedOverviewRow() : undefined;
    if (row?.kind !== 'session') {
      this.setOverlay({ kind: 'tasks', index: 0 });
      return;
    }
    const { id: sessionID, serverID } = row.session;
    this.setOverlay({ kind: 'tasks', index: 0, target: { serverID, sessionID } });
    void this.loadGoal(sessionID, serverID);
    void this.refreshNativeGoal(sessionID, serverID);
  }

  /** Checklist keys: ↑↓ move, Space cycle, b blocked, x cancel, e evidence, a/r proposal. */
  tasksKey(key: { name: string; text?: string }): void {
    const overlay = this.state.overlay;
    const session = this.tasksSession();
    if (key.name === 'escape' || key.name === 'q') {
      this.closeOverlay();
      return;
    }
    if (overlay.kind !== 'tasks' || session === undefined) return;
    const doc = this.state.goals[this.keyFor(session.serverID, session.id)];
    const tasks = (doc?.proposal ?? doc?.plan)?.tasks ?? [];
    const task = tasks[overlay.index];
    const count = tasks.length;
    const now = this.isoNow();
    const set = (state: TaskState) =>
      void this.changeGoal(
        (current) => setTaskState(current, task?.id ?? '', state, now),
        undefined,
        session,
      );
    if (key.name === 'up' && count > 0) {
      this.setOverlay({ ...overlay, index: (overlay.index - 1 + count) % count });
    } else if (key.name === 'down' && count > 0) {
      this.setOverlay({ ...overlay, index: (overlay.index + 1) % count });
    } else if (doc?.proposal !== undefined) {
      if (key.text === 'a') void this.acceptPlan(session);
      else if (key.text === 'r') void this.rejectPlan(session);
    } else if (task === undefined) {
      return;
    } else if (key.name === 'space' || key.text === ' ') set(nextTaskState(task.state));
    else if (key.text === 'b') set(task.state === 'blocked' ? 'todo' : 'blocked');
    else if (key.text === 'x') set(task.state === 'cancelled' ? 'todo' : 'cancelled');
    else if (key.text === 'e') {
      const messageID = this.latestAssistantID(session.id, session.serverID);
      if (messageID === undefined) {
        this.showNotice('No agent message to link yet.', 'warn');
        return;
      }
      void this.changeGoal(
        (current) => addEvidence(current, task.id, { messageID }, now),
        'Linked the latest agent message as evidence',
        session,
      );
    }
  }

  // ---------------------------------------------------------------- rename / fork / revert

  private async renameCurrent(title: string): Promise<void> {
    const session = this.requireSession();
    if (session === undefined) return;
    if (title === '') {
      this.showNotice('Usage: /rename <title>', 'warn');
      return;
    }
    try {
      await this.backend.renameSession(session.id, title);
      // The server's session event carries the authoritative title; reflect it now too.
      this.setState('sessions', this.keyFor(session.serverID, session.id), { ...session, title });
      this.showNotice(`Renamed to ${title}`, 'dim');
    } catch (error) {
      this.showNotice(`Rename failed: ${errorText(error)}`, 'error');
    }
  }

  private async forkCurrent(): Promise<void> {
    const session = this.requireSession();
    if (session === undefined) return;
    try {
      const forked = await this.backend.forkSession(session.id);
      const forkServerID = forked.serverID ?? session.serverID;
      this.setState('sessions', this.keyFor(forkServerID, forked.id), {
        ...forked,
        serverID: forkServerID,
      });
      const doc = this.state.goals[this.keyFor(session.serverID, session.id)];
      if (doc !== undefined) {
        // Copy, never alias: the fork gets its own sidecar file.
        const copy = forkGoalPlan(doc, forked.id);
        this.setState(
          'goals',
          this.keyFor(forkServerID, forked.id),
          await this.goalStore.save(copy).catch(() => copy),
        );
      }
      this.openSession(forked.id, forkServerID);
      this.showNotice('Forked into a new session', 'dim');
    } catch (error) {
      this.showNotice(`Fork failed: ${errorText(error)}`, 'error');
    }
  }

  /**
   * Keeps the revert dialog honest after any summary refresh (attach, events, reconnect):
   * opens the recovery dialog for a server-staged revert this instance has no overlay for,
   * or drops a dialog whose staged revert vanished. A dialog the user is actively
   * confirming/cancelling (`busy`) is left alone.
   *
   * The dialog is bound to its owning host: a revert staged on host B while the user is
   * looking at host A must never hijack A's view (issue #82). A background change only
   * updates B's row; the modal appears when that conversation is actually in the foreground.
   */
  private reconcileStagedRevert(sessionID: string, serverID: string = this.activeServerID()): void {
    const session = this.state.sessions[this.keyFor(serverID, sessionID)];
    const overlay = this.state.overlay;
    const staged = session?.revert;
    if (staged !== undefined) {
      if (overlay.kind === 'revert' && overlay.serverID === serverID) {
        if (overlay.sessionID === sessionID) return;
      }
      if (overlay.kind === 'revert') return; // another conversation's dialog is in front
      // Only the attached (server, session) may open a modal; a detached host at most
      // updates its own cached row, which the overview already reflects.
      const route = this.state.route;
      if (
        route.kind !== 'conversation' ||
        route.serverID !== serverID ||
        route.sessionID !== sessionID
      )
        return;
      this.setOverlay({
        kind: 'revert',
        serverID,
        sessionID,
        messageID: staged.messageID,
        files: staged.files === undefined ? [] : [...staged.files],
        busy: false,
      });
      this.showNotice('A revert was staged on this session. Confirm or cancel it.', 'warn');
      return;
    }
    if (
      overlay.kind === 'revert' &&
      overlay.serverID === serverID &&
      overlay.sessionID === sessionID &&
      !overlay.busy
    ) {
      this.closeOverlay();
      this.showNotice('The staged revert was resolved elsewhere.', 'dim');
    }
  }

  /** Stages a revert to the last user message and asks before committing. */
  private async stageRevert(): Promise<void> {
    const session = this.requireSession();
    if (session === undefined) return;
    const serverID = session.serverID;
    const messageID = turnStart(
      this.state.transcripts[this.keyFor(serverID, session.id)]?.messages ?? [],
    );
    if (messageID === undefined) {
      this.showNotice('Nothing to revert yet.', 'warn');
      return;
    }
    try {
      const files = await this.backendFor(serverID).stageRevert(session.id, messageID);
      // The route may have changed while the RPC was in flight: the dialog belongs to the
      // host whose stage this is, and only that conversation may open it.
      const route = this.state.route;
      if (
        route.kind !== 'conversation' ||
        route.serverID !== serverID ||
        route.sessionID !== session.id
      ) {
        this.showNotice('A revert was staged on this session. Return to it to confirm.', 'warn');
        return;
      }
      this.setOverlay({
        kind: 'revert',
        serverID,
        sessionID: session.id,
        messageID,
        files,
        busy: false,
      });
    } catch (error) {
      this.showNotice(`Revert unavailable: ${errorText(error)}`, 'error');
    }
  }

  /** Enter/y commits the staged revert; Esc/n restores the files. */
  revertKey(key: { name: string; text?: string }): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'revert' || overlay.busy) return;
    // A dialog belongs to one conversation. If the route moved on, no key may act on a
    // stage the user can no longer see; dismissing is the only safe behavior (issue #82).
    const route = this.state.route;
    if (
      route.kind !== 'conversation' ||
      route.serverID !== overlay.serverID ||
      route.sessionID !== overlay.sessionID
    ) {
      this.closeOverlay();
      return;
    }
    const confirm = key.name === 'return' || key.text === 'y';
    const cancel = key.name === 'escape' || key.text === 'n';
    if (!confirm && !cancel) return;
    this.setOverlay({ ...overlay, busy: true });
    // Verify the stage is still the one the dialog was opened for before acting on it.
    void this.verifyAndRunRevert(overlay, confirm).catch((error: unknown) => {
      this.setOverlay({ ...overlay, busy: false });
      this.showNotice(`Revert failed: ${errorText(error)}`, 'error');
    });
  }

  private async verifyAndRunRevert(
    overlay: {
      kind: 'revert';
      serverID: string;
      sessionID: string;
      messageID: string;
      files: FileDiff[];
      busy: boolean;
    },
    confirm: boolean,
  ): Promise<void> {
    // Every call below is bound to the dialog's owning host, never to the current route.
    const backend = this.backendFor(overlay.serverID);
    let summary;
    try {
      summary = await backend.getSession(overlay.sessionID);
    } catch (error) {
      // Can't verify: do not act blindly on the worktree.
      this.setOverlay({ ...overlay, busy: false });
      this.showNotice(
        `Revert not ${confirm ? 'committed' : 'cancelled'}: could not verify the staged revert (${errorText(error)}).`,
        'error',
      );
      return;
    }
    const staged = summary?.revert;
    this.setState(
      'sessions',
      this.keyFor(overlay.serverID, overlay.sessionID),
      reconcile({ ...summary, serverID: overlay.serverID }),
    );
    if (staged?.messageID !== overlay.messageID) {
      // The stage changed or vanished under us (another client committed/cleared it).
      this.closeOverlay();
      this.showNotice(
        'The staged revert changed or was resolved elsewhere. Nothing was applied by this dialog.',
        'warn',
      );
      return;
    }
    try {
      if (confirm) await backend.commitRevert(overlay.sessionID);
      else await backend.clearRevert(overlay.sessionID);
    } catch (error) {
      this.setState('overlay', (current) =>
        current.kind === 'revert' &&
        current.serverID === overlay.serverID &&
        current.sessionID === overlay.sessionID
          ? { ...current, busy: false }
          : current,
      );
      this.showNotice(`Revert failed: ${errorText(error)}`, 'error');
      return;
    }
    this.closeOverlay();
    this.showNotice(confirm ? 'Reverted' : 'Revert cancelled; files restored', 'dim');
    if (confirm)
      void this.track('refresh', this.loadConversation(overlay.sessionID, overlay.serverID));
  }

  /**
   * Best-effort safe clear of a staged revert when the user is exiting: abandoning the
   * dialog means restoring the files, never leaving the mutation silently staged.
   * The clear targets the dialog's owning host, not whatever route is selected now.
   * Returns an error message if the clear failed (caller should surface it).
   */
  async flushRevertOnExit(): Promise<string | undefined> {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'revert') return undefined;
    if (overlay.busy) {
      // An action is in flight; the server will end up consistent either way.
      return undefined;
    }
    try {
      await this.backendFor(overlay.serverID).clearRevert(overlay.sessionID);
      this.setOverlay({ kind: 'none' });
      return undefined;
    } catch (error) {
      return errorText(error);
    }
  }

  private async track(label: string, work: Promise<unknown>): Promise<void> {
    try {
      await work;
    } catch (error) {
      this.debugLog.write('backend-error', {
        operation: label,
        kind: error instanceof BackendError ? error.kind : 'unknown',
      });
      if (this.disposed) return;
      this.showNotice(`${label}: ${errorText(error)}`, 'error');
    }
  }
}

/**
 * Merges a fresh newest-first page into the cached transcript: cached messages older
 * than the page are kept, everything the page covers is replaced by server data.
 */
export function mergeLatest(
  cached: readonly TranscriptMessage[],
  page: readonly TranscriptMessage[],
): TranscriptMessage[] {
  const first = page[0];
  if (first === undefined) return [...cached];
  const pageIDs = new Set(page.map((message) => message.id));
  const boundary = cached.findIndex((message) => message.id === first.id);
  const older =
    boundary === -1
      ? cached.filter((message) => !pageIDs.has(message.id) && message.createdAt < first.createdAt)
      : cached.slice(0, boundary);
  return [...older, ...page];
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Strict UTF-8 decode for a paste; undefined means the bytes are not text. */
function decodePastedText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n');
  } catch {
    return undefined;
  }
}

/** Maps a normalized backend failure onto why a goal read is inconclusive. */
function goalFailureReason(kind: BackendError['kind']): GoalQueryFailure {
  switch (kind) {
    case 'not-found':
    case 'invalid':
      // No goal plugin, or a plugin without the `get` RPC method.
      return 'unsupported';
    case 'unauthorized':
      return 'unauthorized';
    case 'transport':
      return 'transport';
    default:
      return 'unknown';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
