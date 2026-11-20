import type { PermissionPrompt, QueuedInput, ServerCommand } from '../adapter/backend.ts';
import type { StreamStatus } from '../adapter/event-pump.ts';
import type { AgentDescriptor } from '../domain/agent-cycle.ts';
import type { Attachment } from '../domain/attachment.ts';
import type { Composer } from '../domain/composer.ts';
import { emptyComposer } from '../domain/composer.ts';
import type { DiffScope, FileDiff } from '../domain/diff.ts';
import type { FormEditor, FormRequest } from '../domain/form.ts';
import type { GoalPlanV1 } from '../domain/goal-plan.ts';
import type { ModelSelection } from '../domain/model-ref.ts';
import type { CatalogModel } from '../domain/model-resolution.ts';
import type { NativeGoalState } from '../domain/native-goal.ts';
import type { PromptHistory } from '../domain/prompt-history.ts';
import { createHistory } from '../domain/prompt-history.ts';
import type { ProjectRef } from '../domain/server-identity.ts';
import { localServerID } from '../domain/server-identity.ts';
import type { SessionSummary } from '../domain/session.ts';
import type { TranscriptMessage } from '../domain/transcript.ts';
import type { WorkerJob } from '../domain/worker.ts';

/**
 * Overview and conversation (ADR-0002), plus `new`: an unsent conversation in a
 * directory. The server session is created only when its first prompt is sent.
 * Dialogs are overlays, never routes.
 */
export type Route =
  | { kind: 'overview' }
  | { kind: 'new'; serverID: string; directory: string }
  | { kind: 'conversation'; serverID: string; sessionID: string };

export type Overlay =
  | { kind: 'none' }
  | { kind: 'help' }
  | { kind: 'usage' }
  | { kind: 'status' }
  | { kind: 'queue'; index: number }
  | { kind: 'model-picker'; query: string; index: number }
  | { kind: 'agent-picker'; query: string; index: number }
  | { kind: 'copy-picker'; query: string; index: number }
  | { kind: 'history-search'; query: string; before: number }
  | { kind: 'servers'; index: number }
  | { kind: 'unpair-confirm'; serverID: string; label: string }
  | { kind: 'form'; sessionID: string; editor: FormEditor }
  | { kind: 'tasks'; index: number; target?: { serverID: string; sessionID: string } }
  | {
      kind: 'rewind-picker';
      serverID: string;
      sessionID: string;
      index: number;
      /** Read-only `session.diff` preview of the selected boundary; not a staged change. */
      files: readonly FileDiff[];
      loading: boolean;
      /** The read-only preview failed; never render an empty result as "no changes". */
      previewUnavailable: boolean;
    }
  | {
      kind: 'revert';
      /** Owning host: two servers can both own the same session ID. */
      serverID: string;
      sessionID: string;
      messageID: string;
      files: FileDiff[];
      busy: boolean;
    }
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
   * What is known about each session's native opencode.goal state. A confirmed absence and
   * a failed read are different states: stale data is retained for display but never drives
   * goal actions. Absent = never read.
   */
  nativeGoals: Record<string, NativeGoalState>;
  /**
   * Frontend-only intent, keyed by session: the goal ID that interrupted with a user
   * Esc/interrupt and now waits for the user's follow-up. Not a goal status; set only by
   * this frontend after a successful interrupt of an active goal.
   */
  awaitingSteer: Record<string, string>;
  /** Cancelled queued messages whose text could not be placed yet; restored with Ctrl+S. */
  recovered: {
    serverID: string;
    sessionID: string;
    inboxID: string;
    text: string;
    attachments?: Attachment[];
  }[];
  /** True while a permission or form reply is in flight; blocks double submits. */
  answering: boolean;
  /** Index of the focused permission choice in the permission card. */
  permissionChoice: number;
  transcripts: Record<string, TranscriptState>;
  /**
   * Client-local "moved to background" status per server-qualified session key.
   * Rendered inside the transcript beside the affected tool, never as a footer notice.
   */
  backgrounded: Record<string, Readonly<{ text: string; toolID?: string }>>;
  /**
   * Server-confirmed subagent jobs per server-qualified session key (#101). Cleared on
   * disconnect so a reattach cannot show a ghost running worker from a stale snapshot.
   */
  workers: Record<string, readonly WorkerJob[]>;
  inbox: Record<string, QueuedInput[]>;
  agents: AgentDescriptor[];
  models: CatalogModel[];
  defaultModel?: ModelSelection;
  serverCommands: ServerCommand[];
  /** Names of the MCP servers the owning host exposes; empty when it offers none. */
  /** Confirmed MCP names indexed by host and canonical project directory. */
  mcpCatalogs: Record<string, Record<string, string[]>>;
  /**
   * Canonical directory key the agents/models/commands above belong to, and whether a
   * fetch is in flight or failed. Consumers must not use another project's catalog.
   */
  catalogDirectory?: string;
  /** Server owning the loaded catalog; catalogs are scoped by server AND directory. */
  catalogServerID?: string;
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
  /** Image/PDF attachments waiting with the current draft; sent as inline prompt files. */
  attachments: Attachment[];
  completion?: Completion;
  drafts: Record<string, Composer>;
  /** Attachments saved with each route's draft. */
  draftAttachments: Record<string, Attachment[]>;
  /** Stashed composer and attachments, scoped to their originating route. */
  stashes: Record<string, { composer: Composer; attachments: Attachment[] } | undefined>;
  admitting: boolean;
  overview: {
    focus: 'list' | 'composer';
    /** Active filter tab over the shared session index. */
    tab: 'all' | 'local' | 'remotes' | 'active' | 'needs-input';
    /** Row key from `overviewRows()`: a session or a Show more/less toggle. */
    selectedRow?: string;
    /** Project groups showing every session instead of the collapsed few. */
    expanded: Record<string, true>;
    /** Owning project for the next session started from the composer. */
    project: ProjectRef;
    agent?: string;
    model?: ModelSelection;
  };
  /** When this frontend last opened each session; counts as use for recency sorting. */
  openedAt: Record<string, number>;
  history: PromptHistory;
  recentModels: ModelSelection[];
  /** Pending confirmation for Ctrl+C / Ctrl+D exit. */
  exitArmed: boolean;
  /**
   * Awaiting rewind confirmation after Esc Esc on an empty, idle composer. No files are
   * mutated until the user confirms; the actual rewind is separate work (issue #102).
   */
  rewindPending: boolean;
  /** False while more session pages exist than were loaded; the overview says so. */
  sessionsComplete: boolean;
  /** Cursor for the next older page of sessions; absent once the server has no more. */
  sessionsCursor?: string;
  /** True while an older sessions page is in flight. */
  sessionsLoading: boolean;
  /** Last failure loading an older page; cleared on success. Retry via loadMoreSessions(). */
  sessionsError?: string;
  /** Independent pagination state per server; one slow host never blocks another. */
  serverPages: Record<
    string,
    Readonly<{ cursor?: string; complete: boolean; loading: boolean; error?: string }>
  >;
};

export function initialState(directory: string, serverID: string = localServerID): AppState {
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
    recovered: [],
    answering: false,
    permissionChoice: 0,
    transcripts: {},
    backgrounded: {},
    workers: {},
    inbox: {},
    agents: [],
    models: [],
    serverCommands: [],
    mcpCatalogs: {},
    catalogLoading: false,
    detailed: false,
    transcriptWindow: {},
    expandedGroups: {},
    expandedDiffs: {},
    composer: { ...emptyComposer },
    attachments: [],
    drafts: {},
    draftAttachments: {},
    stashes: {},
    admitting: false,
    overview: {
      focus: 'composer',
      tab: 'all',
      project: { serverID, directory },
      expanded: {},
    },
    openedAt: {},
    history: createHistory([]),
    recentModels: [],
    exitArmed: false,
    rewindPending: false,
    sessionsComplete: false,
    sessionsLoading: false,
    serverPages: {},
  };
}
