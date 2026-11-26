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
import type { ShellJob } from '../domain/shell-job.ts';
import type { ToolResultPayload, TranscriptMessage } from '../domain/transcript.ts';
import type { WorkerJob } from '../domain/worker.ts';

/** A transient Ctrl+B confirmation bound to one tool call of one session (#135). */
export type BackgroundEvent = Readonly<{
  /** The exact tool call ID from the transcript, never a last-matching-node guess. */
  toolID: string;
  text: string;
}>;

/**
 * Freshness of one session's job list. A failed refresh keeps the last confirmed rows and
 * marks them stale; with nothing retained the list is honestly unavailable (#230). Only a
 * successful empty response is confirmed-empty.
 */
export type JobListStatus = Readonly<{
  state: 'confirmed' | 'stale' | 'unavailable';
  /** Bounded diagnostic from the last failed refresh; cleared on success. */
  detail?: string;
}>;

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
  | { kind: 'help'; offset?: number }
  | { kind: 'usage' }
  | { kind: 'status' }
  | { kind: 'queue'; index: number }
  | { kind: 'model-picker'; query: string; index: number }
  | { kind: 'effort-picker'; query: string; index: number }
  | { kind: 'agent-picker'; query: string; index: number }
  | { kind: 'copy-picker'; query: string; index: number }
  | { kind: 'history-search'; query: string; before: number }
  | { kind: 'servers'; index: number }
  | { kind: 'unpair-confirm'; serverID: string; label: string }
  | {
      kind: 'form';
      serverID: string;
      /** Conversation hosting the card (the form may belong to a global/child session). */
      sessionID: string;
      /** The form's own wire session; replies and cancels must use this exact owner. */
      formSessionID: string;
      /** Canonical location for a `global` form; passed as the owning-location header. */
      formDirectory: string;
      requestToken: number;
      editor: FormEditor;
    }
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
  | DiffOverlay
  | InspectorOverlay;

/** Focused, full-result overlay for one tool part (#222). */
export type InspectorOverlay = {
  kind: 'inspector';
  serverID: string;
  sessionID: string;
  messageID: string;
  toolID: string;
  /** One-line identity, e.g. `bash · make test`. */
  title: string;
  /** Case-insensitive literal search over payload lines; empty shows the document start. */
  query: string;
  /** UTF-16 cursor in `query`, always on a grapheme boundary (#236). */
  queryCursor: number;
  /** True while the search field owns typing; `/` starts it and Esc clears or closes. */
  searching: boolean;
  /** First visible document line (0-based), independent of the conversation scroll. */
  offset: number;
  /** First visible terminal cell (0-based); overlong lines never wrap (#228). */
  column: number;
  loading: boolean;
  /** The payload being shown; cached content until retrieval succeeds. */
  payload?: ToolResultPayload | undefined;
  /** Retrieval failure or fallback reason; shown verbatim, never hidden. */
  error?: string | undefined;
};

/** Read-only viewer over server-reported `session.diff` results. */
export type DiffOverlay = {
  kind: 'diff';
  serverID: string;
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
  /** The last older-history lookahead failed; the cursor is a retry path, not proof (#144). */
  olderCheckFailed?: boolean;
  loading: boolean;
  /** Events arrived while detached; refetch on attach. */
  stale: boolean;
  /**
   * First canonical message index that differs from the previous array (#352). Presentation
   * derives an explicit changed range instead of rediscovering it by identity every frame.
   */
  changedFrom?: number;
};

export type Completion = Readonly<{
  kind: 'command' | 'file';
  items: readonly { label: string; detail: string; insert: string }[];
  index: number;
  /** Replace text[start, cursor) with the chosen item's insert value. */
  start: number;
}>;

/**
 * The reactive snapshot views read. Server-authoritative facts, persisted frontend state
 * and ephemeral UI state share this store, so every record is keyed by a server-qualified
 * identity wherever two hosts can collide: a bare session ID is not an identity.
 *
 * Writes are owned by `AppController` and the capability services it delegates to (#305);
 * views must treat this snapshot as read-only. Derived views (overview groups, transcripts,
 * usage) are cached elsewhere with explicit revisions (#288, #293); changing a field here
 * without its invalidation path is a bug, not a cosmetic detail.
 */
export type AppState = {
  stream: StreamStatus;
  /**
   * Interactive startup progress. `loading` is set synchronously by `bootstrap()`; `ready`
   * means the launch host's catalog and first session page are usable, while paired remote
   * hosts may still be loading in the background (#287).
   */
  startup: {
    phase: 'loading' | 'ready' | 'failed';
    /** Monotonic milliseconds from the process-wide startup clock. */
    startedAt?: number;
    /** The launch host's first session page is displayable; later pages may still load. */
    sessionsReadyAt?: number;
    /** The launch host's catalog (agents/models/commands) is verified. */
    catalogReadyAt?: number;
    /** The launch host's bounded automatic pagination has exhausted or stopped. */
    indexCompleteAt?: number;
    /** Request hydration for known active sessions finished (successfully or not). */
    hydrationReadyAt?: number;
    /** The composer may accept a prompt: catalog plus first session page are available. */
    readyAt?: number;
    detail?: string;
  };
  route: Route;
  overlay: Overlay;
  notice?: Notice;
  sessions: Record<string, SessionSummary>;
  running: Record<string, boolean>;
  permissions: Record<string, PermissionPrompt[]>;
  forms: Record<string, FormRequest[]>;
  /** Per-session input-request fetch failures; absent means both categories are known. */
  requestErrors: Record<string, { permissions?: string; forms?: string }>;
  /**
   * Whether request hydration has completed for a session. Absent means it has never been
   * requested; `loading` must not be rendered as "no pending requests" (#348).
   */
  requestHydration: Record<string, 'loading' | 'ready'>;
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
  /** True while a permission reply is in flight; blocks double submits. */
  answering: boolean;
  /** Index of the focused permission choice in the permission card. */
  permissionChoice: number;
  /**
   * True only after a deliberate focus transition (Enter or an arrow on the card).
   * A newly arrived permission starts unfocused so an unrelated Enter can never approve
   * a request the user has not looked at (#237).
   */
  permissionFocused: boolean;
  transcripts: Record<string, TranscriptState>;
  /**
   * Client-local "moved to background" events per server-qualified session key (#135).
   * Each event is owned by the specific tool call it confirms, so it can never attach to a
   * later, unrelated tool. This is transient call status, cleared on turn completion,
   * disconnect and session removal - never persistent call history.
   */
  backgrounded: Record<string, readonly BackgroundEvent[]>;
  /**
   * Last server-confirmed subagent jobs per server-qualified session key (#101). A failed
   * refresh retains them with `workerStatus` stale instead of claiming they finished (#230).
   */
  workers: Record<string, readonly WorkerJob[]>;
  /** Freshness of `workers` per session key; absent means never confirmed. */
  workerStatus: Record<string, JobListStatus>;
  /** Last server-confirmed shell jobs per session key; a timed-out shell can still run. */
  shellJobs: Record<string, readonly ShellJob[]>;
  /** Freshness of `shellJobs` per session key; absent means never confirmed. */
  shellStatus: Record<string, JobListStatus>;
  inbox: Record<string, QueuedInput[]>;
  /** Primary-selectable agents for Shift+Tab and the picker (hidden/subagent-only excluded). */
  agents: AgentDescriptor[];
  /**
   * Full mention-eligible catalog: every non-hidden agent including subagent-only (#133).
   * Used only for `@name` completion and submission, never for primary selection.
   */
  mentionAgents: AgentDescriptor[];
  models: CatalogModel[];
  defaultModel?: ModelSelection;
  serverCommands: ServerCommand[];
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
  /**
   * How many folded transcript nodes from loaded history are eligible to be mounted, per
   * session (see `windowNodeView`). Grows as the reader pages up. This is a logical node
   * allowance, never a physical-row budget; server history availability lives in the
   * transcript's `olderCursor`.
   */
  transcriptWindow: Record<string, number>;
  expandedGroups: Record<string, true>;
  /** Tool IDs whose oversized inline diffs the user expanded; mirrors expandedGroups. */
  expandedDiffs: Record<string, true>;
  /** Individual tool disclosures opened inside an expanded group (#281). */
  expandedTools: Record<string, true>;
  /** Selected child page per qualified tool ID for dense Code Mode execute calls (#260). */
  childPages: Record<string, number>;
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
  /** Canonical scope of the history bucket currently shown (#160). */
  historyScope?: ProjectRef;
  /** Bumped on every history load so a late admission cannot retarget a newer project (#160). */
  historyGeneration: number;
  recentModels: ModelSelection[];
  /** App-level preference for Margarita's own scrollbars; one value for every view (#330). */
  showScrollbar: boolean;
  /** Explicit pins and last server-confirmed models, keyed by scope (#189, #190). */
  pinnedModels: Record<string, ModelSelection>;
  lastModels: Record<string, ModelSelection>;
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
  /**
   * Paired hosts whose credentials are being restored after the shell mounted (#346).
   * Metadata only: no secret, no session content, and no request issued before the host is
   * actually registered with the connection manager.
   */
  deferredServers: Record<
    string,
    Readonly<{ label: string; baseUrl: string; state: 'restoring' | 'unauthorized' }>
  >;
};

export function initialState(directory: string, serverID: string = localServerID): AppState {
  return {
    stream: 'connecting',
    startup: { phase: 'ready' },
    route: { kind: 'overview' },
    overlay: { kind: 'none' },
    sessions: {},
    running: {},
    permissions: {},
    forms: {},
    requestErrors: {},
    requestHydration: {},
    goals: {},
    nativeGoals: {},
    awaitingSteer: {},
    recovered: [],
    answering: false,
    permissionChoice: 0,
    permissionFocused: false,
    transcripts: {},
    backgrounded: {},
    workers: {},
    workerStatus: {},
    shellJobs: {},
    shellStatus: {},
    inbox: {},
    agents: [],
    mentionAgents: [],
    models: [],
    serverCommands: [],
    mcpCatalogs: {},
    catalogLoading: false,
    detailed: false,
    transcriptWindow: {},
    expandedGroups: {},
    expandedDiffs: {},
    expandedTools: {},
    childPages: {},
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
    historyScope: { serverID, directory },
    historyGeneration: 0,
    recentModels: [],
    showScrollbar: true,
    pinnedModels: {},
    lastModels: {},
    exitArmed: false,
    rewindPending: false,
    sessionsComplete: false,
    sessionsLoading: false,
    serverPages: {},
    deferredServers: {},
  };
}
