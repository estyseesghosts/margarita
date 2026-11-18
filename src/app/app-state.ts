import type { PermissionPrompt, QueuedInput, ServerCommand } from '../adapter/backend.ts';
import type { StreamStatus } from '../adapter/event-pump.ts';
import type { AgentDescriptor } from '../domain/agent-cycle.ts';
import type { Composer } from '../domain/composer.ts';
import { emptyComposer } from '../domain/composer.ts';
import type { DiffScope, FileDiff } from '../domain/diff.ts';
import type { FormEditor, FormRequest } from '../domain/form.ts';
import type { GoalPlanV1 } from '../domain/goal-plan.ts';
import type { ModelSelection } from '../domain/model-ref.ts';
import type { CatalogModel } from '../domain/model-resolution.ts';
import type { NativeGoal } from '../domain/native-goal.ts';
import type { PromptHistory } from '../domain/prompt-history.ts';
import { createHistory } from '../domain/prompt-history.ts';
import type { SessionSummary } from '../domain/session.ts';
import type { TranscriptMessage } from '../domain/transcript.ts';

/**
 * Overview and conversation (ADR-0002), plus `new`: an unsent conversation in a
 * directory. The server session is created only when its first prompt is sent.
 * Dialogs are overlays, never routes.
 */
export type Route =
  | { kind: 'overview' }
  | { kind: 'new'; directory: string }
  | { kind: 'conversation'; sessionID: string };

export type Overlay =
  | { kind: 'none' }
  | { kind: 'help' }
  | { kind: 'usage' }
  | { kind: 'status' }
  | { kind: 'queue'; index: number }
  | { kind: 'model-picker'; query: string; index: number }
  | { kind: 'history-search'; query: string; before: number }
  | { kind: 'form'; sessionID: string; editor: FormEditor }
  | { kind: 'tasks'; index: number }
  | { kind: 'revert'; sessionID: string; messageID: string; files: FileDiff[]; busy: boolean }
  | DiffOverlay;

/** Read-only viewer over server-reported `session.diff` results. */
export type DiffOverlay = {
  kind: 'diff';
  sessionID: string;
  scope: DiffScope;
  loading: boolean;
  files: FileDiff[];
  index: number;
  /** Showing one file's patch instead of the file list. */
  open: boolean;
  offset: number;
  error?: string;
};

export type Notice = Readonly<{ text: string; tone: 'dim' | 'warn' | 'error'; id: number }>;

export type TranscriptState = {
  messages: TranscriptMessage[];
  olderCursor?: string;
  loading: boolean;
  /** Events arrived while detached; refetch on attach. */
  stale: boolean;
};

export type Completion = Readonly<{
  kind: 'command' | 'file';
  items: readonly { label: string; detail: string; insert: string }[];
  index: number;
  /** Replace text[start, cursor) with the chosen item's insert value. */
  start: number;
}>;

export type AppState = {
  stream: StreamStatus;
  route: Route;
  overlay: Overlay;
  notice?: Notice;
  sessions: Record<string, SessionSummary>;
  running: Record<string, boolean>;
  permissions: Record<string, PermissionPrompt[]>;
  forms: Record<string, FormRequest[]>;
  /** Goal/plan sidecar per session; absent until loaded. */
  goals: Record<string, GoalPlanV1>;
  /**
   * The session's native opencode.goal plugin state, as last read from the plugin
   * (undefined = not fetched yet, null = no goal set). Authoritative over any local memory.
   */
  nativeGoals: Record<string, NativeGoal | null | undefined>;
  /**
   * Frontend-only intent, keyed by session: the goal ID that interrupted with a user
   * Esc/interrupt and now waits for the user's follow-up. Not a goal status; set only by
   * this frontend after a successful interrupt of an active goal.
   */
  awaitingSteer: Record<string, string>;
  /** True while a permission or form reply is in flight; blocks double submits. */
  answering: boolean;
  /** Index of the focused permission choice in the permission card. */
  permissionChoice: number;
  transcripts: Record<string, TranscriptState>;
  inbox: Record<string, QueuedInput[]>;
  agents: AgentDescriptor[];
  models: CatalogModel[];
  defaultModel?: ModelSelection;
  serverCommands: ServerCommand[];
  /**
   * Canonical directory key the agents/models/commands above belong to, and whether a
   * fetch is in flight or failed. Consumers must not use another project's catalog.
   */
  catalogDirectory?: string;
  catalogLoading: boolean;
  catalogError?: string;
  detailed: boolean;
  /** Rendered node count per session (see `windowNodes`); grows as the user pages up. */
  transcriptWindow: Record<string, number>;
  expandedGroups: Record<string, true>;
  /** Tool IDs whose oversized inline diffs the user expanded; mirrors expandedGroups. */
  expandedDiffs: Record<string, true>;
  /** Group key of the tool group selected for per-group toggle; absent when composer has focus. */
  focusedGroup?: string;
  composer: Composer;
  completion?: Completion;
  drafts: Record<string, Composer>;
  stash?: string;
  admitting: boolean;
  overview: {
    focus: 'list' | 'composer';
    /** Row key from `overviewRows()`: a session or a Show more/less toggle. */
    selectedRow?: string;
    /** Project groups showing every session instead of the collapsed few. */
    expanded: Record<string, true>;
    directory: string;
    agent?: string;
    model?: ModelSelection;
  };
  /** When this frontend last opened each session; counts as use for recency sorting. */
  openedAt: Record<string, number>;
  history: PromptHistory;
  recentModels: ModelSelection[];
  /** Pending confirmation for Ctrl+C / Ctrl+D exit. */
  exitArmed: boolean;
  /** False while more session pages exist than were loaded; the overview says so. */
  sessionsComplete: boolean;
  /** Cursor for the next older page of sessions; absent once the server has no more. */
  sessionsCursor?: string;
  /** True while an older sessions page is in flight. */
  sessionsLoading: boolean;
  /** Last failure loading an older page; cleared on success. Retry via loadMoreSessions(). */
  sessionsError?: string;
};

export function initialState(directory: string): AppState {
  return {
    stream: 'connecting',
    route: { kind: 'overview' },
    overlay: { kind: 'none' },
    sessions: {},
    running: {},
    permissions: {},
    forms: {},
    goals: {},
    nativeGoals: {},
    awaitingSteer: {},
    answering: false,
    permissionChoice: 0,
    transcripts: {},
    inbox: {},
    agents: [],
    models: [],
    serverCommands: [],
    catalogLoading: false,
    detailed: false,
    transcriptWindow: {},
    expandedGroups: {},
    expandedDiffs: {},
    composer: { ...emptyComposer },
    drafts: {},
    admitting: false,
    overview: { focus: 'composer', directory, expanded: {} },
    openedAt: {},
    history: createHistory([]),
    recentModels: [],
    exitArmed: false,
    sessionsComplete: false,
    sessionsLoading: false,
  };
}
