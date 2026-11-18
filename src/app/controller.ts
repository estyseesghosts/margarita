import { isAbsolute, resolve } from 'node:path';
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
} from '../adapter/backend.ts';
import type { StreamStatus } from '../adapter/event-pump.ts';
import type { AppConfig } from '../config/config.ts';
import { GoalConflictError, type GoalStore, memoryGoalStore } from '../config/goal-store.ts';
import type { LocalState, SaveResult } from '../config/local-state.ts';
import { mergeState } from '../config/local-state.ts';
import { defaultAgent, nextAgent, selectableAgents } from '../domain/agent-cycle.ts';
import type { BackendEvent } from '../domain/backend-event.ts';
import { type Composer, composerFrom, emptyComposer, insertText } from '../domain/composer.ts';
import { type DiffScope, type FileDiff, patchLines, turnStart } from '../domain/diff.ts';
import { hasOversizedDiff } from '../domain/edit-diff.ts';
import { projectExecution } from '../domain/execution.ts';
import { activeMention, findFileMentions, rankPaths } from '../domain/file-reference.ts';
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
  instructionKey,
  instructionText,
  nextTaskState,
  parseSteps,
  progress,
  proposePlan,
  rejectProposal,
  setAcceptance,
  setGoal,
  setSync,
  setTaskState,
  setUserPlan,
  type TaskState,
} from '../domain/goal-plan.ts';
import { formatModelRef, type ModelSelection, sameModel } from '../domain/model-ref.ts';
import { resolveModel } from '../domain/model-resolution.ts';
import {
  groupRows,
  groupSessions,
  loadMoreRowKey,
  type OverviewRow,
  type ProjectGroup,
} from '../domain/overview-groups.ts';
import { directoryKey } from '../domain/path-identity.ts';
import {
  historyBack,
  historyForward,
  recordEntry,
  searchHistory,
} from '../domain/prompt-history.ts';
import {
  baseServerPath,
  isServerAbsolutePath,
  joinServerPath,
  normalizeServerPath,
  relativeServerPath,
  serverFileUri,
  serverPathShape,
} from '../domain/server-path.ts';
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

export type ControllerDeps = Readonly<{
  backend: Backend;
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
  /** Opt-in diagnostics sink (--debug-log); defaults to a silent no-op. */
  debugLog?: DebugLog;
}>;

const transcriptPageSize = 120;
const transcriptCacheLimit = 8;
const sessionPageLimit = 5;
const exportPageSize = 500;
/** Lines a diff patch scrolls per PageUp/PageDown; matches the rendered window. */
export const diffPageLines = 18;

/**
 * Owns all frontend state and every server interaction. Views read `state` and call
 * methods; they never talk to the backend. Leaving a session is a pure view change:
 * nothing here calls interrupt/background/delete on navigation.
 */
export class AppController {
  readonly state: AppState;
  private readonly setState: SetStoreFunction<AppState>;
  private noticeCounter = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly transcriptInFlight = new Map<string, Promise<void>>();
  private readonly transcriptDirty = new Set<string>();
  private readonly summaryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private transcriptOrder: string[] = [];
  private readonly debugLog: DebugLog;
  private fileCache: { root: string; files: string[] } | undefined;
  private readonly fileScans = new Map<string, Promise<string[]>>();
  private completionRequest = 0;
  private disposed = false;
  private persisted: LocalState;
  /** In-flight saves, serialized per controller. */
  private saveChain: Promise<void> = Promise.resolve();
  private saveError: string | undefined;
  private readonly goalStore: GoalStore;
  /** Serializes instruction writes/removals per session so toggles cannot race. */
  private readonly instructionQueue = new Map<string, Promise<void>>();

  constructor(private readonly deps: ControllerDeps) {
    this.debugLog = deps.debugLog ?? noDebugLog;
    const [state, setState] = createStore<AppState>(initialState(deps.cwd));
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

  // ---------------------------------------------------------------- selectors

  executionOf(sessionID: string): Execution {
    const permissions = this.state.permissions[sessionID] ?? [];
    return projectExecution({
      connected: this.state.stream !== 'reconnecting',
      loaded: this.state.sessions[sessionID] !== undefined,
      running: this.state.running[sessionID] === true,
      outcome: this.state.sessions[sessionID]?.outcome,
      permissionIDs: permissions.map((permission) => permission.id),
      formCount: (this.state.forms[sessionID] ?? []).length,
    });
  }

  currentSession(): SessionSummary | undefined {
    const route = this.state.route;
    return route.kind === 'conversation' ? this.state.sessions[route.sessionID] : undefined;
  }

  groups(): ProjectGroup[] {
    return groupSessions(Object.values(this.state.sessions), {
      platform: this.deps.platform,
      showArchived: this.deps.config.sessions.showArchived,
      showChildren: this.deps.config.sessions.showChildren,
      activityOf: (session) => this.lastUsed(session),
    });
  }

  /** Most recent use: server activity or this frontend opening the session. */
  lastUsed(session: SessionSummary): number {
    return Math.max(session.updatedAt, this.state.openedAt[session.id] ?? 0);
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

  get version(): string {
    return this.deps.version;
  }

  get cwd(): string {
    return this.deps.cwd;
  }

  get serverUrl(): string {
    return this.deps.backend.baseUrl;
  }

  // ---------------------------------------------------------------- startup

  /** Loads catalogs and sessions. Errors propagate so startup can report them. */
  async bootstrap(): Promise<void> {
    await Promise.all([this.loadCatalog(this.deps.cwd), this.loadSessions()]);
  }

  private catalogGeneration = 0;
  private catalogInFlight: Promise<void> | undefined;

  async loadCatalog(directory: string): Promise<void> {
    const generation = ++this.catalogGeneration;
    const key = directoryKey(directory, this.deps.platform);
    const promise = this.innerLoadCatalog(directory, generation, key);
    this.catalogInFlight = promise;
    try {
      await promise;
    } finally {
      if (this.catalogInFlight === promise) this.catalogInFlight = undefined;
    }
  }

  private async innerLoadCatalog(
    directory: string,
    generation: number,
    key: string,
  ): Promise<void> {
    this.setState('catalogDirectory', key);
    this.setState('catalogLoading', true);
    this.setState('catalogError', undefined);
    try {
      const [agents, models, fallback, commands] = await Promise.all([
        this.deps.backend.listAgents(directory),
        this.deps.backend.listModels(directory),
        this.deps.backend.defaultModel(directory),
        this.deps.backend.listCommands(directory).catch(() => []),
      ]);
      if (generation !== this.catalogGeneration) return; // a newer project superseded this fetch
      batch(() => {
        this.setState('agents', selectableAgents(agents, this.deps.config.agents.cycle));
        this.setState('models', models);
        this.setState('defaultModel', fallback);
        this.setState('serverCommands', commands);
        this.setState('catalogLoading', false);
      });
    } catch (error) {
      if (generation !== this.catalogGeneration) return;
      // Never leave another project's catalog usable after a failed reload.
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

  /** True when the loaded catalog is exactly the one for `directory` and usable. */
  catalogFresh(directory: string): boolean {
    return (
      this.state.catalogDirectory === directoryKey(directory, this.deps.platform) &&
      !this.state.catalogLoading &&
      this.state.catalogError === undefined
    );
  }

  /** Reloads in the background when the catalog does not match the project right now. */
  private refreshCatalogIfStale(directory: string): void {
    if (this.catalogFresh(directory)) return;
    if (
      this.state.catalogLoading &&
      this.state.catalogDirectory === directoryKey(directory, this.deps.platform)
    ) {
      return; // already loading exactly this project's catalog
    }
    // A load for a different directory may be in flight; starting this one now supersedes it.
    void this.track('catalog', this.loadCatalog(directory));
  }

  /** Guarantees the catalog matches `directory`, reloading it if needed. */
  private async ensureCatalog(directory: string): Promise<boolean> {
    if (this.catalogFresh(directory)) return true;
    const key = directoryKey(directory, this.deps.platform);
    if (this.catalogInFlight !== undefined && this.state.catalogDirectory === key) {
      // A load for this project is already in flight; wait for it instead of restarting it.
      try {
        await this.catalogInFlight;
      } catch {
        // Error already recorded on state; freshness check below reports failure.
      }
      return this.catalogFresh(directory);
    }
    try {
      await this.loadCatalog(directory);
      return true;
    } catch (error) {
      this.showNotice(`Could not load project catalog: ${errorText(error)}`, 'error');
      return false;
    }
  }

  async loadSessions(): Promise<void> {
    const loaded: SessionSummary[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await this.deps.backend.listSessions(cursor === undefined ? {} : { cursor });
      loaded.push(...page.sessions);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < sessionPageLimit);
    const active = await this.deps.backend.activeSessionIDs();
    batch(() => {
      const fresh = Object.fromEntries(loaded.map((session) => [session.id, session]));
      // Keep sessions revealed by loadMoreSessions beyond the first pages; deletions
      // arrive as session-deleted events.
      this.setState('sessions', (current) => ({ ...current, ...fresh }));
      this.setState('sessionsComplete', cursor === undefined);
      this.setState('sessionsCursor', cursor);
      this.setState('sessionsLoading', false);
      this.setState('sessionsError', undefined);
      this.setState('running', Object.fromEntries([...active].map((id) => [id, true])));
    });
    // Running sessions are the ones that can be blocked on input right now.
    await Promise.all([...active].map((id) => this.refreshInputRequests(id)));
  }

  /**
   * Fetch the next older page of sessions (the row the overview offers once the first
   * pages fail to cover everything). Merges by id, so retrying after a failure never
   * duplicates rows and never discards earlier pages.
   */
  async loadMoreSessions(): Promise<void> {
    if (this.state.sessionsComplete || this.state.sessionsLoading) return;
    const cursor = this.state.sessionsCursor;
    this.setState('sessionsLoading', true);
    this.setState('sessionsError', undefined);
    try {
      const [page, active] = await Promise.all([
        this.deps.backend.listSessions(cursor === undefined ? {} : { cursor }),
        this.deps.backend.activeSessionIDs(),
      ]);
      batch(() => {
        this.setState('sessions', (current) => {
          const merged = { ...current };
          for (const session of page.sessions) merged[session.id] = session;
          return merged;
        });
        this.setState('sessionsComplete', page.nextCursor === undefined);
        this.setState('sessionsCursor', page.nextCursor);
        this.setState('sessionsLoading', false);
        this.setState('running', (current) => {
          const merged = { ...current };
          for (const id of active) merged[id] = true;
          return merged;
        });
      });
      await Promise.all([...active].map((id) => this.refreshInputRequests(id)));
      this.debugLog.write('action', { action: 'load-more-sessions', ok: true });
      // The pagination row disappears once the server says the list is complete; keep a
      // still-valid selection by landing on the last remaining row.
      if (page.nextCursor === undefined && this.state.overview.selectedRow === loadMoreRowKey) {
        const rows = this.overviewRows();
        const last = rows[rows.length - 1];
        if (last !== undefined) this.selectRow(last);
        else this.setState('overview', 'selectedRow', undefined);
      }
    } catch (error) {
      this.setState('sessionsLoading', false);
      this.debugLog.write('action', { action: 'load-more-sessions', ok: false });
      this.setState(
        'sessionsError',
        error instanceof Error ? error.message : 'Unknown error loading sessions',
      );
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

  // ---------------------------------------------------------------- events

  onStreamStatus(status: StreamStatus): void {
    this.debugLog.write('stream-status', { status });
    const reconnected = status === 'live' && this.state.stream === 'reconnecting';
    this.setState('stream', status);
    if (status === 'reconnecting') this.showNotice('Connection lost · retrying', 'warn', false);
    if (reconnected) void this.track('retry-instructions', this.retryPendingRemovals());
  }

  onEvents(events: readonly BackendEvent[], resync: boolean): void {
    this.debugLog.write('events', {
      count: events.length,
      kinds: [...new Set(events.map((event) => event.kind))],
      resync,
    });
    if (this.disposed) return;
    if (resync) {
      void this.track('resync', this.resync());
      return;
    }
    batch(() => {
      for (const event of events) this.applyEvent(event);
    });
  }

  private async resync(): Promise<void> {
    await this.loadSessions();
    void this.track('catalog', this.loadCatalog(this.currentDirectory()));
    const route = this.state.route;
    if (route.kind === 'conversation') await this.loadConversation(route.sessionID);
    for (const id of Object.keys(this.state.transcripts)) {
      if (route.kind !== 'conversation' || route.sessionID !== id) {
        this.setState('transcripts', id, 'stale', true);
      }
    }
    if (this.state.notice?.text === 'Connection lost · retrying') this.clearNotice();
  }

  private applyEvent(event: BackendEvent): void {
    const attached =
      this.state.route.kind === 'conversation' ? this.state.route.sessionID : undefined;
    switch (event.kind) {
      case 'connected':
        return;
      case 'catalog-changed':
        void this.track('catalog', this.loadCatalog(this.currentDirectory()));
        return;
      case 'revert-changed':
        // Immediate reconcile (not debounced): opens the recovery dialog for a staged
        // revert we do not know about, or drops one resolved elsewhere.
        void this.track('revert', this.refreshSummary(event.sessionID));
        return;
      case 'session-changed':
        this.scheduleSummary(event.sessionID);
        return;
      case 'session-deleted':
        this.setState(
          produce((state) => {
            delete state.sessions[event.sessionID];
            delete state.transcripts[event.sessionID];
          }),
        );
        if (attached === event.sessionID) {
          this.setState('route', { kind: 'overview' });
          this.showNotice('This session was deleted on the server.', 'warn');
        }
        return;
      case 'usage':
        if (this.state.sessions[event.sessionID] !== undefined) {
          this.setState('sessions', event.sessionID, { cost: event.cost, tokens: event.tokens });
        }
        return;
      case 'execution':
        this.setState('running', event.sessionID, event.state === 'started');
        this.scheduleSummary(event.sessionID);
        if (attached === event.sessionID) this.scheduleTranscript(event.sessionID);
        else this.markStale(event.sessionID);
        if (event.state !== 'started')
          void this.track('requests', this.refreshInputRequests(event.sessionID));
        return;
      case 'transcript-changed':
        if (this.state.sessions[event.sessionID] === undefined)
          this.scheduleSummary(event.sessionID);
        if (attached === event.sessionID) this.scheduleTranscript(event.sessionID);
        else this.markStale(event.sessionID);
        return;
      case 'inbox-changed':
        if (attached === event.sessionID)
          void this.track('inbox', this.refreshInbox(event.sessionID));
        return;
      case 'input-requests-changed':
        void this.track('requests', this.refreshInputRequests(event.sessionID));
        return;
      default:
        return;
    }
  }

  private markStale(sessionID: string): void {
    if (this.state.transcripts[sessionID] !== undefined) {
      this.setState('transcripts', sessionID, 'stale', true);
    }
  }

  /** Coalesces bursts of summary-changing events into one `session.get`. */
  private scheduleSummary(sessionID: string): void {
    if (this.summaryTimers.has(sessionID)) return;
    this.summaryTimers.set(
      sessionID,
      setTimeout(() => {
        this.summaryTimers.delete(sessionID);
        void this.track('session', this.refreshSummary(sessionID));
      }, 150),
    );
  }

  private async refreshSummary(sessionID: string): Promise<void> {
    try {
      const session = await this.deps.backend.getSession(sessionID);
      // reconcile replaces the stored summary wholesale: absent `revert` is removed again.
      this.setState('sessions', sessionID, reconcile(session));
      this.reconcileStagedRevert(sessionID);
    } catch (error) {
      if (error instanceof BackendError && error.kind === 'not-found') return;
      throw error;
    }
  }

  private async refreshInbox(sessionID: string): Promise<void> {
    const items = await this.deps.backend.listInbox(sessionID);
    this.setState('inbox', sessionID, items);
  }

  private async refreshInputRequests(sessionID: string): Promise<void> {
    const [permissions, forms] = await Promise.all([
      this.deps.backend.listPermissions(sessionID),
      this.deps.backend.listForms(sessionID),
    ]);
    batch(() => {
      this.setState('permissions', sessionID, permissions);
      this.setState('forms', sessionID, forms);
      if (permissions.length === 0) this.setState('permissionChoice', 0);
    });
  }

  // ---------------------------------------------------------------- transcripts

  /** Throttled canonical refetch: at most one request in flight per session. */
  private scheduleTranscript(sessionID: string): void {
    if (this.transcriptInFlight.has(sessionID)) {
      this.transcriptDirty.add(sessionID);
      return;
    }
    const run = (async () => {
      try {
        await this.fetchLatest(sessionID);
        await delay(80);
      } finally {
        this.transcriptInFlight.delete(sessionID);
      }
      if (this.transcriptDirty.delete(sessionID) && !this.disposed)
        this.scheduleTranscript(sessionID);
    })();
    this.transcriptInFlight.set(sessionID, run);
    void this.track('transcript', run);
  }

  private async fetchLatest(sessionID: string): Promise<void> {
    const page = await this.deps.backend.listMessages(sessionID, transcriptPageSize);
    const existing = this.state.transcripts[sessionID];
    const merged = mergeLatest(existing?.messages ?? [], page.messages);
    // Cached messages older than this page keep their own cursor; otherwise the page's
    // cursor is the way further back (an empty placeholder transcript has none).
    const olderCursor =
      merged.length > page.messages.length ? existing?.olderCursor : page.olderCursor;
    this.setState(
      'transcripts',
      produce((transcripts) => {
        transcripts[sessionID] = {
          messages: merged,
          loading: false,
          stale: false,
          ...(olderCursor === undefined ? {} : { olderCursor }),
        };
      }),
    );
    this.touchTranscript(sessionID);
  }

  async loadOlder(sessionID: string): Promise<void> {
    const transcript = this.state.transcripts[sessionID];
    if (transcript?.olderCursor === undefined || transcript.loading) return;
    this.setState('transcripts', sessionID, 'loading', true);
    try {
      const page = await this.deps.backend.listMessages(
        sessionID,
        transcriptPageSize,
        transcript.olderCursor,
      );
      const known = new Set(transcript.messages.map((message) => message.id));
      const older = page.messages.filter((message) => !known.has(message.id));
      // Replace via produce: a merging setter would keep a stale cursor after the last page.
      this.setState(
        'transcripts',
        sessionID,
        produce((current) => {
          current.messages = [...older, ...current.messages];
          current.loading = false;
          if (page.olderCursor === undefined) delete current.olderCursor;
          else current.olderCursor = page.olderCursor;
        }),
      );
    } catch (error) {
      this.setState('transcripts', sessionID, 'loading', false);
      throw error;
    }
  }

  /** Rendered node limit for a session's transcript. */
  transcriptWindow(sessionID: string): number {
    return this.state.transcriptWindow[sessionID] ?? transcriptWindowStep;
  }

  /**
   * Paging past the top: first un-hide already loaded nodes, then fetch the next older
   * page from the server. Returns false when there is nothing earlier.
   */
  revealEarlier(sessionID: string, hiddenNodes: number): boolean {
    if (hiddenNodes > 0) {
      this.setState(
        'transcriptWindow',
        sessionID,
        this.transcriptWindow(sessionID) + transcriptWindowStep,
      );
      return true;
    }
    const transcript = this.state.transcripts[sessionID];
    if (transcript?.olderCursor === undefined) return false;
    this.setState(
      'transcriptWindow',
      sessionID,
      this.transcriptWindow(sessionID) + transcriptWindowStep,
    );
    void this.track('history', this.loadOlder(sessionID));
    return true;
  }

  /** Bounded LRU of cached transcripts; detached sessions keep summaries only. */
  private touchTranscript(sessionID: string): void {
    this.transcriptOrder = [sessionID, ...this.transcriptOrder.filter((id) => id !== sessionID)];
    const evicted = this.transcriptOrder.slice(transcriptCacheLimit);
    this.transcriptOrder = this.transcriptOrder.slice(0, transcriptCacheLimit);
    if (evicted.length === 0) return;
    this.setState(
      produce((state) => {
        for (const id of evicted) delete state.transcripts[id];
      }),
    );
  }

  private async loadConversation(sessionID: string): Promise<void> {
    await Promise.all([
      this.fetchLatest(sessionID),
      this.refreshInbox(sessionID),
      this.refreshInputRequests(sessionID),
      this.refreshSummary(sessionID),
    ]);
  }

  // ---------------------------------------------------------------- navigation

  /** View change only: no backend mutation. Drafts are kept per route. */
  openSession(sessionID: string): void {
    this.debugLog.write('route', { kind: 'conversation', sessionID });
    this.saveDraft();
    const transcript = this.state.transcripts[sessionID];
    batch(() => {
      this.setState('route', { kind: 'conversation', sessionID });
      this.setState('overlay', { kind: 'none' });
      this.setState('completion', undefined);
      this.setState('focusedGroup', undefined);
      this.setState('permissionChoice', 0);
      this.setState('openedAt', sessionID, this.deps.now());
      this.writeComposer(this.state.drafts[sessionID] ?? emptyComposer);
      if (transcript === undefined) {
        this.setState('transcripts', sessionID, { messages: [], loading: true, stale: false });
      }
    });
    const directory = this.state.sessions[sessionID]?.directory;
    if (directory !== undefined) {
      this.loadHistoryFor(directory);
      this.refreshCatalogIfStale(directory);
    }
    void this.track('attach', this.loadConversation(sessionID));
    void this.loadGoal(sessionID);
  }

  /**
   * An unsent conversation in `directory`. Nothing is created on the server until the
   * first prompt is submitted, so opening margarita never leaves empty sessions behind.
   */
  startNewSession(directory: string): void {
    this.debugLog.write('route', { kind: 'new', directory });
    this.saveDraft();
    batch(() => {
      this.setState('route', { kind: 'new', directory });
      this.setState('overlay', { kind: 'none' });
      this.setState('completion', undefined);
      this.setState('focusedGroup', undefined);
      this.setState('overview', 'directory', directory);
      this.writeComposer(this.state.drafts[`new:${directory}`] ?? emptyComposer);
    });
    this.loadHistoryFor(directory);
    this.refreshCatalogIfStale(directory);
  }

  /**
   * View change only: the session keeps running on the server. The cursor starts on
   * the first row; typing still goes straight to the new-session prompt.
   */
  openOverview(): void {
    this.debugLog.write('route', { kind: 'overview' });
    this.saveDraft();
    const directory = this.currentDirectory();
    batch(() => {
      this.setState('route', { kind: 'overview' });
      this.setState('overlay', { kind: 'none' });
      this.setState('completion', undefined);
      this.setState('focusedGroup', undefined);
      this.writeComposer(this.state.drafts['overview'] ?? emptyComposer);
      this.setState('overview', 'directory', directory);
      const first = this.overviewRows()[0];
      if (first === undefined) {
        this.setState('overview', 'focus', 'composer');
        this.setState('overview', 'selectedRow', undefined);
      } else {
        this.selectRow(first);
      }
    });
    this.loadHistoryFor(this.state.overview.directory);
  }

  /**
   * Replaces the composer with a fresh object. A path setter would shallow-merge into
   * the stored object, which may be shared (a draft, or the `emptyComposer` constant).
   */
  private writeComposer(composer: Composer): void {
    this.setState({ composer: { ...composer } });
  }

  private saveDraft(): void {
    const key = routeKey(this.state.route);
    this.setState('drafts', key, { ...this.state.composer });
  }

  private selectRow(row: OverviewRow): void {
    this.setState('overview', 'focus', 'list');
    this.setState('overview', 'selectedRow', row.key);
    const directory =
      row.kind === 'session'
        ? row.session.directory
        : row.kind === 'toggle'
          ? this.groups().find((group) => group.key === row.groupKey)?.directory
          : undefined; // loadmore keeps the current directory
    if (directory !== undefined) this.setState('overview', 'directory', directory);
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
    this.openSession(row.session.id);
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

  setComposer(composer: Composer): void {
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
      if (!this.catalogFresh(directory)) {
        // Never suggest another project's commands; reload and show nothing until it lands.
        this.refreshCatalogIfStale(directory);
        if (this.state.completion?.kind === 'command') this.setState('completion', undefined);
        return;
      }
      const items = completeCommand(text, this.state.serverCommands).map((item) => ({
        label: `/${item.name}`,
        detail: item.description,
        insert: `/${item.name} `,
      }));
      this.setState(
        'completion',
        items.length === 0 ? undefined : { kind: 'command', items, index: 0, start: 0 },
      );
      return;
    }
    const mention = activeMention(text, cursor);
    if (mention !== undefined) {
      void this.track('files', this.completeFiles(mention.path, mention.start));
      return;
    }
    if (this.state.completion !== undefined) this.setState('completion', undefined);
  }

  private async completeFiles(partial: string, start: number): Promise<void> {
    const request = ++this.completionRequest;
    const root = this.currentDirectory();
    const remote = this.deps.remoteFilesystem === true;
    const files = remote
      ? await this.deps.backend.findProjectFiles(root, partial, 50).catch(() => [] as string[]) // best-effort completion; unreadable server is silent here
      : await this.filesFor(root);
    const mention = activeMention(this.state.composer.text, this.state.composer.cursor);
    if (
      request !== this.completionRequest || // a newer mention superseded this one
      mention === undefined ||
      mention.start !== start ||
      mention.path !== partial || // same offset, different query (`@a` → `@src`)
      this.currentDirectory() !== root // project switched mid-scan
    ) {
      return;
    }
    // Remote results arrive ranked by the server's own fuzzy search; trust that order.
    const items = (remote ? files.slice(0, 8) : rankPaths(files, partial, 8)).map((path) => ({
      label: `@${path}`,
      detail: '',
      insert: `@${path} `,
    }));
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

  toggleStash(): void {
    const text = this.state.composer.text;
    if (text !== '') {
      batch(() => {
        this.setState('stash', text);
        this.writeComposer(emptyComposer);
      });
      this.showNotice('Draft stashed · Ctrl+S to restore', 'dim');
    } else if (this.state.stash !== undefined) {
      const stash = this.state.stash;
      batch(() => {
        this.writeComposer(composerFrom(stash));
        this.setState('stash', undefined);
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

  private loadHistoryFor(directory: string): void {
    const key = directoryKey(directory, this.deps.platform);
    // Read the live snapshot: prompts recorded this run live in `persisted`, not in the
    // startup copy from `deps.localState`. Returning to a project must not hide them.
    // Replace each field rather than merge the object: a stale browse index from the
    // previous project would otherwise make historyUp() look like the end of this list.
    // A fresh array reference also keeps store mutations away from the persisted snapshot.
    this.setState('history', {
      entries: [...(this.persisted.history[key] ?? [])],
      index: undefined,
      savedDraft: '',
    });
  }

  private rememberPrompt(text: string, directory: string): void {
    const history = recordEntry(this.state.history, text, this.deps.config.history.limit);
    this.setState('history', history);
    const key = directoryKey(directory, this.deps.platform);
    this.persist({ history: { ...this.persisted.history, [key]: history.entries } });
  }

  // ---------------------------------------------------------------- submit

  /** Enter. Clears the composer only after the server accepted the input. */
  async submit(deliveryOverride?: Delivery): Promise<void> {
    if (this.state.admitting) return;
    const text = this.state.composer.text;
    if (text.trim() === '') return;
    const localName = /^\/(\S+)/.exec(text.trimStart())?.[1];
    const isLocal = localName !== undefined && isLocalCommand(localName);
    if (text.trimStart().startsWith('/')) {
      // Local control commands are frontend-local and must keep working when the server or
      // its catalog is broken; only server and plugin commands need the server catalog.
      if (!isLocal && !(await this.ensureCatalog(this.currentDirectory()))) return;
    }
    const parsed = parseInput(
      text,
      new Set(this.state.serverCommands.map((command) => command.name)),
    );
    if (parsed.kind === 'local') {
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
      await this.createSessionWithPrompt(this.currentDirectory(), text);
      return;
    }
    const sessionID = this.state.route.sessionID;
    const directory = this.state.sessions[sessionID]?.directory ?? this.deps.cwd;
    const commandNotice =
      'The request may or may not have been delivered (connection problem); check for its effects before resending.';
    const isPromptDelivery = parsed.kind === 'prompt';
    await this.admit(
      text,
      directory,
      async () => {
        switch (parsed.kind) {
          case 'shell':
            await this.deps.backend.runShell(sessionID, parsed.command);
            return;
          case 'server':
            await this.deps.backend.runCommand(sessionID, parsed.name, parsed.args);
            return;
          case 'prompt': {
            const running = this.state.running[sessionID] === true;
            const delivery =
              deliveryOverride ?? (running ? this.deps.config.input.enterWhileRunning : undefined);
            await this.deps.backend.prompt(sessionID, {
              text,
              files: await this.resolveFiles(text, directory),
              ...(delivery === undefined ? {} : { delivery }),
            });
            await this.refreshInbox(sessionID);
            return;
          }
          default:
            return;
        }
      },
      isPromptDelivery ? undefined : commandNotice,
    );
  }

  /** Sends the current draft with steer delivery (Alt+Enter or /steer). */
  async steer(): Promise<void> {
    if (this.state.route.kind !== 'conversation') return;
    await this.submit('steer');
  }

  private async admit(
    text: string,
    directory: string,
    send: () => Promise<void>,
    transportNotice = 'Delivery unknown (connection problem). Check the transcript before resending.',
  ): Promise<boolean> {
    this.setState('admitting', true);
    try {
      await send();
      this.debugLog.write('action', { action: 'submit', ok: true });
      this.rememberPrompt(text, directory);
      this.clearComposer(text);
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
        if (this.state.route.kind === 'conversation') {
          this.scheduleTranscript(this.state.route.sessionID);
          void this.track('inbox', this.refreshInbox(this.state.route.sessionID));
        }
      } else {
        this.showNotice(errorText(error), 'error');
      }
      return false;
    } finally {
      this.setState('admitting', false);
    }
  }

  private clearComposer(submitted: string): void {
    if (this.state.composer.text === submitted) {
      batch(() => {
        this.writeComposer(emptyComposer);
        this.setState('completion', undefined);
        this.setState('focusedGroup', undefined);
      });
    }
  }

  private resolveFiles(text: string, directory: string): Promise<PromptFile[]> {
    if (this.deps.remoteFilesystem === true) return this.resolveRemoteFiles(text, directory);
    return this.resolveLocalFiles(text, directory);
  }

  private async resolveLocalFiles(text: string, directory: string): Promise<PromptFile[]> {
    const files: PromptFile[] = [];
    const missing: string[] = [];
    for (const mention of findFileMentions(text)) {
      const path = isAbsolute(mention.path) ? mention.path : resolve(directory, mention.path);
      if (!(await Bun.file(path).exists())) {
        missing.push(mention.text);
        continue;
      }
      files.push({
        uri: pathToFileURL(path).href,
        name: mention.path,
        start: mention.start,
        end: mention.end,
        text: mention.text,
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
  private async resolveRemoteFiles(text: string, directory: string): Promise<PromptFile[]> {
    const shape = serverPathShape(directory);
    const files: PromptFile[] = [];
    const missing: string[] = [];
    for (const mention of findFileMentions(text)) {
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
        // name as query guarantees the file appears in the hits when it exists.
        const hits = await this.deps.backend.findProjectFiles(
          directory,
          baseServerPath(relative),
          100,
        );
        matched = hits.find((hit) => normalizeServerPath(hit, shape) === relative);
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
        uri: serverFileUri(canonical),
        name: mention.path,
        start: mention.start,
        end: mention.end,
        text: mention.text,
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

  /** Creates a session in `directory`, sends the first prompt, then attaches. */
  async createSessionWithPrompt(
    directory: string,
    text: string | undefined,
  ): Promise<string | undefined> {
    const agent = this.state.overview.agent;
    const model = this.state.overview.model;
    this.setState('admitting', true);
    let session: SessionSummary;
    try {
      session = await this.deps.backend.createSession({
        directory,
        ...(agent === undefined ? {} : { agent }),
        ...(model === undefined ? {} : { model }),
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
    this.setState('admitting', false);
    this.setState('sessions', session.id, session);
    if (text !== undefined) {
      this.clearComposer(text);
      this.openSession(session.id);
      this.writeComposer(composerFrom(text));
      const sent = await this.admit(text, directory, async () => {
        await this.deps.backend.prompt(session.id, {
          text,
          files: await this.resolveFiles(text, directory),
        });
      });
      if (!sent)
        this.showNotice(`Session ${session.id} was created but the prompt was not sent.`, 'error');
    } else {
      this.openSession(session.id);
    }
    return session.id;
  }

  /**
   * Directory-targeted search for the most recent session in `directory`. Unlike the
   * overview listing (which only covers the first pages), this pages until the server
   * says everything for that directory is loaded, so --continue works beyond the first
   * 500 global sessions. Archived and child sessions are filtered here; the result is
   * stored in state before attach so directory/model metadata is correct.
   */
  async findLatestSessionIn(directory: string): Promise<SessionSummary | undefined> {
    const key = directoryKey(directory, this.deps.platform);
    const directoryQuery = { directory };
    let cursor: string | undefined;
    let pages = 0;
    let best: SessionSummary | undefined;
    try {
      do {
        const page = await this.deps.backend.listSessions(
          cursor === undefined ? directoryQuery : { directory, cursor },
        );
        for (const session of page.sessions) {
          if (session.archived || session.parentID !== undefined) continue;
          if (directoryKey(session.directory, this.deps.platform) !== key) continue;
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
    const key = directoryKey(directory, this.deps.platform);
    return Object.values(this.state.sessions)
      .filter(
        (session) =>
          !session.archived &&
          session.parentID === undefined &&
          directoryKey(session.directory, this.deps.platform) === key,
      )
      .toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
  }

  /** Stores a fetched/resolved summary before it is attached or prompted. */
  private storeSessionSummary(session: SessionSummary): void {
    this.setState('sessions', session.id, session);
  }

  /**
   * Makes sure a session the user asked for (e.g. --resume <id>) is known before we
   * open or prompt it. Returns the summary, or undefined when the server cannot find it.
   */
  async ensureSession(sessionID: string): Promise<SessionSummary | undefined> {
    const known = this.state.sessions[sessionID];
    if (known !== undefined) return known;
    try {
      const session = await this.deps.backend.getSession(sessionID);
      this.storeSessionSummary(session);
      return session;
    } catch (error) {
      if (error instanceof BackendError && error.kind === 'not-found') return undefined;
      throw error;
    }
  }

  async sendToSession(sessionID: string, text: string): Promise<boolean> {
    // Ensure the stored summary is authoritative before interpreting file mentions.
    await this.ensureSession(sessionID);
    const directory = this.state.sessions[sessionID]?.directory ?? this.deps.cwd;
    this.writeComposer(composerFrom(text));
    const running = this.state.running[sessionID] === true;
    return this.admit(text, directory, async () => {
      await this.deps.backend.prompt(sessionID, {
        text,
        files: await this.resolveFiles(text, directory),
        ...(running ? { delivery: this.deps.config.input.enterWhileRunning } : {}),
      });
    });
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
        this.startNewSession(this.currentDirectory());
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
      case 'status':
        this.setOverlay({ kind: 'status' });
        return;
      case 'queue':
        this.setOverlay({ kind: 'queue', index: 0 });
        return;
      case 'export':
        await this.exportChat(args);
        return;
      case 'goal':
        await this.goalCommand(args);
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
      case 'sync':
        await this.syncCommand(args);
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
      case 'server':
        return; // parsed into a server command before reaching here
      default:
        return;
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
    this.setState('sessions', session.id, { ...session, agent: agentID });
    try {
      await this.deps.backend.switchAgent(session.id, agentID);
      if (this.state.running[session.id] === true)
        this.showNotice(`Agent: ${agentID} (next turn)`, 'dim');
    } catch (error) {
      this.showNotice(errorText(error), 'error');
    }
    await this.refreshSummary(session.id);
  }

  async openModelPicker(): Promise<void> {
    if (!(await this.ensureCatalog(this.currentDirectory()))) return;
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
    if (!(await this.ensureCatalog(this.currentDirectory()))) return;
    const resolved = resolveModel({ model: ref }, this.state.models);
    if (resolved.kind === 'error') {
      this.showNotice(resolved.message, 'warn');
      return;
    }
    if (resolved.kind === 'resolved') await this.setModel(resolved.model);
  }

  private async setEffort(variant: string): Promise<void> {
    if (!(await this.ensureCatalog(this.currentDirectory()))) return;
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

  async setModel(model: ModelSelection): Promise<void> {
    this.rememberModel(model);
    const session = this.currentSession();
    if (session === undefined) {
      this.setState('overview', 'model', model);
      return;
    }
    this.setState('sessions', session.id, { ...session, model });
    try {
      await this.deps.backend.switchModel(session.id, model);
    } catch (error) {
      this.showNotice(errorText(error), 'error');
    }
    await this.refreshSummary(session.id);
  }

  /** F2: next recently used model still present in the catalog. */
  async nextRecentModel(): Promise<void> {
    if (!(await this.ensureCatalog(this.currentDirectory()))) return;
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
      const interrupted = await this.deps.backend.interrupt(session.id);
      this.debugLog.write('action', { action: 'interrupt', ok: interrupted });
      this.showNotice(interrupted ? 'Interrupted' : 'Nothing was running', 'dim');
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
    if (session === undefined || this.state.running[session.id] !== true) {
      this.showNotice('Nothing running to background.', 'dim');
      return;
    }
    try {
      await this.deps.backend.backgroundTools(session.id);
      this.showNotice('Running tools moved to the background', 'dim');
    } catch (error) {
      this.showNotice(`Background failed: ${errorText(error)}`, 'error');
    }
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
    const path = resolve(session.directory, target === '' ? `marg-${session.id}.json` : target);
    try {
      const pages: TranscriptMessage[][] = [];
      let cursor: string | undefined;
      do {
        const page = await this.deps.backend.listMessages(session.id, exportPageSize, cursor);
        pages.unshift(page.messages);
        cursor = page.olderCursor;
      } while (cursor !== undefined);
      const goal = this.state.goals[session.id];
      const log = {
        format: 'margarita.chatlog.v1',
        exportedAt: new Date(this.deps.now()).toISOString(),
        server: this.deps.backend.baseUrl,
        session,
        messages: pages.flat(),
        ...(goal === undefined ? {} : { goal }),
      };
      const write =
        this.deps.writeFile ?? (async (file, text) => void (await Bun.write(file, text)));
      await write(
        path,
        `${JSON.stringify(log, null, 2)}
`,
      );
      this.showNotice(`Exported ${log.messages.length} messages to ${path}`, 'dim');
    } catch (error) {
      this.showNotice(`Export failed: ${errorText(error)}`, 'error');
    }
  }

  isRunning(): boolean {
    const session = this.currentSession();
    return session !== undefined && this.state.running[session.id] === true;
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
    const session = this.currentSession();
    if (session === undefined) return;
    const sessionID = session.id;
    const item = (this.state.inbox[sessionID] ?? []).find((entry) => entry.id === inboxID);
    try {
      await this.deps.backend.cancelQueued(sessionID, inboxID);
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
      await this.refreshInbox(sessionID);
      return;
    }
    await this.refreshInbox(sessionID);
    if (item === undefined) return;
    // Restore the full text into the composer, never into a different session's composer.
    const sameSession =
      this.state.route.kind === 'conversation' && this.state.route.sessionID === sessionID;
    if (sameSession && this.state.composer.text === '' && this.state.completion === undefined) {
      this.writeComposer(composerFrom(item.text));
      return;
    }
    // Never clobber a draft the user typed during the cancel; park the recalled text instead.
    if (this.state.stash === undefined) {
      this.setState('stash', item.text);
      this.showNotice('Queued message parked · Ctrl+S to restore', 'dim');
      return;
    }
    this.showNotice(
      'Queued message cancelled, but the composer and the parked-draft slot were both busy.',
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
    const sessionID = this.state.route.sessionID;
    const items = this.state.inbox[sessionID] ?? [];
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
    const session = this.currentSession();
    if (session === undefined) return;
    try {
      await this.deps.backend.changeDelivery(session.id, inboxID, 'steer');
    } catch (error) {
      this.showNotice(errorText(error), 'error');
    }
    await this.refreshInbox(session.id);
  }

  // ---------------------------------------------------------------- permissions

  pendingPermission() {
    const session = this.currentSession();
    if (session === undefined) return undefined;
    return (this.state.permissions[session.id] ?? [])[0];
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
    const pending = this.pendingPermission();
    if (pending === undefined || this.state.answering) return;
    const choice = decision ?? this.permissionChoices()[this.state.permissionChoice] ?? 'reject';
    this.setState('answering', true);
    try {
      await this.deps.backend.replyPermission(pending.sessionID, pending.id, choice);
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
      await this.refreshInputRequests(pending.sessionID);
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
      const from = turnStart(this.state.transcripts[session.id]?.messages ?? []);
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
      const files = await this.deps.backend.sessionDiff(session.id, range);
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
    return (this.state.forms[session.id] ?? [])[0];
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
    return (this.state.forms[overlay.sessionID] ?? []).find(
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
        this.deps.backend.replyForm(form.sessionID, form.id, buildAnswer(form, editor.answers)),
      );
    } else if (outcome === 'decline') {
      void this.finishForm(form, () => this.deps.backend.cancelForm(form.sessionID, form.id));
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

  toggleGroup(key: string): void {
    this.setState(
      produce((state) => {
        if (state.expandedGroups[key] === true) delete state.expandedGroups[key];
        else state.expandedGroups[key] = true;
      }),
    );
  }

  /** Folded nodes for the attached conversation; empty elsewhere. */
  private conversationNodes(): TranscriptNode[] {
    if (this.state.route.kind !== 'conversation') return [];
    const target = this.state.route.sessionID;
    const messages = this.state.transcripts[target]?.messages ?? [];
    return foldTranscript(messages, {
      detailed: this.state.detailed,
      expandedGroups: new Set(Object.keys(this.state.expandedGroups)),
      expandedDiffs: new Set(Object.keys(this.state.expandedDiffs)),
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
    this.setState(
      produce((state) => {
        if (state.expandedDiffs[id] === true) delete state.expandedDiffs[id];
        else state.expandedDiffs[id] = true;
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

  currentDirectory(): string {
    if (this.state.route.kind === 'new') return this.state.route.directory;
    return this.currentSession()?.directory ?? this.state.overview.directory;
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

  goalOf(sessionID: string): GoalPlanV1 | undefined {
    return this.state.goals[sessionID];
  }

  /** The attached session's plan progress, for the footer and overview. */
  planProgress(sessionID: string): { done: number; total: number } | undefined {
    const plan = this.state.goals[sessionID]?.plan;
    return plan === undefined || plan.tasks.length === 0 ? undefined : progress(plan);
  }

  private async loadGoal(sessionID: string): Promise<void> {
    try {
      const doc = await this.goalStore.load(sessionID);
      if (doc !== undefined) this.setState('goals', sessionID, doc);
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
    sessionID = this.currentSession()?.id,
  ): Promise<GoalPlanV1 | undefined> {
    if (sessionID === undefined) {
      this.showNotice('Open a session first.', 'warn');
      return undefined;
    }
    const session = this.state.sessions[sessionID];
    const base =
      this.state.goals[sessionID] ?? emptyGoalPlan('local', sessionID, session?.projectID ?? '');
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
    this.setState('goals', sessionID, saved);
    if (notice !== undefined) this.showNotice(notice, 'dim');
    await this.syncInstructions(sessionID);
    return saved;
  }

  private async goalCommand(args: string): Promise<void> {
    if (this.requireSession() === undefined) return;
    if (args === '') {
      this.setOverlay({ kind: 'tasks', index: 0 });
      return;
    }
    if (args === 'clear') {
      await this.changeGoal((doc) => setGoal(doc, '', this.isoNow()), 'Goal cleared');
      return;
    }
    await this.changeGoal((doc) => setGoal(doc, args, this.isoNow()), `Goal set: ${args}`);
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
        const goal = this.state.goals[session.id]?.goal?.title;
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

  async acceptPlan(): Promise<void> {
    const id = this.currentSession()?.id;
    if (id === undefined || this.state.goals[id]?.proposal === undefined) return;
    await this.changeGoal((doc) => acceptProposal(doc, this.isoNow()), 'Plan accepted');
  }

  async rejectPlan(): Promise<void> {
    const id = this.currentSession()?.id;
    if (id === undefined || this.state.goals[id]?.proposal === undefined) return;
    await this.changeGoal(rejectProposal, 'Proposal rejected; plan unchanged');
  }

  private latestAssistantText(sessionID: string): string {
    const messages = this.state.transcripts[sessionID]?.messages ?? [];
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

  private latestAssistantID(sessionID: string): string | undefined {
    const messages = this.state.transcripts[sessionID]?.messages ?? [];
    return messages.findLast((message) => message.kind === 'assistant')?.id;
  }

  /** Ctrl+T checklist keys: ↑↓ move, Space cycle, b blocked, x cancel, e evidence, a/r proposal. */
  tasksKey(key: { name: string; text?: string }): void {
    const overlay = this.state.overlay;
    const session = this.currentSession();
    if (overlay.kind !== 'tasks' || session === undefined) return;
    const doc = this.state.goals[session.id];
    const tasks = (doc?.proposal ?? doc?.plan)?.tasks ?? [];
    const task = tasks[overlay.index];
    const count = tasks.length;
    const now = this.isoNow();
    const set = (state: TaskState) =>
      void this.changeGoal((current) => setTaskState(current, task?.id ?? '', state, now));
    if (key.name === 'escape' || key.name === 'q') this.closeOverlay();
    else if (key.name === 'up' && count > 0) {
      this.setOverlay({ kind: 'tasks', index: (overlay.index - 1 + count) % count });
    } else if (key.name === 'down' && count > 0) {
      this.setOverlay({ kind: 'tasks', index: (overlay.index + 1) % count });
    } else if (doc?.proposal !== undefined) {
      if (key.text === 'a') void this.acceptPlan();
      else if (key.text === 'r') void this.rejectPlan();
    } else if (task === undefined) {
      return;
    } else if (key.name === 'space' || key.text === ' ') set(nextTaskState(task.state));
    else if (key.text === 'b') set(task.state === 'blocked' ? 'todo' : 'blocked');
    else if (key.text === 'x') set(task.state === 'cancelled' ? 'todo' : 'cancelled');
    else if (key.text === 'e') {
      const messageID = this.latestAssistantID(session.id);
      if (messageID === undefined) {
        this.showNotice('No agent message to link yet.', 'warn');
        return;
      }
      void this.changeGoal(
        (current) => addEvidence(current, task.id, { messageID }, now),
        'Linked the latest agent message as evidence',
      );
    }
  }

  private async syncCommand(args: string): Promise<void> {
    const session = this.requireSession();
    if (session === undefined) return;
    if (args !== 'on' && args !== 'off') {
      this.showNotice('Usage: /sync on|off', 'warn');
      return;
    }
    const enabled = args === 'on';
    if (!enabled) {
      const revision = this.state.goals[session.id]?.revision ?? 0;
      this.setState('goalSync', session.id, { revision, status: 'pending-removal' });
      try {
        await this.queueInstruction(session.id, () =>
          this.deps.backend.removeInstruction(session.id, instructionKey),
        );
      } catch (error) {
        // Keep local sync enabled and block re-syncing: the server entry may still exist.
        this.setState('goalSync', session.id, {
          revision,
          status: 'removal-failed',
          error: errorText(error),
        });
        this.showNotice(
          `Could not revoke the shared instruction: ${errorText(error)} · /sync off to retry`,
          'warn',
          false,
        );
        return;
      }
      this.setState('goalSync', session.id, { revision, status: 'synced' });
      await this.changeGoal((doc) => setSync(doc, false), 'No longer shared with the agent');
      this.clearGoalSync(session.id);
      return;
    }
    // Re-enabling supersedes a failed revocation: clear the block before re-syncing.
    const pending = this.state.goalSync[session.id]?.status === 'removal-failed';
    if (pending) this.clearGoalSync(session.id);
    this.setState('goalSync', session.id, {
      revision: this.state.goals[session.id]?.revision ?? 0,
      status: 'pending-sync',
    });
    await this.changeGoal((doc) => setSync(doc, true), 'Goal and plan shared with the agent');
  }

  /**
   * Writes the compact instruction entry when the user opted in. A pending or failed
   * revocation blocks re-adding the instruction until the server confirms it is gone.
   */
  private async syncInstructions(sessionID: string): Promise<void> {
    const doc = this.state.goals[sessionID];
    const sync = doc?.modelInstructionSync;
    if (doc === undefined || sync?.enabled !== true) return;
    const blocked = this.state.goalSync[sessionID]?.status;
    if (blocked === 'pending-removal' || blocked === 'removal-failed') return;
    const text = instructionText(doc);
    try {
      await this.queueInstruction(sessionID, () =>
        text === ''
          ? this.deps.backend.removeInstruction(sessionID, sync.key)
          : this.deps.backend.putInstruction(sessionID, sync.key, text),
      );
      this.setState('goalSync', sessionID, { revision: doc.revision, status: 'synced' });
    } catch (error) {
      this.setState('goalSync', sessionID, {
        revision: doc.revision,
        status: 'error',
        error: errorText(error),
      });
      this.showNotice('Not synced to agent · local plan kept', 'warn');
    }
  }

  /** Chain per-session instruction operations so an older toggle cannot overwrite a newer one. */
  private queueInstruction(sessionID: string, work: () => Promise<void>): Promise<void> {
    const prior = this.instructionQueue.get(sessionID) ?? Promise.resolve();
    const settled = prior
      .catch(() => {})
      .then(work)
      .finally(() => {
        if (this.instructionQueue.get(sessionID) === settled)
          this.instructionQueue.delete(sessionID);
      });
    this.instructionQueue.set(sessionID, settled);
    // The chain is also held for the next operation; keep its rejection handled even
    // when the caller ignores the returned promise.
    void settled.catch(() => {});
    return settled;
  }

  private clearGoalSync(sessionID: string): void {
    this.setState(
      produce((state) => {
        delete state.goalSync[sessionID];
      }),
    );
  }

  /** After reconnect, finish revocations that could not be confirmed earlier. */
  private async retryPendingRemovals(): Promise<void> {
    const pending = Object.entries(this.state.goalSync).filter(
      ([, result]) => result.status === 'removal-failed',
    );
    for (const [sessionID, result] of pending) {
      if (this.state.goalSync[sessionID]?.status !== 'removal-failed') continue;
      try {
        await this.queueInstruction(sessionID, () =>
          this.deps.backend.removeInstruction(sessionID, instructionKey),
        );
      } catch (error) {
        this.setState('goalSync', sessionID, {
          revision: result.revision,
          status: 'removal-failed',
          error: errorText(error),
        });
        continue;
      }
      this.setState('goalSync', sessionID, { revision: result.revision, status: 'synced' });
      await this.changeGoal(
        (doc) => setSync(doc, false),
        'Shared instruction revoked after reconnect',
        sessionID,
      );
      this.clearGoalSync(sessionID);
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
      await this.deps.backend.renameSession(session.id, title);
      // The server's session event carries the authoritative title; reflect it now too.
      this.setState('sessions', session.id, { ...session, title });
      this.showNotice(`Renamed to ${title}`, 'dim');
    } catch (error) {
      this.showNotice(`Rename failed: ${errorText(error)}`, 'error');
    }
  }

  private async forkCurrent(): Promise<void> {
    const session = this.requireSession();
    if (session === undefined) return;
    try {
      const forked = await this.deps.backend.forkSession(session.id);
      this.setState('sessions', forked.id, forked);
      const doc = this.state.goals[session.id];
      if (doc !== undefined) {
        // Copy, never alias: the fork gets its own sidecar file.
        const copy = forkGoalPlan(doc, forked.id);
        this.setState('goals', forked.id, await this.goalStore.save(copy).catch(() => copy));
      }
      this.openSession(forked.id);
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
   */
  private reconcileStagedRevert(sessionID: string): void {
    const session = this.state.sessions[sessionID];
    const overlay = this.state.overlay;
    const staged = session?.revert;
    if (staged !== undefined) {
      if (overlay.kind === 'revert' && overlay.sessionID === sessionID) return;
      if (overlay.kind === 'revert') return; // another session's dialog is in front
      this.setOverlay({
        kind: 'revert',
        sessionID,
        messageID: staged.messageID,
        files: staged.files === undefined ? [] : [...staged.files],
        busy: false,
      });
      this.showNotice('A revert was staged on this session. Confirm or cancel it.', 'warn');
      return;
    }
    if (overlay.kind === 'revert' && overlay.sessionID === sessionID && !overlay.busy) {
      this.closeOverlay();
      this.showNotice('The staged revert was resolved elsewhere.', 'dim');
    }
  }

  /** Stages a revert to the last user message and asks before committing. */
  private async stageRevert(): Promise<void> {
    const session = this.requireSession();
    if (session === undefined) return;
    const messageID = turnStart(this.state.transcripts[session.id]?.messages ?? []);
    if (messageID === undefined) {
      this.showNotice('Nothing to revert yet.', 'warn');
      return;
    }
    try {
      const files = await this.deps.backend.stageRevert(session.id, messageID);
      this.setOverlay({ kind: 'revert', sessionID: session.id, messageID, files, busy: false });
    } catch (error) {
      this.showNotice(`Revert unavailable: ${errorText(error)}`, 'error');
    }
  }

  /** Enter/y commits the staged revert; Esc/n restores the files. */
  revertKey(key: { name: string; text?: string }): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'revert' || overlay.busy) return;
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
      sessionID: string;
      messageID: string;
      files: FileDiff[];
      busy: boolean;
    },
    confirm: boolean,
  ): Promise<void> {
    let summary;
    try {
      summary = await this.deps.backend.getSession(overlay.sessionID);
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
    this.storeSessionSummary(summary);
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
      if (confirm) await this.deps.backend.commitRevert(overlay.sessionID);
      else await this.deps.backend.clearRevert(overlay.sessionID);
    } catch (error) {
      this.setState('overlay', (current) =>
        current.kind === 'revert' && current.sessionID === overlay.sessionID
          ? { ...current, busy: false }
          : current,
      );
      this.showNotice(`Revert failed: ${errorText(error)}`, 'error');
      return;
    }
    this.closeOverlay();
    this.showNotice(confirm ? 'Reverted' : 'Revert cancelled; files restored', 'dim');
    if (confirm) void this.track('refresh', this.loadConversation(overlay.sessionID));
  }

  /**
   * Best-effort safe clear of a staged revert when the user is exiting: abandoning the
   * dialog means restoring the files, never leaving the mutation silently staged.
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
      await this.deps.backend.clearRevert(overlay.sessionID);
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

function routeKey(route: Route): string {
  switch (route.kind) {
    case 'overview':
      return 'overview';
    case 'new':
      return `new:${route.directory}`;
    default:
      return route.sessionID;
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

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
