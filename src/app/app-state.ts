import type { PermissionPrompt, QueuedInput, ServerCommand } from '../adapter/backend.ts';
import type { StreamStatus } from '../adapter/event-pump.ts';
import type { AgentDescriptor } from '../domain/agent-cycle.ts';
import type { Composer } from '../domain/composer.ts';
import { emptyComposer } from '../domain/composer.ts';
import type { FormEditor, FormRequest } from '../domain/form.ts';
import type { ModelSelection } from '../domain/model-ref.ts';
import type { CatalogModel } from '../domain/model-resolution.ts';
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
  | { kind: 'form'; sessionID: string; editor: FormEditor };

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
  detailed: boolean;
  /** Rendered node count per session (see `windowNodes`); grows as the user pages up. */
  transcriptWindow: Record<string, number>;
  expandedGroups: Record<string, true>;
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
    answering: false,
    permissionChoice: 0,
    transcripts: {},
    inbox: {},
    agents: [],
    models: [],
    serverCommands: [],
    detailed: false,
    transcriptWindow: {},
    expandedGroups: {},
    composer: { ...emptyComposer },
    drafts: {},
    admitting: false,
    overview: { focus: 'composer', directory, expanded: {} },
    openedAt: {},
    history: createHistory([]),
    recentModels: [],
    exitArmed: false,
    sessionsComplete: false,
  };
}
