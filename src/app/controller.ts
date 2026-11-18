import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { batch } from 'solid-js';
import { createStore, produce, type SetStoreFunction } from 'solid-js/store';

import {
  type Backend,
  BackendError,
  type Delivery,
  type PermissionDecision,
  type PromptFile,
} from '../adapter/backend.ts';
import type { StreamStatus } from '../adapter/event-pump.ts';
import type { AppConfig } from '../config/config.ts';
import type { LocalState } from '../config/local-state.ts';
import { defaultAgent, nextAgent, selectableAgents } from '../domain/agent-cycle.ts';
import type { BackendEvent } from '../domain/backend-event.ts';
import { type Composer, composerFrom, emptyComposer } from '../domain/composer.ts';
import { projectExecution } from '../domain/execution.ts';
import { activeMention, findFileMentions, rankPaths } from '../domain/file-reference.ts';
import { formatModelRef, type ModelSelection, sameModel } from '../domain/model-ref.ts';
import { resolveModel } from '../domain/model-resolution.ts';
import {
  groupRows,
  groupSessions,
  type OverviewRow,
  type ProjectGroup,
} from '../domain/overview-groups.ts';
import { directoryKey } from '../domain/path-identity.ts';
import {
  createHistory,
  historyBack,
  historyForward,
  recordEntry,
  searchHistory,
} from '../domain/prompt-history.ts';
import type { Execution, SessionSummary } from '../domain/session.ts';
import { completeCommand, type LocalCommandName, parseInput } from '../domain/slash-command.ts';
import { type TranscriptMessage, transcriptWindowStep } from '../domain/transcript.ts';
import { type AppState, initialState, type Overlay, type Route } from './app-state.ts';

export type ControllerDeps = Readonly<{
  backend: Backend;
  config: AppConfig;
  localState: LocalState;
  platform: NodeJS.Platform;
  cwd: string;
  version: string;
  now: () => number;
  saveLocalState: (state: LocalState) => Promise<void>;
  listFiles: (root: string) => Promise<string[]>;
  requestExit: () => void;
}>;

const transcriptPageSize = 120;
const transcriptCacheLimit = 8;
const sessionPageLimit = 5;

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
  private fileCache: { root: string; files: string[] } | undefined;
  private disposed = false;
  private persisted: LocalState;

  constructor(private readonly deps: ControllerDeps) {
    const [state, setState] = createStore<AppState>(initialState(deps.cwd));
    this.state = state;
    this.setState = setState;
    this.persisted = deps.localState;
    setState('recentModels', [...deps.localState.recentModels]);
    this.loadHistoryFor(deps.cwd);
  }

  dispose(): void {
    this.disposed = true;
    if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer);
    for (const timer of this.summaryTimers.values()) clearTimeout(timer);
    this.summaryTimers.clear();
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
      formCount: this.state.forms[sessionID] ?? 0,
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
    return this.groups().flatMap((group) =>
      groupRows(group, this.state.overview.expanded[group.key] === true),
    );
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

  async loadCatalog(directory: string): Promise<void> {
    const [agents, models, fallback, commands] = await Promise.all([
      this.deps.backend.listAgents(directory),
      this.deps.backend.listModels(directory),
      this.deps.backend.defaultModel(directory),
      this.deps.backend.listCommands(directory).catch(() => []),
    ]);
    batch(() => {
      this.setState('agents', selectableAgents(agents, this.deps.config.agents.cycle));
      this.setState('models', models);
      this.setState('defaultModel', fallback);
      this.setState('serverCommands', commands);
    });
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
      this.setState('sessions', Object.fromEntries(loaded.map((session) => [session.id, session])));
      this.setState('sessionsComplete', cursor === undefined);
      this.setState('running', Object.fromEntries([...active].map((id) => [id, true])));
    });
    // Running sessions are the ones that can be blocked on input right now.
    await Promise.all([...active].map((id) => this.refreshInputRequests(id)));
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
    this.setState('stream', status);
    if (status === 'reconnecting') this.showNotice('Connection lost · retrying', 'warn', false);
  }

  onEvents(events: readonly BackendEvent[], resync: boolean): void {
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
      this.setState('sessions', sessionID, session);
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
      this.deps.backend.countForms(sessionID),
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
    this.saveDraft();
    const transcript = this.state.transcripts[sessionID];
    batch(() => {
      this.setState('route', { kind: 'conversation', sessionID });
      this.setState('overlay', { kind: 'none' });
      this.setState('completion', undefined);
      this.setState('permissionChoice', 0);
      this.setState('openedAt', sessionID, this.deps.now());
      this.writeComposer(this.state.drafts[sessionID] ?? emptyComposer);
      if (transcript === undefined) {
        this.setState('transcripts', sessionID, { messages: [], loading: true, stale: false });
      }
    });
    const directory = this.state.sessions[sessionID]?.directory;
    if (directory !== undefined) this.loadHistoryFor(directory);
    void this.track('attach', this.loadConversation(sessionID));
  }

  /**
   * An unsent conversation in `directory`. Nothing is created on the server until the
   * first prompt is submitted, so opening margarita never leaves empty sessions behind.
   */
  startNewSession(directory: string): void {
    this.saveDraft();
    batch(() => {
      this.setState('route', { kind: 'new', directory });
      this.setState('overlay', { kind: 'none' });
      this.setState('completion', undefined);
      this.setState('overview', 'directory', directory);
      this.writeComposer(this.state.drafts[`new:${directory}`] ?? emptyComposer);
    });
    this.loadHistoryFor(directory);
  }

  /**
   * View change only: the session keeps running on the server. The cursor starts on
   * the first row; typing still goes straight to the new-session prompt.
   */
  openOverview(): void {
    this.saveDraft();
    const directory = this.currentDirectory();
    batch(() => {
      this.setState('route', { kind: 'overview' });
      this.setState('overlay', { kind: 'none' });
      this.setState('completion', undefined);
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
        : this.groups().find((group) => group.key === row.groupKey)?.directory;
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

  /** Enter on a row: attach a session, or expand/collapse a project inline. */
  attachSelected(): void {
    const row = this.selectedOverviewRow();
    if (row === undefined) return;
    if (row.kind === 'toggle') {
      this.toggleOverviewGroup(row.groupKey);
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
      if (this.state.history.index !== undefined) {
        this.setState('history', { entries: this.state.history.entries, savedDraft: '' });
      }
    });
    this.updateCompletion();
  }

  private updateCompletion(): void {
    const { text, cursor } = this.state.composer;
    if (text.startsWith('/') && !/\s/.test(text)) {
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
    const root = this.currentDirectory();
    if (this.fileCache?.root !== root) {
      this.fileCache = { root, files: await this.deps.listFiles(root) };
    }
    const mention = activeMention(this.state.composer.text, this.state.composer.cursor);
    if (mention === undefined || mention.start !== start) return; // composer moved on
    const items = rankPaths(this.fileCache.files, partial, 8).map((path) => ({
      label: `@${path}`,
      detail: '',
      insert: `@${path} `,
    }));
    this.setState(
      'completion',
      items.length === 0 ? undefined : { kind: 'file', items, index: 0, start },
    );
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
    this.setState('history', createHistory(this.deps.localState.history[key] ?? []));
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
    await this.admit(text, directory, async () => {
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
    });
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
  ): Promise<boolean> {
    this.setState('admitting', true);
    try {
      await send();
      this.rememberPrompt(text, directory);
      this.clearComposer(text);
      return true;
    } catch (error) {
      if (error instanceof BackendError && error.kind === 'transport') {
        // The POST may have landed. Show server state instead of resending blindly.
        this.showNotice(
          'Delivery unknown (connection problem). Check the transcript before resending.',
          'error',
        );
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
      });
    }
  }

  private async resolveFiles(text: string, directory: string): Promise<PromptFile[]> {
    const files: PromptFile[] = [];
    for (const mention of findFileMentions(text)) {
      const path = isAbsolute(mention.path) ? mention.path : resolve(directory, mention.path);
      if (!(await Bun.file(path).exists())) continue;
      files.push({
        uri: pathToFileURL(path).href,
        name: mention.path,
        start: mention.start,
        end: mention.end,
        text: mention.text,
      });
    }
    return files;
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
    } catch (error) {
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

  /** Sends a prompt to an existing session (CLI `--continue/--resume "prompt"`). */
  async sendToSession(sessionID: string, text: string): Promise<boolean> {
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
        if (args === '') this.openModelPicker();
        else await this.setModelFromRef(args);
        return;
      case 'effort':
        await this.setEffort(args);
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

  openModelPicker(): void {
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
    const resolved = resolveModel({ model: ref }, this.state.models);
    if (resolved.kind === 'error') {
      this.showNotice(resolved.message, 'warn');
      return;
    }
    if (resolved.kind === 'resolved') await this.setModel(resolved.model);
  }

  private async setEffort(variant: string): Promise<void> {
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
      this.showNotice(interrupted ? 'Interrupted' : 'Nothing was running', 'dim');
    } catch (error) {
      this.showNotice(errorText(error), 'error');
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
    const item = (this.state.inbox[session.id] ?? []).find((entry) => entry.id === inboxID);
    try {
      await this.deps.backend.cancelQueued(session.id, inboxID);
      // The server cannot edit queued text; restore it to the composer instead.
      if (item !== undefined && this.state.composer.text === '') {
        this.writeComposer(composerFrom(item.text));
      }
    } catch (error) {
      if (
        error instanceof BackendError &&
        (error.kind === 'not-found' || error.kind === 'conflict')
      ) {
        this.showNotice('Already delivered; it could not be cancelled.', 'warn');
      } else {
        this.showNotice(errorText(error), 'error');
      }
    }
    await this.refreshInbox(session.id);
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
    if (pending === undefined) return;
    const choice = decision ?? this.permissionChoices()[this.state.permissionChoice] ?? 'reject';
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
    await this.refreshInputRequests(pending.sessionID);
  }

  // ---------------------------------------------------------------- presentation

  toggleDetails(): void {
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
    void this.track('save', this.deps.saveLocalState(this.persisted));
  }

  /** Every background promise ends here: failures become visible notices, never silence. */
  private async track(label: string, work: Promise<unknown>): Promise<void> {
    try {
      await work;
    } catch (error) {
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
