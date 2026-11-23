import { isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

import { batch } from 'solid-js';
import { createStore, produce, reconcile, type SetStoreFunction, unwrap } from 'solid-js/store';

import {
  type Backend,
  BackendError,
  type Delivery,
  type DiffRange,
  type MessagePage,
  type PermissionDecision,
  type PromptFile,
  type QueuedInput,
} from '../adapter/backend.ts';
import type { StreamStatus } from '../adapter/event-pump.ts';
import { nextQueuedUser } from '../adapter/wire-mapping.ts';
import type { AppConfig } from '../config/config.ts';
import { GoalConflictError, type GoalStore, memoryGoalStore } from '../config/goal-store.ts';
import type { LocalState, PinnedModelOperation, SaveResult } from '../config/local-state.ts';
import {
  type AgentDescriptor,
  defaultAgent,
  filterAgents,
  mentionableAgents,
  nextAgent,
  selectableAgents,
} from '../domain/agent-cycle.ts';
import {
  type Attachment,
  attachmentLimitBytes,
  attachmentMimeForName,
  attachmentPromptFile,
  detectAttachmentMime,
  isBinaryPdfPayload,
  isSupportedAttachmentMime,
  makeAttachment,
  pastedAttachmentName,
  splitPastedPaths,
} from '../domain/attachment.ts';
import type { BackendEvent } from '../domain/backend-event.ts';
import {
  type Composer,
  composerFrom,
  deleteBackward,
  deleteForward,
  emptyComposer,
  insertText,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  restoreComposer,
} from '../domain/composer.ts';
import { type Copyable, copyableFromMessages } from '../domain/copyable.ts';
import { type DiffScope, type FileDiff, patchLinesFor, turnStart } from '../domain/diff.ts';
import { hasOversizedDiff, isEditLike } from '../domain/edit-diff.ts';
import { projectExecution } from '../domain/execution.ts';
import {
  activeMention,
  agentMentions,
  findFileMentions,
  isBareAgentNameMention,
  rankPaths,
  withLineRange,
} from '../domain/file-reference.ts';
import { type FooterAction } from '../domain/footer.ts';
import {
  buildAnswer,
  currentField,
  editorKey,
  type FormKey,
  type FormRequest,
  multiChoices,
  pasteFormText,
  startEditor,
  toggleOption,
  visibleFields,
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
import {
  type InspectorIndex,
  inspectorText,
  inspectorWindow,
  nextMatch,
} from '../domain/inspector.ts';
import {
  defaultVariant,
  effectiveVariant,
  formatModelRef,
  type ModelSelection,
  normalizeModel,
  sameModel,
} from '../domain/model-ref.ts';
import {
  type CatalogModel,
  type EffectiveModel,
  isModelAvailable,
  resolveEffectiveModel,
  resolveModel,
} from '../domain/model-resolution.ts';
import { sortModelCatalogForPicker } from '../domain/model-sort.ts';
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
import { type RewindCandidate, rewindCandidates } from '../domain/rewind.ts';
import { sanitizeTerminalText } from '../domain/sanitize-text.ts';
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
  type ShellBackgroundState,
  shellBackgroundState as projectShellBackgroundState,
} from '../domain/shell-job.ts';
import {
  completeCommand,
  isLocalCommand,
  type LocalCommandName,
  parseInput,
} from '../domain/slash-command.ts';
import { pagedToolChildren, toolChildBudget } from '../domain/tool-children.ts';
import {
  cachedToolResult,
  completenessLabel,
  findToolMessage,
  foldTranscript,
  type ToolCall,
  type TranscriptMessage,
  type TranscriptNode,
  transcriptWindowStep,
} from '../domain/transcript.ts';
import type { UsageAnalytics } from '../domain/usage-analytics.ts';
import { type WorkerNode, workerNodes } from '../domain/worker.ts';
import { approximateTranscriptBytes } from '../perf/memory.ts';
import { AdmissionGate } from './admission-gate.ts';
import { AncestryVerifier, type DescendantCheck } from './ancestry-verifier.ts';
import {
  type AppState,
  type BackgroundEvent,
  type DiffOverlay,
  initialState,
  type JobListStatus,
  type Overlay,
  type Route,
} from './app-state.ts';
import { type DebugLog, noDebugLog } from './debug-log.ts';
import { descendantScope } from './descendant-scope.ts';
import { DraftRegistry } from './draft-registry.ts';
import { EditHistory } from './edit-history.ts';
import { errorText, refreshOutcome } from './error-text.ts';
import { admitEvent, type EventCommand } from './event-admission.ts';
import { GoalRevisionGuard } from './goal-revision-guard.ts';
import { GreetingSelector } from './greeting-selector.ts';
import { healthCommands, HostSessionIndex, type HostStreamCommand } from './host-session-index.ts';
import { InspectorDocumentCache } from './inspector-document.ts';
import { applyPin, modelScope } from './model-pins.ts';
import { openExternalUrl, type OpenUrlResult, parseExternalUrl } from './open-url.ts';
import { OverviewProjection } from './overview-projection.ts';
import { PersistenceCoordinator } from './persistence-coordinator.ts';
import { RefreshGenerations } from './refresh-generations.ts';
import { type RequestInboxCommand, RequestInboxCoordinator } from './request-inbox-coordinator.ts';
import { inputRequestRefreshTargets } from './request-targets.ts';
import { attachedSessionFor, routeServerFor } from './route-server.ts';
import { SessionFetcher } from './session-fetch.ts';
import { mergeCommittedSessions, sessionFlags, sessionPage } from './session-snapshot.ts';
import {
  admissionBlock,
  type AdmissionCommand,
  classifySendError,
  composerClearance,
  isOriginRoute,
  resolveAdmission,
  type SendOutcome,
} from './submission-admission.ts';
import { planTranscriptEviction } from './transcript-eviction.ts';
import { TranscriptFlightTracker } from './transcript-flight.ts';
import {
  classifyTranscriptFailure,
  planResyncStaleFlags,
  type TranscriptFailureCommand,
} from './transcript-freshness.ts';
import { TranscriptGenerations } from './transcript-generations.ts';
import {
  retryDelay,
  transcriptFailureRetryable,
  transcriptRetryBaseDelayMs,
  TranscriptRetryTracker,
} from './transcript-retry.ts';
import { UsageAnalyticsSelector } from './usage-selector.ts';

/**
 * A catalog confirmed for one exact `(server, canonical directory)` scope (#134). Both agent
 * lists are captured together at load time so completion and submission resolve `@name` against
 * the same verified snapshot, never the mutable global UI state that may describe another
 * project while a load is in flight.
 */
type CatalogSnapshot = Readonly<{
  selectable: readonly AgentDescriptor[];
  mentionable: readonly AgentDescriptor[];
  mentionIDs: ReadonlySet<string>;
  models: readonly CatalogModel[];
}>;

/**
 * The single source of truth for which overlay each footer control owns. A second click on
 * the same control toggles that exact overlay shut; every other overlay stays guarded (#139).
 */
const footerOverlay: Readonly<Record<FooterAction, Overlay['kind']>> = {
  agent: 'agent-picker',
  model: 'model-picker',
  context: 'usage',
};

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

/** Where a copy operation actually landed; the UI always reports this truthfully. */
export type CopyResult = Readonly<{ method: 'clipboard' | 'file'; path?: string }>;

/**
 * A local project listing plus whether the scan covered the whole tree. `detail` is a
 * user-facing, path-redacted reason for incompleteness (#300).
 */
export type ProjectFileListing = Readonly<{
  files: readonly string[];
  complete: boolean;
  detail?: string;
}>;

/**
 * Route/draft identity captured before suspending the renderer for the external editor
 * (#271). Applying a late result is allowed only while this owner and draft still match.
 */
export type ExternalEditOrigin = Readonly<{
  routeKey: string;
  kind: Route['kind'];
  label: string;
  serverID?: string;
  sessionID?: string;
  /** Session lifetime at capture; a deleted/recreated ID rejects the result. */
  epoch?: number;
  text: string;
  cursor: number;
  attachmentIDs: readonly string[];
  revision: number;
}>;

export type UnpairOutcome = Readonly<{
  credentialCleanup: 'done' | 'pending';
  error?: string;
}>;

export type ServerAdmin = Readonly<{
  list(): readonly ServerListing[];
  rename(serverID: string, label: string): Promise<readonly ServerListing[]>;
  /**
   * Forgets the server and its local credentials; never stops remote work. Rejects only when
   * the profile was NOT removed. A removed profile whose secret cleanup failed resolves with
   * `credentialCleanup: 'pending'` (retry is queued durably).
   */
  unpair(serverID: string): Promise<UnpairOutcome | void>;
}>;

/**
 * Everything the composition root injects into `AppController`: backend access, config
 * and storage, platform facts, and the few side effects (clipboard, files, URLs) the
 * frontend cannot perform itself. Injecting them keeps clocks, storage and transport
 * replaceable in tests; the controller never constructs those services itself.
 *
 * Optional fields have conservative defaults for tests (in-memory goal store, silent
 * debug log, explicit copy fallback file). Production assembly supplies real implementations.
 */
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
  /** Local launch directory, distinct from a remote server's project directory. */
  clientCwd?: string;
  version: string;
  now: () => number;
  saveLocalState: (state: LocalState) => Promise<SaveResult | void>;
  /**
   * Local project listing. A plain string array is treated as a complete authoritative scan;
   * a listing carries completeness so the controller can keep partial candidates retryable
   * instead of caching them forever (#300).
   */
  listFiles: (root: string) => Promise<string[] | ProjectFileListing>;
  /**
   * True when the connection has no shared filesystem with the server (explicit remote
   * URL). Remote mentions are resolved via the server's file APIs instead of Bun.file.
   */
  remoteFilesystem?: boolean;
  requestExit: () => void;
  /** Writes an exported file; defaults to Bun.write. */
  writeFile?: (path: string, text: string) => Promise<void>;
  /**
   * Copies exact text to the terminal clipboard (OSC52). The default writes a local file so
   * copy always has an explicit, visible fallback when the terminal cannot receive OSC52.
   */
  copyText?: (text: string) => Promise<CopyResult>;
  /** Client-local directory for copy fallback files; never derived from a remote cwd (#153). */
  copyFallbackDir?: string;
  /** Opens an explicitly validated http(s) URL in the client's browser (#233). */
  openUrl?: (url: URL) => Promise<OpenUrlResult>;
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
  /**
   * Approximate retained-byte budget for inactive transcript caches (#289). The active
   * route's transcript and any in-flight read are never evicted by bytes.
   */
  transcriptCacheBytes?: number;
  /** Per-child ownership-check timeout while refreshing input requests (#294). */
  ancestryVerifyTimeoutMs?: number;
  /** Base backoff for a failed canonical transcript refetch (#295); tests shrink it. */
  transcriptRetryBaseDelayMs?: number;
}>;

const transcriptPageSize = 120;
const transcriptCacheLimit = 8;
/** A failed canonical refetch retries a bounded number of times with exponential delay (#295). */
/** Default retained-history budget; summaries and drafts live outside this cache. */
const transcriptCacheByteLimit = 32 * 1024 * 1024;
const sessionPageLimit = 5;
const reconcileConcurrency = 8;
/** Ownership checks for uncached child questions run after confirmed data is published (#294). */
const ancestryVerifyConcurrency = 4;
const ancestryVerifyTimeoutMs = 2_000;
const ancestryVerifyBudgetMs = 4_000;
/**
 * Partial @file scans stay usable but are not authoritative forever. Retry delays grow so
 * persistent EACCES/deadline failures do not scan once per keystroke (#300).
 */
const incompleteFileRetryBaseMs = 2_000;
const incompleteFileRetryMaxMs = 60_000;
/** One delayed job-list probe after a tool call, to catch asynchronous job registration. */
const jobStartProbeDelayMs = 300;
const exportPageSize = 500;
/** Lines a diff patch scrolls per PageUp/PageDown; matches the rendered window. */
export const diffPageLines = 18;

/**
 * A session handed to a CLI-facing operation is either a legacy bare ID (resolved against
 * the active host) or a server-qualified ref. New callers pass the ref so the owning host is
 * never lost; old callers and tests keep working with a string (#149).
 */
type SessionTarget = string | SessionRef;

function sessionRefOf(target: SessionTarget, defaultServerID: string): SessionRef {
  return typeof target === 'string' ? { serverID: defaultServerID, sessionID: target } : target;
}

/** Identity and server timestamp of the newest agent-bearing transcript message. */
type TranscriptAgentMark = Readonly<{ id: string; createdAt: number }>;

/**
 * One session's accepted agent value plus the transcript evidence already accounted for.
 * `observedAt` is only consulted when no transcript was loaded at acceptance, so a stale
 * message fetched later cannot displace a freshly confirmed local switch.
 */
type AgentEvidence = Readonly<{
  agent: string;
  transcript?: TranscriptAgentMark;
  observedAt: number;
}>;

/** Pause reason the goal plugin records when the user interrupts a running goal. */
const stoppedByUserReason = 'Stopped by the user';

/**
 * The application facade: owns interactive state and the server interactions that feed
 * it. Views read `state` and call methods instead of talking to the backend. Leaving a
 * session is a pure view change: nothing here calls interrupt/background/delete on
 * navigation.
 *
 * During the ownership migration (#305) this class also forwards to capability services.
 * Callers should use the operations and read-only views it exposes, not its internal maps,
 * generations or timers; those owners move as capabilities are extracted. Construct one
 * instance per client, call `dispose()` to release owned timers, and `flushLocalState()`
 * before exit so queued saves are not lost.
 */
export class AppController {
  readonly state: AppState;
  private readonly setState: SetStoreFunction<AppState>;
  /** Explicitly invalidating store write; same typed surface, chosen only at overview inputs. */
  private readonly setStateTouchingOverview: SetStoreFunction<AppState>;
  /** Guards read-only rewind previews against late replies for a previously selected row. */
  private rewindPreviewSeq = 0;
  private diffRequestSeq = 0;
  private readonly pendingCompactions = new Set<string>();
  /** Changes whenever navigation or a modal interaction can supersede a pending fork. */
  private interactionGeneration = 0;
  private noticeCounter = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Timestamp (ms, from `deps.now`) of the most recent idle Escape tap, for double-tap detection. */
  private escapeAt: number | undefined;
  private escapeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Sole owner of single-flight reads and coalesced dirty hints (#309). */
  private readonly transcriptFlights = new TranscriptFlightTracker();
  /** Bounded retry state for a failed canonical refetch (#295). */
  private readonly transcriptRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Sole owner of bounded transcript retry attempts (#309). */
  private readonly transcriptRetries = new TranscriptRetryTracker();
  /**
   * Admission/commit order for canonical transcript reads (#262). Concurrent reads for one
   * server-qualified session are legitimate, but a slower older response must never replace
   * a newer committed page. The counter is monotonic for the process lifetime; the map keeps
   * the newest committed generation per session.
   */
  /** Sole owner of transcript read generations and commit watermarks (#309). */
  private readonly transcriptGenerations = new TranscriptGenerations();
  /**
   * Admission order for `session.get` summary reads (#263). The newest admitted read wins:
   * an older response that resolves later is dropped instead of overwriting a fresher
   * title, usage, agent or revert state.
   */
  private summaryReadSeq = 0;
  private readonly summaryAdmitted = new Map<string, number>();
  /** Sole owner of refresh/session/event generations (#308). */
  private readonly generations = new RefreshGenerations();
  /** Sole owner of paged index reads and definite-not-found reconciliation (#308). */
  private readonly sessionFetcher: SessionFetcher;
  private readonly summaryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private transcriptOrder: string[] = [];
  /** Sole owner of per-host stream status and index health reporting (#308). */
  private readonly hostStreams = new HostSessionIndex();
  private readonly modelSwitches = new Map<string, Promise<boolean>>();
  private readonly failedModelSwitches = new Set<string>();
  private readonly modelSwitchRevisions = new Map<string, number>();
  /** Per server-qualified session agent switches, serialized with revision checks (#132). */
  private readonly agentSwitches = new Map<string, Promise<boolean>>();
  private readonly failedAgentSwitches = new Set<string>();
  /**
   * Last accepted agent evidence per session with the transcript watermark it superseded.
   * A local acknowledgement outranks every transcript message already loaded; a later
   * server message (for example a switch made in another client) outranks the local value
   * (#225, #253). Evidence and its watermark are stored together so a newer message can
   * never be rejected merely because the summary omitted `agent`.
   */
  private readonly confirmedAgents = new Map<string, AgentEvidence>();
  /** Sole owner of in-flight prompt admissions per server-qualified session (#312). */
  private readonly admissions = new AdmissionGate();
  /** Each open form has a unique token, and replies are guarded per server/session/form. */
  private formToken = 0;
  private readonly answeringForms = new Set<string>();
  /** Sole owner of request refresh revisions and both publication batches (#310). */
  private readonly inbox: RequestInboxCoordinator;
  /** Last killed composer text for Ctrl+Y; each kill replaces it (documented policy). */
  private killBuffer = '';
  /** Sole owner of stable greeting selection (#318); process-lifetime only. */
  private readonly greetings = new GreetingSelector();
  /** Sole owner of bounded route-scoped undo/redo history (#311). */
  private readonly editHistory = new EditHistory();
  /** Sole owner of the memoized inspector document (#315). */
  private readonly inspectorCache = new InspectorDocumentCache();
  /**
   * Reactive invalidation clock for overview projections (#288, #293). The getters read the
   * accessor, so a mounted Solid observer subscribes to invalidation itself rather than only
   * to the session fields touched during a cache miss. Writes bump it in the same batch as
   * the store update.
   */
  private readonly overview: OverviewProjection;
  /** Sole owner of the analytics projection cache (#316/#318). */
  private readonly usageAnalyticsSelector = new UsageAnalyticsSelector();
  /** Single-flight coalescing for worker/shell refreshes (#284). */
  private readonly jobRefreshes = new Map<string, Promise<void>>();
  private readonly jobRefreshDirty = new Set<string>();
  private readonly jobStartProbes = new Map<string, ReturnType<typeof setTimeout>>();
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
  private fileCache:
    | {
        key: string;
        files: string[];
        complete: boolean;
        scannedAt: number;
        failures: number;
        detail?: string;
      }
    | undefined;
  private readonly fileScans = new Map<string, Promise<ProjectFileListing>>();
  private completionRequest = 0;
  /** Bumped whenever the completion context changes (route, project, tab or server), so an
   * in-flight file scan can be rejected even when its directory string and mention did not. */
  private completionGeneration = 0;
  private disposed = false;
  /** Sole owner of staged local-state snapshots and serialized writes (#317). */
  private readonly persistence: PersistenceCoordinator;
  /** Sole owner of route keys and per-route draft revisions (#311). */
  private readonly drafts: DraftRegistry;
  private editorRecoverySeq = 0;
  /** Canonical per-scope pin operations, kept in sync with the latest merged disk state. */
  private pinOperations: Readonly<Record<string, PinnedModelOperation>>;
  /** In-flight pastes, serialized in arrival order so a route switch mid-paste cannot
   * interleave two paste transactions. */
  private pasteChain: Promise<void> = Promise.resolve();
  private readonly goalStore: GoalStore;
  /**
   * Highest goal revision whose UI state was confirmed for a server-qualified session. A late
   * read or an out-of-order save can never make the displayed plan regress (#161).
   */
  private readonly goalRevisions = new GoalRevisionGuard();
  /** Local goal edits, serialized per session so overlapping changes rebase deterministically. */
  private readonly goalEditChains = new Map<string, Promise<void>>();
  /** Sole owner of verified child→ancestor evidence and in-flight ancestry walks (#310). */
  private readonly ancestry: AncestryVerifier;
  /** Identity of the server this controller talks to; part of every session key. */
  readonly serverID: string;

  /** Maximum gap (ms, measured with `deps.now`) between two Escape taps for a double-tap. */
  private static readonly ESCAPE_DOUBLE_TAP_MS = 400;

  constructor(private readonly deps: ControllerDeps) {
    this.serverID = deps.serverID ?? localServerID;
    this.debugLog = deps.debugLog ?? noDebugLog;
    const [state, setState] = createStore<AppState>(initialState(deps.cwd, this.serverID));
    this.state = state;
    this.overview = new OverviewProjection(() => this.overviewServerKey());
    // Invalidation is explicit: call sites that change an overview input use
    // `setStateTouchingOverview`, so adding a new input can no longer silently depend on a
    // magic key list or argument sniffing (#316). All other writes use the raw setter.
    this.setState = setState;
    // One batch: a store notification must never reach an observer while the revision still
    // names the previous projection's cache entry (#293). The setter is overloaded, so its
    // arguments are forwarded unchanged.
    this.setStateTouchingOverview = (...args: unknown[]) => {
      batch(() => {
        Reflect.apply(setState, undefined, args);
        this.overview.invalidate();
      });
    };
    this.drafts = new DraftRegistry({
      projectKey: (directory, serverID) => this.projectKeyOf(directory, serverID),
    });
    this.sessionFetcher = new SessionFetcher({
      backendFor: (serverID) => this.backendFor(serverID),
      keyFor: (serverID, sessionID) => this.keyFor(serverID, sessionID),
      pageLimit: sessionPageLimit,
      concurrency: reconcileConcurrency,
    });
    this.ancestry = new AncestryVerifier({
      backendFor: (serverID) => this.backendFor(serverID),
      isRegistered: (serverID, backend) => this.isRegisteredBackend(serverID, backend),
      getSession: (backend, sessionID) => backend.getSession(sessionID),
      keyFor: (serverID, sessionID) => this.keyFor(serverID, sessionID),
      sessionEpoch: (key) => this.sessionEpoch(key),
      localSummary: (key) => this.state.sessions[key],
      isSessionCurrent: (key, epoch) => this.isSessionCurrent(key, epoch),
      now: () => Date.now(),
      withTimeout: (check) => this.withDescendantTimeout(check),
      concurrency: ancestryVerifyConcurrency,
      timeoutMs: deps.ancestryVerifyTimeoutMs ?? ancestryVerifyTimeoutMs,
      budgetMs: ancestryVerifyBudgetMs,
    });
    this.inbox = new RequestInboxCoordinator({
      readRequests: async (sessionID, directory, backend) => {
        const [permissions, forms, locationForms] = await Promise.allSettled([
          backend.listPermissions(sessionID),
          backend.listForms(sessionID),
          directory !== undefined && backend.listLocationForms !== undefined
            ? backend.listLocationForms(directory)
            : Promise.resolve<FormRequest[]>([]),
        ]);
        return { permissions, forms, locationForms };
      },
      backendFor: (serverID) => this.backendFor(serverID),
      keyFor: (serverID, sessionID) => this.keyFor(serverID, sessionID),
      sessionEpoch: (key) => this.sessionEpoch(key),
      isSessionCurrent: (key, epoch) => this.isSessionCurrent(key, epoch),
      isRegisteredBackend: (serverID, backend) => this.isRegisteredBackend(serverID, backend),
      directoryOf: (key) => this.state.sessions[key]?.directory,
      previousPermissionIDOf: (key) => this.state.permissions[key]?.[0]?.id,
      cachedFormsOf: (key) => this.state.forms[key] ?? [],
      attachedRoute: () => {
        const route = this.state.route;
        return route.kind === 'conversation'
          ? { serverID: route.serverID, sessionID: route.sessionID }
          : undefined;
      },
      scope: (sessionID, serverID) => this.requestSessionScope(sessionID, serverID),
      describeError: errorText,
      verify: (children, ancestorID, serverID) =>
        this.verifyUnknownDescendants(children, ancestorID, serverID),
    });
    this.pinOperations = deps.localState.pinnedModelOps ?? {};
    this.persistence = new PersistenceCoordinator({
      initial: deps.localState,
      save: deps.saveLocalState,
      onMerge: (adopted) => {
        this.pinOperations = adopted.pinnedModelOps ?? {};
        this.setState('pinnedModels', reconcile({ ...adopted.pinnedModels }));
      },
      onWarning: (warning) => {
        this.showNotice(`Local state warning: ${warning}`, 'warn');
      },
      onError: (message) => {
        this.debugLog.write('backend-error', { operation: 'save', kind: 'unknown' });
        this.showNotice(`Could not persist local state: ${message}`, 'error');
      },
      describeError: errorText,
    });
    this.goalStore = deps.goalStore ?? memoryGoalStore();
    setState('recentModels', [...deps.localState.recentModels]);
    setState('pinnedModels', { ...deps.localState.pinnedModels });
    setState('lastModels', { ...deps.localState.lastModels });
    this.loadHistoryFor(deps.cwd);
  }

  dispose(): void {
    this.disposed = true;
    if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer);
    this.resetEscapeTimer();
    for (const timer of this.summaryTimers.values()) clearTimeout(timer);
    this.summaryTimers.clear();
    for (const timer of this.transcriptRetryTimers.values()) clearTimeout(timer);
    this.transcriptRetryTimers.clear();
    for (const timer of this.jobStartProbes.values()) clearTimeout(timer);
    this.jobStartProbes.clear();
  }

  /**
   * Waits for every queued state save to land. Call before exiting so the last
   * history/model updates are not lost. Rejects if any save failed, so the caller can warn.
   */
  async flushLocalState(): Promise<void> {
    await this.persistence.flush();
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
    return this.hostStreams.statusOf(serverID, this.state.stream);
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

  /**
   * One pure analytics projector feeds both the context meter in the footer and the `/usage`
   * summary, so clicking context and typing `/usage` can never disagree (#124).
   */
  usageAnalytics(): UsageAnalytics {
    const route = this.state.route;
    const serverID = route.kind === 'conversation' ? route.serverID : this.serverID;
    const sessionID = route.kind === 'conversation' ? route.sessionID : '';
    const key = this.keyFor(serverID, sessionID);
    const session = this.state.sessions[key];
    const view = this.currentView();
    const messages = this.state.transcripts[key]?.messages ?? [];
    const catalog = this.scopedModelsFor(serverID, session?.directory ?? this.deps.cwd);
    const mcpServers = this.mcpServersFor(serverID, session?.directory ?? '');
    const stale = view?.stream !== 'live';
    return this.usageAnalyticsSelector.select({
      serverID,
      sessionID,
      messages,
      ...(session?.tokens === undefined ? {} : { tokens: session.tokens }),
      ...(session?.cost === undefined ? {} : { cost: session.cost }),
      catalog,
      mcpServers,
      stale,
    });
  }

  openUsage(): void {
    this.setOverlay({ kind: 'usage' });
  }

  /**
   * Footer mouse action: click to open, click the same control again to close (#139).
   *
   * Only the overlay owned by the clicked action is toggleable. Permission/form/revert and all
   * other unrelated dialogs stay guarded, so a footer click can never bypass them, submit a
   * draft, or change agent/model without picker confirmation. Async picker opens carry a token
   * and route identity: a second click cancels the request, and a late catalog response cannot
   * resurrect a dismissed picker or one opened on a route the user has since left.
   */
  activateFooter(action: FooterAction): void {
    const owns = footerOverlay[action];
    const overlay = this.state.overlay;
    const routeKey = this.routeKey(this.state.route);

    // A navigation replaces the route without going through setOverlay; the pending request
    // no longer belongs to the screen the user is looking at.
    if (this.pendingPickerOpen !== undefined && this.pendingPickerOpen.routeKey !== routeKey) {
      this.cancelPickerOpen();
    }

    // Second click on the control that owns the visible overlay: close it, with no selection,
    // draft mutation or submit.
    if (overlay.kind === owns) {
      this.cancelPickerOpen();
      this.closeOverlay();
      return;
    }

    // Rapid second click while the catalog is still loading: cancel the in-flight open so no
    // overlay is left and the late response is ignored.
    if (this.pendingPickerOpen?.action === action && overlay.kind === 'none') {
      this.cancelPickerOpen();
      return;
    }

    // Some other modal/unrelated overlay is in front: never dismiss or bypass it.
    if (overlay.kind !== 'none') return;

    if (action === 'context') {
      this.openUsage();
      return;
    }
    const admitted = this.beginPickerOpen(action);
    const token = this.pickerOpenToken;
    const open =
      action === 'agent' ? this.openAgentPicker(admitted) : this.openModelPicker(admitted);
    void open.catch(() => {
      if (this.pendingPickerOpen?.token === token) this.cancelPickerOpen();
    });
  }

  /**
   * Starts a picker-open request shared by footer clicks, keyboard actions and slash commands
   * (#146). The returned guard validates the monotonic token, route identity and overlay state
   * after `ensureCatalog` resolves, so a late response can never open a picker over a different
   * screen or on top of a modal that appeared in the meantime.
   */
  private beginPickerOpen(action: FooterAction | 'effort'): () => boolean {
    const token = ++this.pickerOpenToken;
    const routeKey = this.routeKey(this.state.route);
    this.pendingPickerOpen = { token, action, routeKey };
    return () => {
      const pending = this.pendingPickerOpen;
      const ok =
        !this.disposed &&
        pending?.token === token &&
        this.routeKey(this.state.route) === routeKey &&
        this.state.overlay.kind === 'none';
      // Clear only this request's own pending marker; never a newer request's state.
      if (!ok && pending?.token === token) this.cancelPickerOpen();
      return ok;
    };
  }

  private cancelPickerOpen(): void {
    this.pickerOpenToken += 1;
    this.pendingPickerOpen = undefined;
  }

  /**
   * Health/label inputs outside the store; cheap per host, never per session. Stream status is
   * included because a remote host's liveness changes its execution classification (#288).
   */
  private overviewServerKey(): string {
    return this.serverIDs()
      .map((serverID) => {
        const info = this.deps.serverInfo?.(serverID);
        return `${serverID}\u0000${info?.online ?? true}\u0000${info?.label ?? ''}\u0000${this.streamStatusOf(serverID)}`;
      })
      .join('\u0001');
  }

  /** Counts for the tab bar, based on the same classifier as the dot. */
  tabCounts(): Record<OverviewTab, number> {
    return this.overview.tabCounts(() =>
      tabCounts(Object.values(this.state.sessions), {
        statusOf: (session) => this.statusOf(session),
        online: (serverID) => this.deps.serverInfo?.(serverID)?.online ?? true,
      }),
    );
  }

  overviewTab(): OverviewTab {
    return this.state.overview.tab;
  }

  cycleOverviewTab(direction: -1 | 1): void {
    this.setStateTouchingOverview('overview', 'tab', nextTab(this.state.overview.tab, direction));
    this.invalidateCompletion();
  }

  setOverviewTab(tab: OverviewTab): void {
    this.setStateTouchingOverview('overview', 'tab', tab);
    this.invalidateCompletion();
  }

  tabLabel(tab: OverviewTab): string {
    return overviewTabLabels[tab];
  }

  groups(): ProjectGroup[] {
    return this.overview.groups(() => {
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
    const complete = this.state.sessionsComplete;
    return this.overview.overviewRows(complete, () => {
      const rows = this.groups().flatMap((group) =>
        groupRows(group, this.state.overview.expanded[group.key] === true),
      );
      // Offer pagination once the server says the first pages are not everything.
      if (!complete) rows.push({ kind: 'loadmore', key: loadMoreRowKey });
      return rows;
    });
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
    return this.greetings.for(key, greetingPeriod(new Date(this.now())));
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
    const startedAt = this.deps.now();
    this.setState('startup', { phase: 'loading', startedAt });
    try {
      // The launch host gets the screen ready first; paired remotes continue below without
      // making the local UI wait for an unrelated slow host (#287).
      await Promise.all([
        this.loadCatalog(this.deps.cwd, this.serverID),
        this.loadSessions(this.serverID),
      ]);
      this.setState('startup', { phase: 'ready', startedAt, readyAt: this.deps.now() });
      const remotes = this.serverIDs().filter((serverID) => serverID !== this.serverID);
      await Promise.all(remotes.map((serverID) => this.loadSessions(serverID).catch(() => {})));
      // A remote server failing to load must not abort startup; the launch server failing
      // still propagates so the CLI can report it with an actionable message.
      if (this.launchLoadError !== undefined) throw this.launchLoadError;
    } catch (error) {
      this.setState('startup', {
        phase: 'failed',
        startedAt,
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private catalogGeneration = 0;
  private catalogInFlight: Promise<void> | undefined;
  private catalogInFlightScope: string | undefined;
  /**
   * Verified catalogs keyed by exact `(server, canonical directory)` scope (#134). Only a
   * successfully loaded snapshot lives here; a failed reload removes it, so a stale or
   * other-project catalog can never classify an in-flight prompt's `@name` tokens.
   */
  private readonly catalogSnapshots = new Map<string, CatalogSnapshot>();
  /**
   * In-flight footer picker request. The token invalidates a late `ensureCatalog()` response so
   * a picker dismissed by a second click (or a route change) can never be resurrected (#139).
   */
  private pickerOpenToken = 0;
  private pendingPickerOpen:
    { token: number; action: FooterAction | 'effort'; routeKey: string } | undefined;
  /** Deduplicates "agent unavailable" prompts across repeated catalog refreshes (#123). */
  private unavailableAgentNotice: string | undefined;

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
      // Build both catalogs from the same server response. Mention eligibility and primary
      // selection are distinct: subagent-only agents are mentioned but never cycle-driven (#133).
      const selectable = selectableAgents(agents, this.deps.config.agents.cycle);
      const mentionable = mentionableAgents(agents);
      this.catalogSnapshots.set(scope, {
        selectable,
        mentionable,
        mentionIDs: new Set(mentionable.map((agent) => agent.id)),
        models,
      });
      batch(() => {
        this.setState('catalogDirectory', directoryKey(directory, this.platformFor(serverID)));
        this.setState('catalogServerID', serverID);
        this.setState('agents', selectable);
        this.setState('mentionAgents', mentionable);
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
      // An agent that vanished or became hidden/disabled is never silently replaced. Keep
      // the server-confirmed session agent and ask the user to choose a valid one (#123).
      const current = this.currentSession();
      if (
        current !== undefined &&
        current.serverID === serverID &&
        !this.state.agents.some((agent) => agent.id === current.agent)
      ) {
        const notice = `Agent "${current.agent}" is no longer available. Choose a new agent with Shift+Tab or /agent.`;
        if (this.unavailableAgentNotice !== notice) {
          this.unavailableAgentNotice = notice;
          this.showNotice(notice, 'warn');
        }
      } else {
        this.unavailableAgentNotice = undefined;
      }
    } catch (error) {
      if (generation !== this.catalogGeneration) return;
      // A failed reload must not leave any earlier snapshot usable for this scope: a prompt
      // with an @name could otherwise be classified against a catalog that no longer exists.
      this.catalogSnapshots.delete(scope);
      // Never leave another project's or server's catalog usable after a failed reload.
      batch(() => {
        this.setState('agents', []);
        this.setState('mentionAgents', []);
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

  /**
   * Model catalog verified for the exact `(server, directory)` scope (#143). Usage limits must
   * come from the conversation's owning scope, never the globally mutable `state.models`, which
   * may describe the most recently visited project. An absent snapshot means "unknown limit",
   * not a fabricated percentage; lifetime tokens/cost remain unaffected.
   */
  private scopedModelsFor(serverID: string, directory: string): readonly CatalogModel[] {
    return this.catalogSnapshots.get(this.catalogScope(directory, serverID))?.models ?? [];
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
    const superseded = (key: string) => this.generations.eventSequence(key) > snapshotSeq;
    this.setStateTouchingOverview(
      produce((state) => {
        for (const key of Object.keys(state.running)) {
          const ref = parseSessionKey(key);
          if (ref.serverID !== serverID || active.has(ref.sessionID) || superseded(key)) continue;
          delete state.running[key];
          // The turn is over, so its transient background confirmations are over too (#135).
          delete state.backgrounded[key];
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
      usageSeq: number;
    }>;
    const results = await Promise.all<SessionLoadResult>(
      servers.map(async (targetID): Promise<SessionLoadResult> => {
        const epoch = this.nextRefreshEpoch(targetID);
        // Captured before the first request: any execution event stamped after this point is
        // newer than the snapshot and must not be overwritten by it.
        const snapshotSeq = this.generations.eventClock();
        const usageSeq = this.generations.usageClock();
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
            usageSeq,
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
            usageSeq,
          };
        }
      }),
    );
    // Only the freshest refresh for a still-registered host may be applied; anything older
    // or whose server was removed mid-flight is dropped so it cannot resurrect rows.
    const registered = new Set(this.serverIDs());
    const { applied, health } = healthCommands(results, registered, (hostID, epoch) =>
      this.isRefreshCurrent(hostID, epoch),
    );
    for (const report of health) this.deps.setServerHealth?.(report.serverID, report.result);
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
        this.setStateTouchingOverview('sessions', (current) =>
          mergeCommittedSessions(current, result.fresh, reconciled.found, result.usageSeq, (key) =>
            this.generations.usageEvidence(key),
          ),
        );
        for (const ref of reconciled.deleted) this.forgetSession(ref.sessionID, ref.serverID);
        this.setState('serverPages', result.serverID, sessionPage(result));
        if (result.ok) this.reconcileRunning(result.serverID, result.active, result.snapshotSeq);
      });
      committed.push(result.serverID);
      if (result.ok) activeByServer.set(result.serverID, result.active);
    }

    const flags = sessionFlags(
      applied,
      committed.length,
      () => this.serverIDs().every((id) => this.state.serverPages[id]?.complete === true),
      serverID,
    );
    batch(() => {
      this.setStateTouchingOverview('sessionsComplete', flags.complete);
      if (serverID === undefined) this.setState('sessionsCursor', flags.cursor);
      // Only a refresh that actually applied a host may clear the loading flag; a newer
      // or unrelated refresh keeps it set until that operation completes.
      if (flags.loading) this.setState('sessionsLoading', false);
      this.setState('sessionsError', flags.error);
    });

    // Running sessions are the ones that can be blocked on input right now. The attached
    // conversation is refreshed even when idle: a child that just appeared in this listing
    // may own a question the location route already reported (#274).
    const requestRefreshes = servers.flatMap((targetID) =>
      [...(activeByServer.get(targetID) ?? [])].map((sessionID) =>
        this.refreshInputRequests(sessionID, targetID).catch(() => {
          // Unreachable host: its stale permission/form state stays as-is.
        }),
      ),
    );
    const route = this.state.route;
    if (route.kind === 'conversation' && committed.includes(route.serverID)) {
      requestRefreshes.push(
        this.refreshInputRequests(route.sessionID, route.serverID).catch(() => {
          // The transcript remains usable and the existing retry route stays available.
        }),
      );
    }
    await Promise.all(requestRefreshes);
  }

  // Generation checks are owned by RefreshGenerations; these thin wrappers keep the
  // existing call sites stable while capabilities migrate (#305).
  private nextRefreshEpoch(serverID: string): number {
    return this.generations.nextRefresh(serverID);
  }

  private isRefreshCurrent(serverID: string, epoch: number): boolean {
    return this.generations.isRefreshCurrent(serverID, epoch);
  }

  private sessionEpoch(key: string): number {
    return this.generations.sessionEpoch(key);
  }

  private isSessionCurrent(key: string, epoch: number): boolean {
    return this.generations.isSessionCurrent(key, epoch);
  }

  private invalidateSession(key: string): void {
    this.generations.invalidateSession(key);
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
    return this.sessionFetcher.loadServer(serverID, effectiveEpoch);
  }

  /** Looks up cached sessions the listing did not return; only a definite not-found deletes. */
  private async reconcileKnownSessions(
    refs: readonly SessionRef[],
  ): Promise<{ found: Record<string, SessionSummary>; deleted: SessionRef[] }> {
    return this.sessionFetcher.reconcile(refs);
  }

  /** Drops every cached trace of a session the server no longer has. */
  private forgetSession(sessionID: string, serverID: string = this.activeServerID()): void {
    const key = this.keyFor(serverID, sessionID);
    // Retire every in-flight read/refresh and pending retry for this lifetime before
    // deleting its state (#252, #295).
    this.invalidateSession(key);
    const retryKey = `${serverID} ${sessionID}`;
    const retryTimer = this.transcriptRetryTimers.get(retryKey);
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      this.transcriptRetryTimers.delete(retryKey);
    }
    this.transcriptRetries.reset(retryKey);
    this.clearJobStartProbe(key);
    const expansionPrefix = `${key} `;
    this.setStateTouchingOverview(
      produce((state) => {
        delete state.sessions[key];
        delete state.transcripts[key];
        delete state.inbox[key];
        delete state.permissions[key];
        delete state.forms[key];
        delete state.goals[key];
        this.goalRevisions.forget(key);
        this.goalEditChains.delete(key);
        delete state.nativeGoals[key];
        delete state.awaitingSteer[key];
        delete state.running[key];
        delete state.openedAt[key];
        delete state.transcriptWindow[key];
        // A deleted session must not keep a live-looking worker or a stale background note.
        delete state.workers[key];
        delete state.workerStatus[key];
        delete state.shellJobs[key];
        delete state.shellStatus[key];
        delete state.backgrounded[key];
        for (const expansionKey of Object.keys(state.expandedGroups)) {
          if (expansionKey.startsWith(expansionPrefix)) delete state.expandedGroups[expansionKey];
        }
        for (const expansionKey of Object.keys(state.expandedDiffs)) {
          if (expansionKey.startsWith(expansionPrefix)) delete state.expandedDiffs[expansionKey];
        }
        for (const expansionKey of Object.keys(state.expandedTools)) {
          if (expansionKey.startsWith(expansionPrefix)) delete state.expandedTools[expansionKey];
        }
        for (const pageKey of Object.keys(state.childPages)) {
          if (pageKey.startsWith(expansionPrefix)) delete state.childPages[pageKey];
        }
      }),
    );
    this.transcriptOrder = this.transcriptOrder.filter((entry) => entry !== key);
    this.goalVersions.delete(key);
    this.generations.forgetEvents(key);
    this.invalidateJobRefresh(key);
    this.inbox.forgetSession(key);
    // A recreated ID must start a new read order; the process-wide counters stay monotonic,
    // so an older in-flight response can never look current again (#262, #263).
    this.summaryAdmitted.delete(key);
    this.transcriptGenerations.forget(key);
    // Selection caches belong to the session lifetime: a deleted or recreated ID must never
    // inherit an earlier switch, failure marker or revision (#253).
    this.confirmedAgents.delete(key);
    this.agentSwitches.delete(key);
    this.failedAgentSwitches.delete(key);
    this.modelSwitches.delete(key);
    this.failedModelSwitches.delete(key);
    this.modelSwitchRevisions.delete(key);
    this.ancestry.forgetSession(key);
    // A recreated ID starts without usage evidence, so a new summary can establish usage.
    this.generations.forgetUsage(key);
    const route = this.state.route;
    if (
      route.kind === 'conversation' &&
      route.serverID === serverID &&
      route.sessionID === sessionID
    ) {
      this.interactionGeneration += 1;
      this.setState('route', { kind: 'overview' });
      if (this.state.overlay.kind === 'diff' || this.state.overlay.kind === 'form') {
        this.closeOverlay();
      }
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
        const snapshotSeq = this.generations.eventClock();
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
    const { applied, health } = healthCommands(results, registered, (hostID, epoch) =>
      this.isRefreshCurrent(hostID, epoch),
    );
    for (const report of health) this.deps.setServerHealth?.(report.serverID, report.result);
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
        this.setStateTouchingOverview('sessions', (current) => {
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
      this.setStateTouchingOverview(
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
    // Follow-ups run only for applied (still registered, current-epoch) successful snapshots,
    // and each failure is isolated so one host cannot abort or mask a healthy one (#196).
    const followUps = applied.flatMap((result) =>
      result.ok
        ? [...result.active].map(async (sessionID) => {
            if (!this.serverIDs().includes(result.serverID)) return;
            try {
              await this.refreshInputRequests(sessionID, result.serverID);
            } catch (error) {
              if (this.serverIDs().includes(result.serverID)) {
                this.debugLog.write('action', {
                  action: 'load-more-sessions-input-refresh',
                  ok: false,
                  error: errorText(error),
                });
              }
            }
          })
        : [],
    );
    await Promise.all(followUps);
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
    target: SessionTarget,
    flags: { agent?: string; provider?: string; model?: string; effort?: string },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const wantsModel =
      flags.provider !== undefined || flags.model !== undefined || flags.effort !== undefined;
    if (flags.agent === undefined && !wantsModel) return { ok: true };
    const ref = sessionRefOf(target, this.activeServerID());
    // A qualified ref is authoritative: never look the ID up on a different host (#149).
    // A legacy bare ID keeps the old cross-server resolution for existing callers/tests.
    const session =
      typeof target === 'string'
        ? await this.ensureSession(ref.sessionID, ref.serverID)
        : await this.ensureSession(ref.sessionID, ref.serverID, { onlyServer: true });
    if (session === undefined) {
      return { ok: false, message: `session ${ref.sessionID} not found.` };
    }
    // The resolved summary's owner is authoritative in both paths: a bare ID that resolved
    // on another host must still be mutated there, never at the launch host.
    const serverID = session.serverID;
    if (!(await this.ensureCatalog(session.directory, serverID))) {
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
      // Every mutation goes to the session's owning host, not the launch backend (#149).
      if (agent !== undefined) await this.backendFor(serverID).switchAgent(ref.sessionID, agent);
      if (model !== undefined && !(await this.switchSessionModel(session, model))) {
        return { ok: false, message: 'The server did not confirm the requested model.' };
      }
    } catch (error) {
      return { ok: false, message: `could not apply the requested selection: ${errorText(error)}` };
    }
    await this.refreshSummary(ref.sessionID, serverID);
    return { ok: true };
  }

  // ---------------------------------------------------------------- events

  onStreamStatus(serverID: string, status: StreamStatus): void {
    this.debugLog.write('stream-status', { serverID, status });
    const effects = this.hostStreams.transition({
      serverID,
      status,
      launchServerID: this.serverID,
      launchBadge: this.state.stream,
    });
    batch(() => {
      for (const command of effects.batched) this.executeHostStreamCommand(command);
    });
    // The single stream badge belongs to the launch server; per-server health lives on the
    // manager. A remote reconnect resyncs that host through onEvents and never touches the
    // badge here.
    for (const command of effects.after) this.executeHostStreamCommand(command);
  }

  /** Executes one host-stream effect against the controller's reactive store and capabilities. */
  private executeHostStreamCommand(command: HostStreamCommand): void {
    switch (command.kind) {
      case 'bump-overview':
        // Any host's liveness changes status dots and tab counts. A remote transition writes
        // no other store field, so bump the reactive overview clock explicitly (#293).
        this.overview.invalidate();
        return;
      case 'clear-runtime':
        // Every host, not just the launch one: a remote disconnect must drop that host's
        // live-looking job rows and transient background confirmations (#136). Only this
        // host's keys are touched, so other servers keep their server-confirmed state.
        this.clearRuntimeStateForServer(command.serverID);
        return;
      case 'set-badge':
        this.setStateTouchingOverview('stream', command.status);
        return;
      case 'show-lost-notice':
        this.showNotice('Connection lost · retrying', 'warn', false);
        return;
      case 'resync':
        void this.track('resync', this.resync(command.serverID));
        return;
      default:
        return;
    }
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
   * Retires one host's live-looking state on disconnect/unpair (#136, #230): in-flight job
   * refreshes are invalidated, transient background confirmations are dropped, and the last
   * confirmed job rows are kept but marked stale. A disconnect must not impersonate "all
   * jobs finished"; only a later successful refresh can confirm an empty list. Local keys are
   * unqualified, so ownership is parsed rather than prefix-matched.
   */
  private clearRuntimeStateForServer(serverID: string): void {
    // Invalidate *every* in-flight refresh for this host, including first fetches that have
    // not written any row yet. Their response must not survive a reconnect (#140).
    for (const key of this.generations.jobKeys()) {
      if (parseSessionKey(key).serverID === serverID) this.invalidateJobRefresh(key);
    }
    for (const key of this.jobStartProbes.keys()) {
      if (parseSessionKey(key).serverID === serverID) this.clearJobStartProbe(key);
    }
    this.setStateTouchingOverview(
      produce((state) => {
        for (const key of Object.keys(state.backgrounded)) {
          if (parseSessionKey(key).serverID === serverID) delete state.backgrounded[key];
        }
        for (const [rowsField, statusField] of [
          ['workers', 'workerStatus'],
          ['shellJobs', 'shellStatus'],
        ] as const) {
          const keys = new Set([
            ...Object.keys(state[rowsField]),
            ...Object.keys(state[statusField]),
          ]);
          for (const key of keys) {
            if (parseSessionKey(key).serverID !== serverID) continue;
            const retained = state[rowsField][key] ?? [];
            state[statusField][key] = {
              state: retained.length > 0 ? 'stale' : 'unavailable',
              detail:
                retained.length > 0
                  ? 'connection lost · last confirmed rows retained'
                  : 'connection lost before any rows were confirmed',
            };
          }
        }
      }),
    );
  }

  /**
   * A stream (re)connect means we may have missed events for that host: refetch that
   * host's snapshot only. Other servers are untouched; the route keeps what it has.
   */
  private async resync(serverID: string): Promise<void> {
    const epoch = this.generations.nextResync(serverID);
    const currentResync = (): boolean =>
      !this.disposed &&
      this.generations.isResyncCurrent(serverID, epoch) &&
      this.serverIDs().includes(serverID);
    // Transcript freshness is judged against what was committed *before* this resync:
    // a session read that lands during it is genuinely fresh, not a stale replay.
    const committedBefore = new Map<string, number>();
    for (const key of Object.keys(this.state.transcripts)) {
      if (parseSessionKey(key).serverID !== serverID) continue;
      committedBefore.set(key, this.transcriptGenerations.committedGeneration(key));
    }
    const attachedSession = (): string | undefined =>
      attachedSessionFor(this.state.route, serverID);
    await this.loadSessions(serverID);
    if (!currentResync()) return;
    // The catalog and conversation are read from the route *now*, never from a route
    // captured before an await; a switch during resync must keep the new route fresh (#275).
    const route = this.state.route;
    const routeServer = routeServerFor(route, this.state.overview.project.serverID);
    if (routeServer === serverID)
      void this.track('catalog', this.loadCatalog(this.currentDirectory(), serverID));
    const attached = attachedSession();
    if (attached !== undefined) await this.loadConversation(attached, serverID);
    if (!currentResync()) return;
    // Goal reads that failed while disconnected are re-tried; a successful push or read
    // during the outage already superseded them (version guard).
    const attachedNow = attachedSession();
    const unattached = Object.entries(this.state.nativeGoals)
      .filter(
        ([key, goal]) =>
          goal.status === 'unavailable' &&
          parseSessionKey(key).serverID === serverID &&
          attachedNow !== parseSessionKey(key).sessionID,
      )
      .map(([key]) => parseSessionKey(key).sessionID);
    await Promise.all(unattached.map((id) => this.refreshNativeGoal(id, serverID).catch(() => {})));
    if (!currentResync()) return;
    // Mark only sessions this resync did not refresh; the attached conversation must have
    // committed a newer page to stay fresh. A detached session is stale even if an old
    // read happened to land, because its live events were not the focus of this resync.
    for (const command of planResyncStaleFlags({
      serverID,
      keys: Object.keys(this.state.transcripts),
      attachedSessionID: attachedSession(),
      committedBefore,
      committedNow: (key) => this.transcriptGenerations.committedGeneration(key),
      sessionServerOf: (key) => parseSessionKey(key).serverID,
      sessionIDOf: (key) => parseSessionKey(key).sessionID,
    })) {
      this.setState('transcripts', command.key, 'stale', command.stale);
    }
    if (serverID === this.serverID && this.state.notice?.text === 'Connection lost · retrying')
      this.clearNotice();
  }

  private applyEvent(serverID: string, event: BackendEvent): void {
    const commands = admitEvent({
      event,
      attached: attachedSessionFor(this.state.route, serverID),
      routeMatchesHost:
        routeServerFor(this.state.route, this.state.overview.project.serverID) === serverID,
      hasSession: (sessionID) =>
        this.state.sessions[this.keyFor(serverID, sessionID)] !== undefined,
      requestTargets: () =>
        this.inputRequestRefreshTargets('sessionID' in event ? event.sessionID : '', serverID),
    });
    for (const command of commands) this.executeEventCommand(serverID, command);
  }

  /** Executes one admitted event effect against this controller's owned state and backend. */
  private executeEventCommand(serverID: string, command: EventCommand): void {
    const sessionID = 'sessionID' in command ? command.sessionID : '';
    switch (command.kind) {
      case 'reload-catalog':
        void this.track('catalog', this.loadCatalog(this.currentDirectory(), serverID));
        return;
      case 'schedule-summary':
        this.scheduleSummary(sessionID, serverID);
        return;
      case 'refresh-summary':
        void this.track('revert', this.refreshSummary(sessionID, serverID));
        return;
      case 'clear-job-rows':
        this.setState('workers', this.keyFor(serverID, sessionID), []);
        this.setState('shellJobs', this.keyFor(serverID, sessionID), []);
        return;
      case 'forget-session':
        this.forgetSession(sessionID, serverID);
        return;
      case 'stamp-usage':
        this.generations.nextUsageSequence(this.keyFor(serverID, sessionID));
        return;
      case 'set-usage':
        this.setStateTouchingOverview('sessions', this.keyFor(serverID, sessionID), {
          cost: command.cost,
          tokens: command.tokens,
        });
        return;
      case 'stamp-execution':
        this.generations.nextEventSequence(this.keyFor(serverID, sessionID));
        return;
      case 'set-running':
        this.setStateTouchingOverview('running', this.keyFor(serverID, sessionID), command.running);
        return;
      case 'clear-backgrounded':
        // A background confirmation lives only in the turn that produced it (#135).
        this.setState('backgrounded', this.keyFor(serverID, sessionID), []);
        return;
      case 'schedule-transcript':
        this.scheduleTranscript(sessionID, serverID, command.refreshJobs);
        return;
      case 'mark-stale':
        this.markStale(sessionID, serverID);
        return;
      case 'schedule-job-start-probe':
        this.scheduleJobStartProbe(sessionID, serverID);
        return;
      case 'refresh-input-requests':
        void this.track('requests', this.refreshInputRequests(sessionID, serverID));
        return;
      case 'refresh-inbox':
        void this.track('inbox', this.refreshInbox(sessionID, serverID));
        return;
      case 'bump-goal-version':
        this.bumpGoalVersion(sessionID, serverID);
        return;
      case 'set-native-goal':
        this.setNativeGoalState(
          sessionID,
          command.goal === null ? { status: 'none' } : { status: 'verified', goal: command.goal },
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
    const epoch = this.sessionEpoch(key);
    const backend = this.backendFor(serverID);
    const revision = this.modelSwitchRevisions.get(key);
    const sequence = ++this.summaryReadSeq;
    this.summaryAdmitted.set(key, sequence);
    // Usage events stamped after this point are newer than the snapshot being fetched.
    const usageAtStart = this.generations.usageEvidence(key);
    try {
      const session = await backend.getSession(sessionID);
      // A deleted/unpaired/recreated session must not be recreated by a late summary read.
      if (!this.isSessionCurrent(key, epoch) || !this.isRegisteredBackend(serverID, backend))
        return;
      if (this.modelSwitchRevisions.get(key) !== revision) return;
      // A newer ordinary summary read supersedes this response even in the same lifetime.
      // Dropping the older result is safer than letting it restore a title/usage/revert
      // snapshot that the newer accepted read already replaced (#263).
      if (this.summaryAdmitted.get(key) !== sequence) return;
      // reconcile replaces the stored summary wholesale: absent `revert` is removed again.
      // Never lose the server stamp: a backend that omits it must not orphan the row.
      // A live usage event received while this read was pending is newer evidence than the
      // snapshot, so keep its cost/tokens while accepting the snapshot's other fields (#272).
      const current = this.state.sessions[key];
      const liveUsageAdvanced = this.generations.usageEvidence(key) > usageAtStart;
      const next = this.withConfirmedModel(key, { ...session, serverID });
      const committed =
        liveUsageAdvanced && current !== undefined
          ? {
              ...next,
              ...(current.cost === undefined ? {} : { cost: current.cost }),
              ...(current.tokens === undefined ? {} : { tokens: current.tokens }),
            }
          : next;
      this.setStateTouchingOverview('sessions', key, reconcile(committed));
      if (session.agent !== undefined) this.acceptServerAgent(key, session.agent);
      else this.adoptTranscriptAgent(key);
      this.reconcileStagedRevert(sessionID, serverID);
    } catch (error) {
      if (!this.isSessionCurrent(key, epoch) || !this.isRegisteredBackend(serverID, backend)) {
        return;
      }
      if (error instanceof BackendError && error.kind === 'not-found') return;
      throw error;
    }
  }

  private async refreshInbox(
    sessionID: string,
    serverID: string = this.activeServerID(),
    backend: Backend = this.backendFor(serverID),
  ): Promise<void> {
    const key = this.keyFor(serverID, sessionID);
    if (this.state.sessions[key] === undefined || !this.isRegisteredBackend(serverID, backend)) {
      return;
    }
    const epoch = this.sessionEpoch(key);
    let items: readonly QueuedInput[];
    try {
      items = await backend.listInbox(sessionID);
    } catch (error) {
      if (!this.isSessionCurrent(key, epoch) || !this.isRegisteredBackend(serverID, backend)) {
        return;
      }
      throw error;
    }
    if (
      this.isSessionCurrent(key, epoch) &&
      this.state.sessions[key] !== undefined &&
      this.isRegisteredBackend(serverID, backend)
    ) {
      this.setState('inbox', key, items);
    }
  }

  private isRegisteredBackend(serverID: string, backend: Backend): boolean {
    return this.deps.backendFor === undefined || this.deps.backendFor(serverID) === backend;
  }

  private async refreshInputRequests(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): Promise<void> {
    // The coordinator yields one batch with the authoritative results, then a second batch
    // after bounded verification. Each batch stays a separate Solid transaction (#294).
    for await (const commands of this.inbox.refresh(sessionID, serverID)) {
      batch(() => {
        for (const command of commands) this.executeRequestInboxCommand(command);
      });
    }
  }

  /** Executes one request-inbox store effect inside its publication batch. */
  private executeRequestInboxCommand(command: RequestInboxCommand): void {
    switch (command.kind) {
      case 'set-permissions':
        this.setStateTouchingOverview('permissions', command.key, command.value);
        return;
      case 'set-forms':
        this.setStateTouchingOverview('forms', command.key, command.value);
        return;
      case 'set-request-errors':
        // Replace the whole per-key record: a successful retry clears an old error without
        // leaving the other category's stale text behind.
        this.setState(
          'requestErrors',
          produce((all) => {
            if (command.value === undefined) delete all[command.key];
            else all[command.key] = command.value;
          }),
        );
        return;
      case 'reset-permission-focus':
        // A different request needs fresh deliberate focus; the same one keeps the user's
        // selection across routine refreshes (#237).
        this.setState('permissionChoice', 0);
        this.setState('permissionFocused', false);
        return;
      default:
        return;
    }
  }

  /**
   * Bounded, time-limited ownership checks for uncached child questions (#294). Each child
   * is checked at most once; a stalled backend or deep ancestry chain becomes `pending`
   * (visible, retryable, never cleared) instead of blocking the refresh forever.
   */
  private async verifyUnknownDescendants(
    childIDs: readonly string[],
    ancestorID: string,
    serverID: string,
  ): Promise<{
    verified: Set<string>;
    unrelated: Set<string>;
    pending: Set<string>;
    error?: string;
  }> {
    return this.ancestry.verifyUnknownDescendants(childIDs, ancestorID, serverID);
  }

  private async withDescendantTimeout(check: Promise<DescendantCheck>): Promise<DescendantCheck> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<DescendantCheck>((settle) => {
      timer = setTimeout(
        () => settle({ status: 'unresolved', error: 'the ownership check timed out' }),
        this.deps.ancestryVerifyTimeoutMs ?? ancestryVerifyTimeoutMs,
      );
    });
    try {
      return await Promise.race([check, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Buckets that must be refreshed for one request event. Global and child events belong to
   * the viewed parent conversation (#226); a normal session event refreshes itself. An event
   * whose session is not in the loaded index may be a child, so the attached conversation is
   * refreshed too — the location merge still filters out sibling forms.
   */
  private inputRequestRefreshTargets(eventSessionID: string, serverID: string): string[] {
    const route = this.state.route;
    return inputRequestRefreshTargets({
      eventSessionID,
      serverID,
      isKnown: (id) => this.state.sessions[this.keyFor(serverID, id)] !== undefined,
      attached:
        route.kind === 'conversation'
          ? { serverID: route.serverID, sessionID: route.sessionID }
          : undefined,
      scope: (sessionID, host) => this.requestSessionScope(sessionID, host),
    });
  }

  /** The attached session plus its descendants on the same server. */
  private requestSessionScope(sessionID: string, serverID: string): Set<string> {
    return descendantScope({
      serverID,
      sessionID,
      sessions: this.state.sessions,
      verified: this.ancestry.evidence(),
      sessionEpoch: (key) => this.sessionEpoch(key),
      keyFor: (host, session) => this.keyFor(host, session),
    });
  }

  /** Retries input requests for the attached conversation after a partial failure. */
  retryInputRequests(): void {
    const route = this.state.route;
    if (route.kind !== 'conversation') return;
    void this.track('requests', this.refreshInputRequests(route.sessionID, route.serverID));
  }

  /** Last partial-failure detail for the attached conversation's input requests (#264). */
  currentRequestError(): { permissions?: string; forms?: string } | undefined {
    const route = this.state.route;
    if (route.kind !== 'conversation') return undefined;
    return this.state.requestErrors[this.keyFor(route.serverID, route.sessionID)];
  }

  // ---------------------------------------------------------------- transcripts

  /** Starts a new job refresh epoch for one kind; the other kind refreshes independently. */
  private nextJobRefreshEpoch(key: string, kind: 'worker' | 'shell'): number {
    return this.generations.nextJobRefresh(key, kind);
  }

  private isJobRefreshCurrent(key: string, kind: 'worker' | 'shell', epoch: number): boolean {
    return this.generations.isJobRefreshCurrent(key, kind, epoch);
  }

  /**
   * Invalidates in-flight job refreshes when a session's runtime state is discarded. Epochs are
   * monotonically *bumped*, never deleted: deleting lets the counter restart at 1 on reconnect,
   * so an old response could pass the freshness check again (#140).
   */
  private invalidateJobRefresh(key: string): void {
    this.generations.invalidateJobRefresh(key);
  }

  /**
   * Worker rows are server-authoritative (#101). A failed/unsupported RPC retains the last
   * confirmed rows and marks them stale; only a successful empty response is confirmed-empty,
   * so a timeout never impersonates "all workers finished" (#230).
   */
  private async refreshWorkers(sessionID: string, serverID = this.activeServerID()): Promise<void> {
    const key = this.keyFor(serverID, sessionID);
    const epoch = this.nextJobRefreshEpoch(key, 'worker');
    const outcome = await refreshOutcome(() =>
      this.backendFor(serverID).listSubagentJobs(sessionID),
    );
    // Ownership + epoch: the session may have been deleted, unpaired or disconnected while
    // the RPC was in flight. An old response must never restore its rows (#136).
    if (this.disposed || !this.isJobRefreshCurrent(key, 'worker', epoch)) return;
    const owner = this.state.sessions[key];
    if (owner === undefined || owner.serverID !== serverID) return; // missing owner is not confirmed ownership
    if (outcome.ok) {
      this.setState('workers', key, outcome.jobs);
      this.setState('workerStatus', key, { state: 'confirmed' });
      return;
    }
    const retained = this.state.workers[key] ?? [];
    this.setState('workerStatus', key, {
      state: retained.length > 0 ? 'stale' : 'unavailable',
      detail: outcome.detail,
    });
  }

  /**
   * Shell jobs are refreshed on the same server-authoritative path (#103). A failed refresh
   * keeps the last confirmed rows stale instead of dropping a still-running timed-out shell
   * (#230); no background state is invented when nothing was ever confirmed.
   */
  private async refreshShellJobs(
    sessionID: string,
    serverID = this.activeServerID(),
  ): Promise<void> {
    const key = this.keyFor(serverID, sessionID);
    const epoch = this.nextJobRefreshEpoch(key, 'shell');
    const outcome = await refreshOutcome(() => this.backendFor(serverID).listShellJobs(sessionID));
    if (this.disposed || !this.isJobRefreshCurrent(key, 'shell', epoch)) return;
    const owner = this.state.sessions[key];
    if (owner === undefined || owner.serverID !== serverID) return; // missing owner is not confirmed ownership
    if (outcome.ok) {
      this.setState('shellJobs', key, outcome.jobs);
      this.setState('shellStatus', key, { state: 'confirmed' });
      return;
    }
    const retained = this.state.shellJobs[key] ?? [];
    this.setState('shellStatus', key, {
      state: retained.length > 0 ? 'stale' : 'unavailable',
      detail: outcome.detail,
    });
  }

  /**
   * Honest background state for a timed-out shell: confirmed while the job list is fresh,
   * last-known after a failed refresh, never invented when nothing was reported (#259).
   */
  shellBackgroundState(
    shellID: string | undefined,
    sessionID: string,
    serverID = this.activeServerID(),
  ): ShellBackgroundState {
    const key = this.keyFor(serverID, sessionID);
    return projectShellBackgroundState(
      this.state.shellJobs[key],
      shellID,
      this.state.shellStatus[key]?.state,
    );
  }

  /**
   * Refreshes worker and shell jobs off the transcript critical path (#284). One request
   * pair runs per session at a time; hints arriving while it is in flight coalesce into one
   * follow-up. A slow job RPC can never delay painting the newer transcript.
   */
  private scheduleJobRefresh(sessionID: string, serverID: string = this.activeServerID()): void {
    const key = this.keyFor(serverID, sessionID);
    if (this.jobRefreshes.has(key)) {
      this.jobRefreshDirty.add(key);
      return;
    }
    const run = (async () => {
      do {
        this.jobRefreshDirty.delete(key);
        await Promise.all([
          this.refreshWorkers(sessionID, serverID),
          this.refreshShellJobs(sessionID, serverID),
        ]);
      } while (this.jobRefreshDirty.delete(key) && !this.disposed);
    })();
    this.jobRefreshes.set(key, run);
    void run.finally(() => {
      if (this.jobRefreshes.get(key) === run) this.jobRefreshes.delete(key);
    });
    void this.track('jobs', run);
  }

  /**
   * A tool call can create a worker slightly after its event. Probe once after a short delay
   * in addition to the immediate hint; later calls coalesce into the pending probe (#297).
   */
  private scheduleJobStartProbe(sessionID: string, serverID: string = this.activeServerID()): void {
    const key = this.keyFor(serverID, sessionID);
    if (this.jobStartProbes.has(key)) return;
    const timer = setTimeout(() => {
      this.jobStartProbes.delete(key);
      if (this.disposed) return;
      if (!this.serverIDs().includes(serverID)) return;
      if (this.state.sessions[key] === undefined) return;
      this.scheduleJobRefresh(sessionID, serverID);
    }, jobStartProbeDelayMs);
    this.jobStartProbes.set(key, timer);
  }

  private clearJobStartProbe(key: string): void {
    const timer = this.jobStartProbes.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.jobStartProbes.delete(key);
  }

  /** Throttled canonical refetch: at most one request in flight per session. */
  private scheduleTranscript(
    sessionID: string,
    serverID: string = this.activeServerID(),
    refreshJobs = false,
  ): void {
    const key = `${serverID} ${sessionID}`;
    // A fresh signal supersedes a pending backoff retry; it must not wait behind it.
    const retryTimer = this.transcriptRetryTimers.get(key);
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      this.transcriptRetryTimers.delete(key);
    }
    if (this.transcriptFlights.coalesce(key, refreshJobs)) return;
    const run = (async () => {
      let failure: unknown;
      try {
        await this.fetchLatest(sessionID, serverID);
      } catch (error) {
        failure = error;
      } finally {
        this.transcriptFlights.end(key);
      }
      // Always settle the coalesced hints, including after a rejected read. Draining them
      // only on success dropped an already-observed update when no later event arrived
      // (#295), and left the flags cached for an unrelated refresh.
      const { dirty, dirtyJobs } = this.transcriptFlights.drain(key);
      if (failure !== undefined) {
        await this.handleTranscriptFailure(
          sessionID,
          serverID,
          failure,
          refreshJobs || dirty,
          dirtyJobs,
        );
        return;
      }
      this.transcriptRetries.reset(key);
      if (refreshJobs) this.scheduleJobRefresh(sessionID, serverID);
      await delay(80);
      if (dirty && !this.disposed) this.scheduleTranscript(sessionID, serverID, dirtyJobs);
    })();
    this.transcriptFlights.begin(key, run);
    void this.track('transcript', run);
  }

  /**
   * Keeps the last confirmed transcript, marks it stale and schedules a bounded backoff
   * retry for transient failures (#295). A deleted session, removed host or unsupported
   * operation clears the queued hints instead of retrying forever.
   */
  private async handleTranscriptFailure(
    sessionID: string,
    serverID: string,
    failure: unknown,
    refreshJobs: boolean,
    dirtyJobs: boolean,
  ): Promise<void> {
    const key = `${serverID} ${sessionID}`;
    const qualifiedKey = this.keyFor(serverID, sessionID);
    const commands = classifyTranscriptFailure({
      key,
      qualifiedKey,
      sessionID,
      serverID,
      current:
        !this.disposed &&
        this.state.sessions[qualifiedKey] !== undefined &&
        this.serverIDs().includes(serverID),
      hasTranscript: this.state.transcripts[qualifiedKey] !== undefined,
      refreshJobs,
      dirtyJobs,
      retryable: transcriptFailureRetryable(failure),
      nextAttempt: () => this.transcriptRetries.next(key),
    });
    for (const command of commands) this.executeTranscriptFailureCommand(command);
  }

  /** Executes one classified transcript-failure effect against the controller's capabilities. */
  private executeTranscriptFailureCommand(command: TranscriptFailureCommand): void {
    switch (command.kind) {
      case 'reset-retries':
        this.transcriptRetries.reset(command.key);
        return;
      case 'mark-stale':
        // The failed response is not authoritative: keep the last confirmed messages.
        this.setState('transcripts', command.qualifiedKey, 'stale', true);
        return;
      case 'refresh-jobs':
        // Job hints are independent of transcript success; do not delay them behind a slow
        // or backoff-scheduled transcript retry (#284, #295).
        this.scheduleJobRefresh(command.sessionID, command.serverID);
        return;
      case 'schedule-retry': {
        const timer = setTimeout(
          () => {
            this.transcriptRetryTimers.delete(command.key);
            if (this.disposed) return;
            this.scheduleTranscript(command.sessionID, command.serverID, command.dirtyJobs);
          },
          retryDelay(
            command.attempt,
            this.deps.transcriptRetryBaseDelayMs ?? transcriptRetryBaseDelayMs,
          ),
        );
        this.transcriptRetryTimers.set(command.key, timer);
        return;
      }
      default:
        return;
    }
  }

  private async fetchLatest(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): Promise<void> {
    const key = this.keyFor(serverID, sessionID);
    const epoch = this.sessionEpoch(key);
    const backend = this.backendFor(serverID);
    // A transcript read may outlive the session it was started for. Ownership is checked
    // after the await, immediately before any cache write (#252).
    if (this.state.sessions[key] === undefined) return;
    // Admission order across *all* callers (SSE refresh and direct attach), not only the
    // serialized schedule path. Two ordinary reads of one live session may overlap; the
    // one admitted later wins even when an older response arrives last (#262).
    const generation = this.transcriptGenerations.nextRead();
    let page: MessagePage;
    try {
      page = await backend.listMessages(sessionID, transcriptPageSize);
    } catch (error) {
      if (
        !this.isSessionCurrent(key, epoch) ||
        !this.isRegisteredBackend(serverID, backend) ||
        this.state.sessions[key] === undefined
      ) {
        return;
      }
      throw error;
    }
    if (
      this.disposed ||
      !this.isSessionCurrent(key, epoch) ||
      !this.isRegisteredBackend(serverID, backend) ||
      this.state.sessions[key] === undefined
    ) {
      return;
    }
    // A newer accepted page is a watermark: this older snapshot must not replace it.
    if (!this.transcriptGenerations.shouldCommit(key, generation)) return;
    const existing = this.state.transcripts[key];
    const merged = mergeLatest(existing?.messages ?? [], page.messages);
    // Cached messages older than this page keep their own cursor/retry state; otherwise the
    // page's cursor is the way further back (an empty placeholder transcript has none).
    // A confirmed-exhausted page must not keep a phantom "earlier" state, even when it still
    // carries a raw token. A failed lookahead keeps the token as a retry path but asserts
    // nothing about whether history exists (#144).
    const keptExisting = merged.length > page.messages.length;
    const freshCursor =
      page.hasEarlier === false && page.retryable !== true ? undefined : page.olderCursor;
    const olderCursor = keptExisting ? existing?.olderCursor : freshCursor;
    const olderCheckFailed = keptExisting ? existing?.olderCheckFailed : page.retryable === true;
    this.setState(
      'transcripts',
      produce((transcripts) => {
        transcripts[key] = {
          messages: merged,
          loading: false,
          stale: false,
          ...(olderCursor === undefined ? {} : { olderCursor }),
          ...(olderCheckFailed === true ? { olderCheckFailed: true } : {}),
        };
      }),
    );
    this.touchTranscript(key);
    this.transcriptGenerations.commit(key, generation);
    // The latest page is canonical for the session's current agent. Adopt a genuinely
    // newer switch (possibly made in another client) without letting an older cached
    // transcript message displace a fresh local acknowledgement (#253).
    this.adoptTranscriptAgent(key);
  }

  async loadOlder(sessionID: string, serverID: string = this.activeServerID()): Promise<void> {
    const key = this.keyFor(serverID, sessionID);
    const transcript = this.state.transcripts[key];
    if (transcript?.olderCursor === undefined || transcript.loading) return;
    const epoch = this.sessionEpoch(key);
    const backend = this.backendFor(serverID);
    this.setState('transcripts', key, 'loading', true);
    try {
      const page = await backend.listMessages(
        sessionID,
        transcriptPageSize,
        transcript.olderCursor,
      );
      // Never recreate a transcript that was deleted, evicted or replaced while paging (#252).
      if (
        this.disposed ||
        !this.isSessionCurrent(key, epoch) ||
        !this.isRegisteredBackend(serverID, backend) ||
        this.state.transcripts[key] === undefined
      ) {
        return;
      }
      const known = new Set(
        (this.state.transcripts[key]?.messages ?? []).map((message) => message.id),
      );
      const older = page.messages.filter((message) => !known.has(message.id));
      // Replace via produce: a merging setter would keep a stale cursor after the last page.
      this.setState(
        'transcripts',
        key,
        produce((current) => {
          current.messages = [...older, ...current.messages];
          current.loading = false;
          // Only a *confirmed* exhaustion clears the cursor. A failed lookahead keeps the
          // page's token as a retry path and records that the check is unverified (#144).
          if (page.hasEarlier === false && page.retryable !== true) delete current.olderCursor;
          else if (page.olderCursor !== undefined) current.olderCursor = page.olderCursor;
          if (page.retryable === true) current.olderCheckFailed = true;
          else delete current.olderCheckFailed;
        }),
      );
      this.touchTranscript(key);
    } catch (error) {
      // A failure from a retired lifetime says nothing about the current one; do not
      // surface it as a notice for a session the user no longer has.
      if (
        !this.isSessionCurrent(key, epoch) ||
        !this.isRegisteredBackend(serverID, backend) ||
        this.state.transcripts[key] === undefined
      ) {
        return;
      }
      this.setState('transcripts', key, 'loading', false);
      throw error;
    }
  }

  /** Rendered node limit for a session's transcript. */
  transcriptWindow(sessionID: string, serverID: string = this.activeServerID()): number {
    return this.state.transcriptWindow[this.keyFor(serverID, sessionID)] ?? transcriptWindowStep;
  }

  /**
   * Reveals every already-loaded node without fetching an older page. Ctrl+Home uses this
   * so it reaches the earliest *loaded* message while the existing "earlier messages"
   * marker still tells the reader when server history remains (#251).
   */
  revealAllLoaded(
    sessionID: string,
    hiddenNodes: number,
    serverID: string = this.activeServerID(),
  ): boolean {
    if (hiddenNodes <= 0) return false;
    const key = this.keyFor(serverID, sessionID);
    this.setState(
      'transcriptWindow',
      key,
      this.transcriptWindow(sessionID, serverID) + hiddenNodes,
    );
    return true;
  }

  /**
   * Expands the render window far enough to include one semantic node. Keyboard focus can
   * move to an item older than the current window; that item must be rendered and scrolled
   * into view before Enter can act on it (#242). Only loaded nodes are changed.
   */
  ensureTranscriptNodeVisible(
    sessionID: string,
    nodeKey: string,
    serverID: string = this.activeServerID(),
  ): boolean {
    const route = this.state.route;
    if (route.kind !== 'conversation') return false;
    if (route.serverID !== serverID || route.sessionID !== sessionID) return false;
    const nodes = this.conversationNodes();
    const index = nodes.findIndex((node) => node.key === nodeKey);
    if (index < 0) return false;
    // Leave a few rows of context around the target rather than pinning it to the edge.
    const needed = nodes.length - index + 8;
    if (this.transcriptWindow(sessionID, serverID) < needed) {
      this.setState('transcriptWindow', this.keyFor(serverID, sessionID), needed);
    }
    return true;
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

  /**
   * Bounded LRU of cached transcripts; detached sessions keep summaries only. Both the
   * session count and approximate retained bytes are bounded (#289). The active route and
   * an in-flight read are never evicted, so a slow refresh cannot lose its destination and
   * reopening an evicted session refetches the latest page normally.
   */
  private touchTranscript(key: string): void {
    const plan = planTranscriptEviction({
      order: this.transcriptOrder,
      touched: key,
      sizes: (entry) =>
        approximateTranscriptBytes(this.state.transcripts[entry]?.messages ?? []).total,
      activeKey:
        this.state.route.kind === 'conversation'
          ? this.keyFor(this.state.route.serverID, this.state.route.sessionID)
          : undefined,
      inFlight: this.inFlightTranscriptKeys(),
      countLimit: transcriptCacheLimit,
      byteBudget: this.deps.transcriptCacheBytes ?? transcriptCacheByteLimit,
    });
    this.transcriptOrder = plan.order;
    if (plan.evicted.length === 0) return;
    this.setStateTouchingOverview(
      produce((state) => {
        for (const entry of plan.evicted) delete state.transcripts[entry];
      }),
    );
  }

  /** Session keys whose transcript read is still allowed to commit. */
  private inFlightTranscriptKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const entry of this.transcriptFlights.inFlightKeys()) {
      const separator = entry.indexOf(' ');
      if (separator <= 0) continue;
      keys.add(this.keyFor(entry.slice(0, separator), entry.slice(separator + 1)));
    }
    return keys;
  }

  private async loadConversation(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): Promise<void> {
    await Promise.all([
      this.fetchLatest(sessionID, serverID),
      this.refreshWorkers(sessionID, serverID),
      this.refreshShellJobs(sessionID, serverID),
      this.refreshInbox(sessionID, serverID),
      this.refreshInputRequests(sessionID, serverID),
      this.refreshSummary(sessionID, serverID),
      this.refreshNativeGoal(sessionID, serverID),
    ]);
  }

  // ---------------------------------------------------------------- navigation

  /** View change only: no backend mutation. Drafts are kept per route. */
  openSession(sessionID: string, serverID: string = this.serverID): void {
    this.interactionGeneration += 1;
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
      this.setState('permissionFocused', false);
      this.setStateTouchingOverview('openedAt', this.keyFor(serverID, sessionID), this.deps.now());
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
    this.interactionGeneration += 1;
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
    this.interactionGeneration += 1;
    this.debugLog.write('route', { kind: 'overview' });
    this.saveDraft();
    this.invalidateCompletion();
    const project = this.currentProject();
    batch(() => {
      this.setState('route', { kind: 'overview' });
      this.setState('overlay', { kind: 'none' });
      this.setState('completion', undefined);
      this.setState('focusedGroup', undefined);
      this.writeComposer(this.state.drafts['overview'] ?? emptyComposer, false);
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
  private writeComposer(composer: Composer, draftEdit = true): void {
    if (draftEdit) {
      const key = this.routeKey(this.state.route);
      this.drafts.bump(key);
    }
    this.setState({ composer: { ...composer } });
  }

  private draftRevision(key: string): number {
    return this.drafts.revision(key);
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
    return this.drafts.keyFor(route);
  }

  /** Restores a route's saved text and its attachments together. */
  private restoreDraft(key: string): void {
    batch(() => {
      this.writeComposer(this.state.drafts[key] ?? emptyComposer, false);
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

  /**
   * Moves the overview selection by roughly one viewport (#238). Paging is a list
   * gesture: it never moves focus into the composer, and an unfocused composer keeps
   * its draft untouched. A missing selection starts from the nearest edge.
   */
  moveOverviewPage(direction: -1 | 1, pageRows: number): void {
    if (this.state.overview.focus !== 'list') return;
    const rows = this.overviewRows();
    if (rows.length === 0) return;
    const current = this.state.overview.selectedRow;
    const index = current === undefined ? -1 : rows.findIndex((row) => row.key === current);
    const start = index < 0 ? (direction === 1 ? -1 : rows.length) : index;
    const step = Math.max(1, Math.floor(pageRows));
    const next = Math.min(rows.length - 1, Math.max(0, start + direction * step));
    const row = rows[next];
    if (row !== undefined) batch(() => this.selectRow(row));
  }

  /** Ctrl+Home/Ctrl+End in the overview select the first/last available row (#238). */
  selectOverviewEdge(edge: 'first' | 'last'): void {
    if (this.state.overview.focus !== 'list') return;
    const rows = this.overviewRows();
    const row = edge === 'first' ? rows[0] : rows[rows.length - 1];
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
   * One terminal paste. Clipboard MIME/kind metadata (when the terminal supplies it) is
   * authoritative: binary data is never decoded into the text draft, and text declared as
   * text stays text even if it begins with a file signature. Otherwise a validated binary
   * signature wins over a UTF-8 text fallback so an ASCII-only PDF becomes an attachment
   * (#155). Every paste type, including raw bytes, is bound to the route captured here, so a
   * queued paste cannot land on a different session or host (#154).
   */
  async pasteBytes(
    bytes: Uint8Array,
    metadata?: { mimeType?: string; kind?: 'text' | 'binary' | 'unknown' },
  ): Promise<void> {
    // Serialize paste transactions in arrival order. The originating route is captured
    // synchronously here (before `run` is deferred onto the microtask queue) so a route
    // switch while files are read cannot retarget the paste (issues #87, #154).
    if (this.disposed) return;
    const originKey = this.routeKey(this.state.route);
    // Bind the paste to the question that is active *now*, before the ordered paste queue
    // defers it. A later close/reopen must drop this paste, never retarget it (#229).
    const formOrigin = this.pasteFormOrigin();

    const run = async (): Promise<void> => {
      if (this.disposed) return;

      const declaredMime = metadata?.mimeType?.toLowerCase();
      const textDeclared =
        metadata?.kind === 'text' ||
        (declaredMime !== undefined && declaredMime.startsWith('text/'));
      const binaryDeclared = metadata?.kind === 'binary';

      let mime: string | undefined;
      if (!textDeclared) {
        mime = detectAttachmentMime(bytes);
        // A short %PDF- prefix is not a PDF on its own; an unannotated clipboard clip that
        // merely looks like text stays text unless it carries a real PDF header and trailer.
        if (mime === 'application/pdf' && !isBinaryPdfPayload(bytes) && !binaryDeclared)
          mime = undefined;
        if (mime === undefined && binaryDeclared) {
          // Trust the clipboard type for binaries without a signature of their own.
          if (declaredMime !== undefined && isSupportedAttachmentMime(declaredMime))
            mime = declaredMime;
        }
      }

      if (formOrigin !== undefined) {
        if (mime !== undefined || binaryDeclared) {
          this.showNotice(
            'Questions accept pasted text only; attach files from the composer.',
            'warn',
          );
          return;
        }
        const text = decodePastedText(bytes);
        if (text === undefined) {
          this.showNotice('Pasted data is not text.', 'warn');
          return;
        }
        this.pasteIntoForm(text, formOrigin);
        return;
      }

      if (mime !== undefined) {
        const name = `clipboard.${mime.split('/').at(-1) ?? 'bin'}`;
        const attached = makeAttachment(name, mime, bytes);
        if (!attached.ok) {
          this.showNotice(attached.error, 'warn');
          return;
        }
        // A raw image/PDF paste is held to the same origin-route guard as text and file paths.
        if (!this.pasteStillCurrent(originKey)) {
          this.stashPaste(originKey, [attached.attachment]);
          return;
        }
        this.addAttachments([attached.attachment], `${name} attached`);
        return;
      }

      if (!binaryDeclared) {
        const text = decodePastedText(bytes);
        if (text !== undefined) {
          const consumed = await this.attachPastedPaths(text, originKey);
          if (consumed) return;
          this.insertPastedText(text, originKey);
          return;
        }
      }
      this.showNotice('Pasted data is not text or a supported image.', 'warn');
    };
    this.pasteChain = this.pasteChain.then(run).catch(() => undefined);
    await this.pasteChain;
  }

  /** The open question overlay, captured with its token so an async paste cannot retarget. */
  private pasteFormOrigin(): { token: number } | undefined {
    return this.state.overlay.kind === 'form'
      ? { token: this.state.overlay.requestToken }
      : undefined;
  }

  /**
   * One text paste into the active question field. It is deliberately not routed through
   * the composer: newlines stay literal, shortcut-looking text is not interpreted, and a
   * route/overlay change drops the transaction instead of leaking it (#210).
   */
  private pasteIntoForm(text: string, origin: { token: number }): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'form' || overlay.requestToken !== origin.token) {
      this.showNotice('Question changed before the paste landed; nothing was inserted.', 'warn');
      return;
    }
    const form = this.openFormRequest();
    if (form === undefined) {
      this.showNotice('This question was answered or withdrawn.', 'dim');
      return;
    }
    const clean = sanitizeTerminalText(text);
    const bounded = clean.length > 65_536 ? clean.slice(0, 65_536) : clean;
    const result = pasteFormText(form, overlay.editor, bounded);
    if (result.error !== undefined) {
      this.showNotice(result.error, 'warn');
      return;
    }
    this.setState('overlay', { ...overlay, editor: result.editor });
    if (bounded.length < clean.length) {
      this.showNotice('Paste truncated to 65,536 characters.', 'warn');
    }
  }

  /**
   * One paste into a searchable modal overlay (#239). Text only, sanitized and bounded;
   * binary clipboard data is refused rather than retargeted to the composer or a draft.
   * Returns true when the paste belonged to an overlay and must not reach the composer.
   */
  pasteIntoOverlay(
    bytes: Uint8Array,
    metadata?: { mimeType?: string; kind?: 'text' | 'binary' | 'unknown' },
  ): boolean {
    const overlay = this.state.overlay;
    if (overlay.kind === 'none' || overlay.kind === 'form') return false;
    if (overlay.kind === 'help') {
      // Help is dismiss-on-paste; the same paste still belongs to the composer behind it.
      this.closeOverlay();
      return false;
    }
    const declaredMime = metadata?.mimeType?.toLowerCase();
    const textDeclared =
      metadata?.kind === 'text' || (declaredMime !== undefined && declaredMime.startsWith('text/'));
    const binaryDeclared = metadata?.kind === 'binary';
    if (binaryDeclared || (!textDeclared && declaredMime !== undefined)) {
      this.showNotice('This dialog accepts pasted text only.', 'warn');
      return true;
    }
    const text = decodePastedText(bytes);
    if (text === undefined) {
      this.showNotice('Pasted data is not text.', 'warn');
      return true;
    }
    // Search fields are single-line: newlines become spaces, never submit anything.
    const clean = sanitizeTerminalText(text)
      .replace(/\s*\r?\n\s*/g, ' ')
      .trim();
    if (clean === '') return true;
    const bounded = clean.slice(0, 4096);
    switch (overlay.kind) {
      case 'model-picker':
        this.setModelPickerQuery(overlay.query + bounded);
        break;
      case 'effort-picker':
        this.setEffortPickerQuery(overlay.query + bounded);
        break;
      case 'agent-picker':
        this.setAgentPickerQuery(overlay.query + bounded);
        break;
      case 'copy-picker':
        this.setCopyPickerQuery(overlay.query + bounded);
        break;
      case 'history-search':
        this.setHistoryQuery(overlay.query + bounded);
        break;
      case 'inspector': {
        const composer = overlay.searching
          ? { text: overlay.query, cursor: overlay.queryCursor }
          : { text: '', cursor: 0 };
        this.setInspectorSearch(insertText(composer, bounded));
        break;
      }
      default:
        // Non-editable modal: consume the paste, leaving the draft untouched.
        break;
    }
    if (bounded.length < clean.length) {
      this.showNotice('Paste truncated to 4,096 characters.', 'warn');
    }
    return true;
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
      `Paste stashed: the route changed while reading ${added.length} attachment(s); they await in the originating draft.`,
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
    this.setStateTouchingOverview(
      produce((state) => {
        if (state.overview.expanded[groupKey] === true) delete state.overview.expanded[groupKey];
        else state.overview.expanded[groupKey] = true;
      }),
    );
    // Collapsing while a child row is selected would leave an invisible selection. Move
    // it to the group's toggle, which remains on screen (#240).
    if (this.state.overview.focus !== 'list') return;
    const selected = this.state.overview.selectedRow;
    const rows = this.overviewRows();
    if (selected !== undefined && rows.some((row) => row.key === selected)) return;
    const toggle = rows.find((row) => row.kind === 'toggle' && row.groupKey === groupKey);
    if (toggle !== undefined) this.selectRow(toggle);
    else this.setState('overview', 'selectedRow', undefined);
  }

  /** One click on an overview row selects and activates it, matching Enter (#247). */
  clickOverviewRow(key: string): void {
    const row = this.overviewRows().find((entry) => entry.key === key);
    if (row === undefined) return;
    batch(() => {
      this.selectRow(row);
      this.attachSelected();
    });
  }

  // ---------------------------------------------------------------- composer

  /** Records a user edit so it can be undone; consecutive typing collapses into one step. */
  private recordEdit(next: Composer): void {
    this.editHistory.record(this.routeKey(this.state.route), this.state.composer, next, this.now());
  }

  /** Undo the last edit on this route; restoring does not touch attachments. */
  undo(): void {
    const previous = this.editHistory.undo(this.routeKey(this.state.route), this.state.composer);
    if (previous !== undefined) this.writeComposer(previous);
  }

  /** Redo an edit that was just undone on this route. */
  redo(): void {
    const next = this.editHistory.redo(this.routeKey(this.state.route), this.state.composer);
    if (next !== undefined) this.writeComposer(next);
  }

  /** Sending an acknowledged prompt checkpoints the draft: no undo across sent turns. */
  private clearEdits(): void {
    this.editHistory.clear(this.routeKey(this.state.route));
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

  /** Captures the active route's draft identity before opening the external editor (#271). */
  captureExternalEditOrigin(): ExternalEditOrigin {
    const route = this.state.route;
    const key = this.routeKey(route);
    return {
      routeKey: key,
      kind: route.kind,
      label: this.describeRoute(route),
      ...(route.kind === 'overview' ? {} : { serverID: route.serverID }),
      ...(route.kind === 'conversation' ? { sessionID: route.sessionID } : {}),
      ...(route.kind === 'conversation'
        ? { epoch: this.sessionEpoch(this.keyFor(route.serverID, route.sessionID)) }
        : {}),
      text: this.state.composer.text,
      cursor: this.state.composer.cursor,
      attachmentIDs: this.state.attachments.map((attachment) => attachment.id),
      revision: this.draftRevision(key),
    };
  }

  /**
   * Applies an external-editor result to the draft that started the edit. It never navigates,
   * never touches another route, and never overwrites a newer draft: an unmatched result is
   * written to a client-local recovery file and reported instead of being lost (#271).
   */
  async applyExternalEdit(
    origin: ExternalEditOrigin,
    text: string,
  ): Promise<'composer' | 'draft' | 'recovery'> {
    const currentKey = this.routeKey(this.state.route);
    if (currentKey === origin.routeKey) {
      if (
        this.originStillExists(origin) &&
        this.draftRevision(origin.routeKey) === origin.revision &&
        this.matchesEditOrigin(this.state.composer, this.state.attachments, origin)
      ) {
        this.setComposer(composerFrom(text));
        return 'composer';
      }
      await this.saveEditorRecovery(text, origin.label);
      return 'recovery';
    }
    const draft = this.state.drafts[origin.routeKey] ?? emptyComposer;
    const attachments = this.state.draftAttachments[origin.routeKey] ?? [];
    if (
      this.originStillExists(origin) &&
      this.draftRevision(origin.routeKey) === origin.revision &&
      this.matchesEditOrigin(draft, attachments, origin)
    ) {
      this.setState('drafts', origin.routeKey, composerFrom(text));
      this.showNotice(`External edit saved to the ${origin.label} draft.`, 'dim');
      return 'draft';
    }
    await this.saveEditorRecovery(text, origin.label);
    return 'recovery';
  }

  private matchesEditOrigin(
    composer: Composer,
    attachments: readonly Attachment[],
    origin: ExternalEditOrigin,
  ): boolean {
    if (composer.text !== origin.text || composer.cursor !== origin.cursor) return false;
    if (attachments.length !== origin.attachmentIDs.length) return false;
    return attachments.every((attachment, index) => attachment.id === origin.attachmentIDs[index]);
  }

  private originStillExists(origin: ExternalEditOrigin): boolean {
    if (origin.kind === 'overview') return true;
    if (origin.serverID === undefined || !this.serverIDs().includes(origin.serverID)) return false;
    if (origin.kind === 'new') return true;
    if (origin.sessionID === undefined) return false;
    const key = this.keyFor(origin.serverID, origin.sessionID);
    if (origin.epoch !== undefined && this.sessionEpoch(key) !== origin.epoch) return false;
    return this.state.sessions[key] !== undefined;
  }

  private describeRoute(route: Route): string {
    switch (route.kind) {
      case 'overview':
        return 'overview';
      case 'new':
        return `new session in ${route.directory}`;
      case 'conversation':
        return (
          this.state.sessions[this.keyFor(route.serverID, route.sessionID)]?.title ??
          route.sessionID
        );
      default:
        return 'draft';
    }
  }

  private async saveEditorRecovery(text: string, label: string): Promise<void> {
    const dir = this.deps.copyFallbackDir ?? this.deps.cwd;
    this.editorRecoverySeq += 1;
    const path = join(
      dir,
      `marg-editor-${process.pid}-${this.deps.now()}-${this.editorRecoverySeq}.txt`,
    );
    try {
      const write =
        this.deps.writeFile ??
        (async (file: string, body: string) => void (await Bun.write(file, body)));
      await write(path, text);
      this.showNotice(
        `External edit for ${label} was not applied (its draft changed or disappeared); saved to ${path}.`,
        'warn',
      );
    } catch (error) {
      this.showNotice(
        `External edit for ${label} was not applied and could not be saved: ${errorText(error)}`,
        'error',
      );
    }
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
      : (await this.filesFor(root, serverID)).files;
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
    // Agents complete bare `@name` mentions from the verified snapshot for THIS exact scope,
    // visibly distinguished from files by their detail label (#99/#133/#134). Using the
    // snapshot rather than the mutable global state keeps completion consistent with final
    // submission and never suggests another project's agents during a catalog load.
    const mentionable = this.catalogSnapshots.get(this.catalogScope(root, serverID))?.mentionable;
    const agentItems =
      partial === '' || /[\\/.]/.test(partial)
        ? []
        : (mentionable ?? [])
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
      .map((path) => ({
        label: `@${path}`,
        detail: '',
        // A name with whitespace is inserted quoted so it parses back as one reference (#203).
        insert: /\s/.test(path) ? `@"${path}" ` : `@${path} `,
      }));
    const items = [...agentItems, ...fileItems];
    this.setState(
      'completion',
      items.length === 0 ? undefined : { kind: 'file', items, index: 0, start },
    );
  }

  /**
   * Shared, single-flight scan per host-qualified directory. Concurrent mentions during one
   * scan all await the same traversal. Complete results are authoritative; incomplete results
   * retain their partial matches but become retryable after a bounded backoff (#300).
   */
  private filesFor(root: string, serverID: string): Promise<ProjectFileListing> {
    const key = `${serverID}\u0000${root}`;
    const cache = this.fileCache;
    if (cache?.key === key) {
      const notBefore =
        cache.scannedAt +
        Math.min(
          incompleteFileRetryMaxMs,
          incompleteFileRetryBaseMs * 2 ** Math.max(0, cache.failures - 1),
        );
      if (cache.complete || this.deps.now() < notBefore) {
        return Promise.resolve({
          files: cache.files,
          complete: cache.complete,
          ...(cache.detail === undefined ? {} : { detail: cache.detail }),
        });
      }
    }
    const existing = this.fileScans.get(key);
    if (existing !== undefined) return existing;
    const work = this.deps
      .listFiles(root)
      .then((result) => {
        const listing = Array.isArray(result) ? { files: result, complete: true } : result;
        const previous = this.fileCache?.key === key ? this.fileCache : undefined;
        const detail =
          listing.complete || listing.detail !== undefined
            ? listing.detail
            : 'scan did not cover the whole project';
        this.fileCache = {
          key,
          files: [...listing.files],
          complete: listing.complete,
          scannedAt: this.deps.now(),
          failures: listing.complete ? 0 : (previous?.failures ?? 0) + 1,
          ...(detail === undefined ? {} : { detail }),
        };
        return {
          files: this.fileCache.files,
          complete: this.fileCache.complete,
          ...(detail === undefined ? {} : { detail }),
        };
      })
      .finally(() => {
        this.fileScans.delete(key);
      });
    this.fileScans.set(key, work);
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
    this.setOverlay({
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
    const current = [...(this.persistence.state.history[key] ?? [])];
    const entries = [...current];
    const seen = new Set(entries);
    for (const candidate of legacyProjectKeys(
      { serverID, directory },
      this.platformFor(serverID),
    )) {
      if (candidate.platform === 'win32' && this.win32FoldClaims(candidate.key, serverID) !== 1)
        continue;
      for (const entry of this.persistence.state.history[candidate.key] ?? []) {
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
    // Remember which bucket is on screen and invalidate admissions captured before the
    // switch (#160). A late send from A must never repaint B's visible history.
    this.setState('historyScope', { serverID, directory });
    this.setState('historyGeneration', (generation) => generation + 1);
  }

  private rememberPrompt(
    text: string,
    directory: string,
    serverID: string = this.serverID,
    expectedGeneration?: number,
  ): void {
    const key = this.projectKeyOf(directory, serverID);
    // Derive prior entries from the target project's persisted bucket, never from whichever
    // project's state.history happens to be in memory (issue #107).
    const prior = this.historyEntriesFor(directory, serverID, key);
    const history = recordEntry(
      { entries: prior, savedDraft: '' },
      text,
      this.deps.config.history.limit,
    );
    // Persist to the owning project unconditionally, but only repaint the visible history
    // when its scope still matches and no newer load has happened in the meantime (#160).
    this.persistence.patch({
      history: { ...this.persistence.state.history, [key]: history.entries },
    });
    const scope = this.state.historyScope;
    if (
      scope !== undefined &&
      this.projectKeyOf(scope.directory, scope.serverID) === key &&
      (expectedGeneration === undefined || this.state.historyGeneration === expectedGeneration)
    ) {
      this.setState('history', history);
    }
  }

  // ---------------------------------------------------------------- submit

  /** Enter. Clears the composer only after the server accepted the input. */
  async submit(deliveryOverride?: Delivery): Promise<void> {
    const routeAtSubmit = this.state.route;
    if (
      routeAtSubmit.kind === 'conversation' &&
      this.admissions.isAdmitting(this.keyFor(routeAtSubmit.serverID, routeAtSubmit.sessionID))
    ) {
      // A send to the SAME session is still in flight; never silently discard the new one
      // (#163). Other sessions and hosts stay independent.
      this.showNotice(
        'A prompt is still being sent from this session. Wait for confirmation before sending again.',
        'dim',
        false,
      );
      return;
    }
    const text = this.state.composer.text;
    if (text.trim() === '' && this.state.attachments.length === 0) return;
    if (this.state.startup.phase === 'loading') {
      const queuedName = /^\/(\S+)/.exec(text.trimStart())?.[1];
      // Local controls stay available; anything that needs an authoritative catalog or
      // session selection waits for startup instead of failing against partial state (#287).
      if (queuedName === undefined || !isLocalCommand(queuedName)) {
        this.showNotice(
          'Still loading sessions and the project catalog. Try again in a moment.',
          'dim',
          false,
        );
        return;
      }
    }
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
        (routeAtSubmit.kind === 'conversation' &&
          (parsed.name === 'compact' ||
            parsed.name === 'steer' ||
            (parsed.name === 'plan' && parsed.args === 'propose')) &&
          this.modelDispatchBlocked(routeAtSubmit.serverID, routeAtSubmit.sessionID)) ||
        (routeAtSubmit.kind === 'conversation' &&
          this.agentDispatchBlocked(routeAtSubmit.serverID, routeAtSubmit.sessionID))
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
            if (
              this.modelDispatchBlocked(origin.serverID, origin.sessionID) ||
              this.agentDispatchBlocked(origin.serverID, origin.sessionID)
            )
              return false;
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
    const admitKey = this.keyFor(origin.serverID, origin.sessionID);
    if (
      admissionBlock({
        alreadyAdmitting: this.admissions.isAdmitting(admitKey),
        modelBlocked: this.modelDispatchBlocked(origin.serverID, origin.sessionID),
        agentBlocked: this.agentDispatchBlocked(origin.serverID, origin.sessionID),
      }) !== null
    )
      return false;
    this.admissions.begin(admitKey);
    // Captured before the async send: navigation can load another project's history while
    // the server responds, and that newer load must not be repainted by this admission (#160).
    const historyGeneration = this.state.historyGeneration;
    try {
      let outcome: SendOutcome;
      try {
        outcome = (await send()) ? { kind: 'accepted' } : { kind: 'declined' };
      } catch (error) {
        outcome = classifySendError(error);
      }
      const resolution = resolveAdmission(
        {
          serverID: origin.serverID,
          sessionID: origin.sessionID,
          text,
          directory,
          historyGeneration,
          routeIsOrigin: isOriginRoute(this.state.route, origin.serverID, origin.sessionID),
          transportNotice,
          sentAttachments,
        },
        outcome,
      );
      for (const command of resolution.commands) this.executeAdmissionCommand(command);
      return resolution.outcome === 'admitted';
    } finally {
      this.admissions.end(admitKey);
    }
  }

  /** Executes one admitted submission effect against this controller's owned capabilities. */
  private executeAdmissionCommand(command: AdmissionCommand): void {
    switch (command.kind) {
      case 'log-accepted':
        this.debugLog.write('action', { action: 'submit', ok: true });
        return;
      case 'log-failed':
        this.debugLog.write('action', {
          action: 'submit',
          ok: false,
          errorKind: command.errorKind,
        });
        return;
      case 'remember-prompt':
        this.rememberPrompt(
          command.text,
          command.directory,
          command.serverID,
          command.historyGeneration,
        );
        return;
      case 'clear-composer':
        this.clearComposer(command.text, command.sentAttachments);
        return;
      case 'show-notice':
        this.showNotice(command.message, 'error');
        return;
      case 'schedule-transcript':
        // The request may have landed. Show server state instead of resending blindly.
        this.scheduleTranscript(command.sessionID);
        return;
      case 'refresh-inbox':
        void this.track('inbox', this.refreshInbox(command.sessionID, command.serverID));
        return;
      default:
        return;
    }
  }

  private clearComposer(submitted: string, sentAttachments: readonly Attachment[] = []): void {
    const clearance = composerClearance(
      this.state.composer.text,
      submitted,
      sentAttachments.map((attachment) => attachment.id),
    );
    batch(() => {
      if (clearance.clearText) {
        this.writeComposer(emptyComposer);
        this.clearEdits();
        this.setState('completion', undefined);
        this.setState('focusedGroup', undefined);
      }
      // Sent attachments are gone even if the user typed more while the request was in flight.
      if (clearance.sentIDs.size > 0) {
        this.setState(
          'attachments',
          this.state.attachments.filter((attachment) => !clearance.sentIDs.has(attachment.id)),
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
   * Verified agent IDs for a prompt's exact `(server, canonical directory)` scope (#133/#134).
   * Reads only the immutable snapshot captured at load time for that scope - never the mutable
   * `state.agents`/`state.mentionAgents`, which may still describe another project mid-load. A
   * bare `@name` is ambiguous until this scope's catalog is confirmed; if it cannot be, we throw
   * so `admit` preserves the draft and shows an actionable error instead of silently dropping
   * mention semantics. File-only prompts need no agent catalog and are unaffected.
   */
  private async verifiedMentionIDs(
    text: string,
    directory: string,
    serverID: string,
  ): Promise<ReadonlySet<string>> {
    if (!findFileMentions(text).some(isBareAgentNameMention)) return new Set();
    if (!(await this.ensureCatalog(directory, serverID))) {
      throw new Error(
        'Cannot verify the agent catalog for this project. Your prompt was not sent; ' +
          'try again once the project catalog is available.',
      );
    }
    const snapshot = this.catalogSnapshots.get(this.catalogScope(directory, serverID));
    if (snapshot === undefined) {
      throw new Error(
        'Cannot verify agent mentions for this project. Your prompt was not sent; try again.',
      );
    }
    return snapshot.mentionIDs;
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
    const agentIDs = await this.verifiedMentionIDs(text, directory, serverID);
    const agentRefs = agentMentions(findFileMentions(text), agentIDs);
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
    const resolution = this.resolveModelFor(serverID, directory, model);
    if (resolution.kind === 'blocked') {
      this.setState('admitting', false);
      this.showNotice(
        `Model ${formatModelRef(resolution.model)} is unavailable for ${directory} on ${serverID}. No prompt sent.`,
        'error',
      );
      return undefined;
    }
    const scopedModel = resolution.kind === 'model' ? resolution.model : undefined;
    // The server default is passed through as before; every other source is a deliberate
    // choice and must be confirmed by the server before anything billable is admitted.
    const confirmModel =
      resolution.kind === 'model' && resolution.source !== 'server-default'
        ? resolution.model
        : undefined;
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
    if (confirmModel !== undefined) {
      // V2 resolves a missing model at first prompt. Verify the server actually stored
      // our explicit selection before admitting anything billable. Repair an ignored
      // create-time selection once, and fail closed if it still does not match.
      const backend = this.backendFor(serverID);
      try {
        let confirmed = await backend.getSession(session.id);
        if (confirmed.model === undefined || !sameModel(confirmed.model, confirmModel)) {
          await backend.switchModel(session.id, confirmModel);
          confirmed = await backend.getSession(session.id);
        }
        if (confirmed.model === undefined || !sameModel(confirmed.model, confirmModel)) {
          throw new Error(
            `server reported ${confirmed.model === undefined ? 'no model' : formatModelRef(confirmed.model)}`,
          );
        }
        session = confirmed;
        this.recordConfirmedModel(serverID, directory, confirmModel);
      } catch (error) {
        this.setState('admitting', false);
        this.showNotice(
          `Session ${session.id} created, but model ${formatModelRef(confirmModel)} was not confirmed. Prompt not sent: ${errorText(error)}`,
          'error',
        );
        return session.id;
      }
    }
    this.setState('admitting', false);
    const sessionServerID = session.serverID ?? serverID;
    this.setStateTouchingOverview('sessions', this.keyFor(sessionServerID, session.id), {
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
        if (
          this.modelDispatchBlocked(sessionServerID, session.id) ||
          this.agentDispatchBlocked(sessionServerID, session.id)
        )
          return false;
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
  /**
   * Latest root session for `directory` on the explicit target host (#152). Every candidate
   * is server-scoped before timestamp comparison and normalized with its owning host's path
   * style, so an identically named project on another machine can never win.
   */
  async findLatestSessionIn(
    directory: string,
    serverID: string = this.serverID,
  ): Promise<SessionSummary | undefined> {
    const key = directoryKey(directory, this.platformFor(serverID));
    const directoryQuery = { directory };
    let cursor: string | undefined;
    let pages = 0;
    let best: SessionSummary | undefined;
    try {
      do {
        const page = await this.backendFor(serverID).listSessions(
          cursor === undefined ? directoryQuery : { directory, cursor },
        );
        for (const session of page.sessions) {
          if (session.archived || session.parentID !== undefined) continue;
          // A row from another host is never eligible, even if it shares the directory.
          if ((session.serverID ?? serverID) !== serverID) continue;
          if (
            directoryKey(session.directory, this.platformFor(session.serverID ?? serverID)) !== key
          )
            continue;
          if (best === undefined || session.updatedAt > best.updatedAt) best = session;
        }
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== undefined && pages < 50);
    } catch (error) {
      if (best === undefined) {
        // A transport/auth failure is not evidence that directory filtering is unsupported.
        // Never guess a session from cached state after such a failure (#152): surface it so
        // the CLI can report an actionable error instead of choosing another host's project.
        if (
          error instanceof BackendError &&
          (error.kind === 'transport' || error.kind === 'unauthorized' || error.kind === 'unknown')
        ) {
          this.debugLog.write('find-latest-unavailable', { serverID, error: errorText(error) });
          throw error;
        }
        // Unsupported parameter (invalid/not-found on older builds): best-effort fallback,
        // now scoped to the target host and its path style.
        this.debugLog.write('find-latest-fallback', { serverID, error: errorText(error) });
        return this.latestSessionInState(directory, serverID);
      }
    }
    if (best !== undefined) this.storeSessionSummary(best);
    return best;
  }

  /** Fallback used only when the target server cannot filter by directory: match loaded pages. */
  private latestSessionInState(
    directory: string,
    serverID: string = this.serverID,
  ): SessionSummary | undefined {
    const key = directoryKey(directory, this.platformFor(serverID));
    return Object.values(this.state.sessions)
      .filter(
        (session) =>
          session.serverID === serverID &&
          !session.archived &&
          session.parentID === undefined &&
          directoryKey(session.directory, this.platformFor(session.serverID)) === key,
      )
      .toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
  }

  /** Stores a fetched/resolved summary before it is attached or prompted. */
  private storeSessionSummary(session: SessionSummary): void {
    const serverID = session.serverID ?? this.serverID;
    const key = this.keyFor(serverID, session.id);
    this.setStateTouchingOverview(
      'sessions',
      key,
      this.withConfirmedModel(key, { ...session, serverID }),
    );
  }

  /**
   * Makes sure a session the user asked for (e.g. --resume <id>) is known before we
   * open or prompt it. Returns the summary, or undefined when the server cannot find it.
   */
  async ensureSession(
    sessionID: string,
    active = this.activeServerID(),
    options: { onlyServer?: boolean } = {},
  ): Promise<SessionSummary | undefined> {
    // CLI targets that already carry an owning server must never search unrelated hosts:
    // a colliding ID on another machine cannot be mistaken for this one (#149).
    const candidates = options.onlyServer === true ? [active] : this.serverIDs();
    // The session may belong to any registered host, not just the one the route currently
    // shows: qualify by session ID across every server before picking a backend.
    for (const serverID of [active, ...candidates.filter((id) => id !== active)]) {
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

  /**
   * Resolves a CLI `--resume` ID to a server-qualified ref (#149). An explicit target host
   * (`--remote`/`--server`) is authoritative and no other host is consulted. When the host is
   * unspecified, a colliding ID on multiple cached hosts is ambiguous and fails with an
   * actionable message rather than silently picking one; a single cached match (or, failing
   * that, the launch host's own lookup) is used.
   */
  async resolveCliSession(
    sessionID: string,
    options: { serverID?: string } = {},
  ): Promise<
    | { ok: true; ref: SessionRef; directory: string }
    | { ok: false; reason: 'not-found' | 'ambiguous' | 'unavailable'; message: string }
  > {
    const registered = this.serverIDs();
    const explicit = options.serverID;
    if (explicit !== undefined && !registered.includes(explicit)) {
      return {
        ok: false,
        reason: 'unavailable',
        message: `Server "${explicit}" is not registered. Use /servers to see available hosts.`,
      };
    }
    const cachedOn = (serverID: string): boolean =>
      this.state.sessions[this.keyFor(serverID, sessionID)] !== undefined;
    const finish = async (
      serverID: string,
    ): Promise<
      | { ok: true; ref: SessionRef; directory: string }
      | { ok: false; reason: 'not-found' | 'ambiguous' | 'unavailable'; message: string }
    > => {
      try {
        const summary = await this.ensureSession(sessionID, serverID, { onlyServer: true });
        if (summary === undefined) {
          return { ok: false, reason: 'not-found', message: `session ${sessionID} not found.` };
        }
        return {
          ok: true,
          ref: { serverID: summary.serverID ?? serverID, sessionID },
          directory: summary.directory,
        };
      } catch (error) {
        return {
          ok: false,
          reason: 'unavailable',
          message: `could not resolve session ${sessionID}: ${errorText(error)}`,
        };
      }
    };
    if (explicit !== undefined) return finish(explicit);
    const matches = registered.filter(cachedOn);
    if (matches.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        message: `Session ${sessionID} exists on multiple servers (${matches.join(', ')}). Use --remote <server> or --server to select one.`,
      };
    }
    if (matches.length === 1) return finish(matches[0]!);
    // Not cached anywhere: probe only the launch host (the old ensureSession behaviour).
    return finish(this.activeServerID());
  }

  async sendToSession(target: SessionTarget, text: string): Promise<boolean> {
    const route = this.state.route;
    const composer = this.state.composer;
    const originServerID = this.activeServerID();
    const ref = sessionRefOf(target, originServerID);
    const sentAttachments = [...this.state.attachments];
    const session =
      typeof target === 'string'
        ? await this.ensureSession(ref.sessionID, originServerID)
        : await this.ensureSession(ref.sessionID, ref.serverID, { onlyServer: true });
    const serverID = session?.serverID ?? ref.serverID;
    const activeKey = this.keyFor(serverID, ref.sessionID);
    const directory = session?.directory ?? this.deps.cwd;
    if (this.state.route === route && this.state.composer === composer) {
      this.writeComposer(composerFrom(text));
    }
    const running = this.state.running[activeKey] === true;
    return this.admit(
      { serverID, sessionID: ref.sessionID },
      text,
      directory,
      async () => {
        const { files, agents } = await this.promptFiles(
          text,
          directory,
          sentAttachments,
          serverID,
        );
        if (
          this.modelDispatchBlocked(serverID, ref.sessionID) ||
          this.agentDispatchBlocked(serverID, ref.sessionID)
        )
          return false;
        await this.backendFor(serverID).prompt(ref.sessionID, {
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
        // `/agent` opens the searchable picker; Shift+Tab remains the quick cycle. Keep
        // `/agent <id>` as exact selection for scripts and muscle memory (#123).
        if (args === '') await this.openAgentPicker();
        else await this.setAgent(args);
        return;
      case 'model':
        if (args === '') await this.openModelPicker();
        else if (/^default(\s|$)/.test(args)) await this.modelDefaultCommand(args.slice(7).trim());
        else await this.setModelFromRef(args);
        return;
      case 'effort':
        // `/effort` with no argument opens the picker; `/effort <name>` stays for scripts.
        if (args === '') await this.openEffortPicker();
        else await this.setEffort(args);
        return;
      case 'diff':
        await this.openDiff(args.trim() === 'turn' ? 'turn' : 'session');
        return;
      case 'transcript':
        this.toggleDetails();
        return;
      case 'usage':
        this.openUsage();
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
      case 'rewind':
        this.enterRewindSelection();
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
    let outcome;
    try {
      outcome = await admin.unpair(target.serverID);
    } catch (error) {
      this.showNotice(errorText(error), 'error');
      // The profile was not removed: leave the host and its UI state intact.
      return;
    }
    // Once the profile is removed, forget all cached frontend records bound to this server
    // so no route, in-flight request, stream, or overview selection remains attached to a
    // removed host, even when secret cleanup is only queued (#195).
    this.forgetServer(target.serverID);
    if (outcome?.credentialCleanup === 'pending') {
      this.showNotice(
        `Unpaired ${target.label}, but its stored credential could not be deleted (${outcome.error ?? 'unknown error'}); deletion will be retried on next launch.`,
        'error',
      );
      return;
    }
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
    const route = this.state.route;
    if (route.kind !== 'overview' && route.serverID === serverID) this.openOverview();
    this.inbox.forgetServer(serverID);
    for (const key of this.generations.jobKeys()) {
      if (parseSessionKey(key).serverID === serverID) this.invalidateJobRefresh(key);
    }
    for (const key of this.jobStartProbes.keys()) {
      if (parseSessionKey(key).serverID === serverID) this.clearJobStartProbe(key);
    }
    // Retire every session lifetime for the host and drop selection caches keyed to it, so
    // an unpair/re-pair cannot resurrect a late summary, transcript or switch (#252, #253).
    for (const key of this.generations.sessionKeys()) {
      if (parseSessionKey(key).serverID === serverID) this.invalidateSession(key);
    }
    this.ancestry.forgetServer(serverID);
    for (const key of this.generations.usageKeys()) {
      if (parseSessionKey(key).serverID === serverID) this.generations.forgetUsage(key);
    }
    for (const cache of [
      this.confirmedAgents,
      this.agentSwitches,
      this.failedAgentSwitches,
      this.modelSwitches,
      this.failedModelSwitches,
      this.modelSwitchRevisions,
    ]) {
      for (const key of cache.keys()) {
        if (parseSessionKey(key).serverID !== serverID) continue;
        this.invalidateSession(key);
        cache.delete(key);
      }
    }
    this.setStateTouchingOverview(
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
          state.workers,
          state.workerStatus,
          state.shellJobs,
          state.shellStatus,
          state.backgrounded,
        ]) {
          for (const key of Object.keys(map)) {
            if (parseSessionKey(key).serverID === serverID) delete map[key];
          }
        }
        for (const key of this.goalRevisions.keys()) {
          if (parseSessionKey(key).serverID === serverID) this.goalRevisions.forget(key);
        }
        // Qualified expansion entries are `<server-qualified session key> <node key>`; match
        // them by the session-key prefix of this host only.
        for (const map of [
          state.expandedGroups,
          state.expandedDiffs,
          state.expandedTools,
          state.childPages,
        ]) {
          for (const key of Object.keys(map)) {
            if (this.ownsKey(key, serverID)) delete map[key];
          }
        }
      }),
    );
    this.transcriptOrder = this.transcriptOrder.filter(
      (key) => parseSessionKey(key).serverID !== serverID,
    );
    if (this.state.overview.selectedRow?.includes(sessionKey({ serverID, sessionID: '' }))) {
      this.setState('overview', 'selectedRow', undefined);
    }
  }

  // ---------------------------------------------------------------- agents & models

  async cycleAgent(direction: 1 | -1): Promise<void> {
    if (!(await this.ensureCatalog(this.currentDirectory()))) return;
    const session = this.currentSession();
    const current =
      session === undefined ? this.state.overview.agent : this.effectiveAgentID(session);
    // `state.agents` is already the de-duplicated, deterministically ordered selectable set
    // from `loadCatalog`. The server does not expose project/global/built-in provenance, so
    // quick cycle safely uses that full set rather than a guessed project-only subset (#123).
    const next = nextAgent(this.state.agents, current, direction);
    if (next === undefined) {
      this.showNotice('No selectable agents on this server.', 'warn');
      return;
    }
    await this.setAgent(next.id);
  }

  private agentDispatchBlocked(serverID: string, sessionID: string): boolean {
    const key = this.keyFor(serverID, sessionID);
    if (this.agentSwitches.has(key)) {
      this.showNotice(
        'Agent selection pending. Send again once the server confirms it.',
        'dim',
        false,
      );
      return true;
    }
    if (this.failedAgentSwitches.has(key)) {
      this.showNotice(
        'Agent selection is unconfirmed. Select an agent again before sending.',
        'error',
        false,
      );
      return true;
    }
    return false;
  }

  private async setAgent(agentID: string): Promise<void> {
    if (!this.state.agents.some((agent) => agent.id === agentID)) {
      this.showNotice(`Agent "${agentID}" is not selectable.`, 'warn');
      return;
    }
    const current = this.currentSession();
    if (current === undefined) {
      this.setState('overview', 'agent', agentID);
      return;
    }
    // Snapshot the whole summary: a store proxy can reflect the optimistic write that follows,
    // which would make the rejection path "restore" the unconfirmed agent instead (#132).
    const session: SessionSummary = { ...current };
    // Serialize per server-qualified session with a monotonic chain: a late response from an
    // older selection can never overwrite a newer one. Admission is blocked until the server
    // confirms the agent via a fresh session read (#132). The optimistic footer value is never
    // described as confirmed; a rejection restores the whole pre-switch summary.
    const key = this.keyFor(session.serverID, session.id);
    const epoch = this.sessionEpoch(key);
    const previous = this.agentSwitches.get(key);
    this.setStateTouchingOverview('sessions', key, { ...session, agent: agentID });
    const operation = (async (): Promise<boolean> => {
      if (previous !== undefined) await previous;
      try {
        const backend = this.backendFor(session.serverID);
        if (!this.isSessionCurrent(key, epoch)) return false;
        await backend.switchAgent(session.id, agentID);
        const confirmed = await backend.getSession(session.id);
        if (
          !this.isSessionCurrent(key, epoch) ||
          !this.isRegisteredBackend(session.serverID, backend)
        ) {
          return false;
        }
        // The summary's `agent` is optional in v2. `session.switchAgent` is a 204 NoContent
        // command, so a resolved RPC is the acknowledgement; only a *different* reported
        // agent is a failure (#256).
        if (confirmed.agent !== undefined && confirmed.agent !== agentID) {
          throw new Error('Server did not confirm the requested agent');
        }
        this.setStateTouchingOverview('sessions', key, {
          ...confirmed,
          serverID: session.serverID,
          agent: confirmed.agent ?? agentID,
        });
        this.acceptServerAgent(key, confirmed.agent ?? agentID);
        this.failedAgentSwitches.delete(key);
        if (this.state.running[key] === true)
          this.showNotice(`Agent: ${agentID} (next turn)`, 'dim');
        return true;
      } catch (error) {
        // A failure from a retired lifetime is not evidence about the current one.
        if (!this.isSessionCurrent(key, epoch)) return false;
        // `agent` is optional; restoring the whole captured summary avoids an absent-property
        // write under exactOptionalPropertyTypes. refreshSummary below reconciles with the server.
        this.setStateTouchingOverview('sessions', key, session);
        this.failedAgentSwitches.add(key);
        this.showNotice(
          `Agent selection failed: ${errorText(error)}. Select an agent again before sending.`,
          'error',
          false,
        );
        return false;
      }
    })();
    this.agentSwitches.set(key, operation);
    const confirmed = await operation;
    if (this.agentSwitches.get(key) === operation) this.agentSwitches.delete(key);
    if (confirmed) await this.refreshSummary(session.id, session.serverID);
  }

  // ---------------------------------------------------------------- agent picker (#123)

  async openAgentPicker(admit?: () => boolean): Promise<void> {
    // Keyboard and /agent callers have no footer token; create one so the same post-await
    // admission check protects every entry point (#146).
    const admission = admit ?? this.beginPickerOpen('agent');
    if (!(await this.ensureCatalog(this.currentDirectory()))) return;
    if (!admission()) return;
    const current = this.currentAgentID();
    const index =
      current === undefined
        ? 0
        : Math.max(
            0,
            this.agentChoices('').findIndex((agent) => agent.id === current),
          );
    this.setOverlay({ kind: 'agent-picker', query: '', index });
  }

  /** Every selectable agent, filtered by query; the picker never narrows to a guessed scope. */
  agentChoices(query: string) {
    return filterAgents(this.state.agents, query);
  }

  /** The agent shown as current in the picker, for both sessions and new-session defaults. */
  currentAgentID(): string | undefined {
    const session = this.currentSession();
    if (session !== undefined) return this.effectiveAgentID(session);
    return this.state.overview.agent;
  }

  /** Newest agent-bearing message in the loaded transcript, with its ordering token. */
  private latestTranscriptAgent(
    key: string,
  ): { agent: string; mark: TranscriptAgentMark } | undefined {
    let latest: { agent: string; mark: TranscriptAgentMark } | undefined;
    for (const message of this.state.transcripts[key]?.messages ?? []) {
      let agent: string | undefined;
      if (message.kind === 'agent-switched') agent = message.agent;
      else if (message.kind === 'assistant' && message.agent !== '') agent = message.agent;
      if (agent === undefined) continue;
      if (latest === undefined || message.createdAt >= latest.mark.createdAt) {
        latest = { agent, mark: { id: message.id, createdAt: message.createdAt } };
      }
    }
    return latest;
  }

  /**
   * True when transcript evidence is newer than what an accepted value already accounted
   * for. Without a loaded-transcript watermark, the local observation time is the token;
   * a newly fetched message must be genuinely later to outrank a fresh local confirmation.
   */
  private transcriptSupersedes(
    evidence: { mark: TranscriptAgentMark },
    accepted: AgentEvidence,
  ): boolean {
    if (accepted.transcript === undefined) return evidence.mark.createdAt > accepted.observedAt;
    // Equal timestamps are ambiguous; a different message ID still proves new evidence and
    // avoids letting a same-millisecond external switch look like the acknowledged one.
    return (
      evidence.mark.createdAt > accepted.transcript.createdAt ||
      (evidence.mark.createdAt === accepted.transcript.createdAt &&
        evidence.mark.id !== accepted.transcript.id)
    );
  }

  /** Records an explicit server-reported agent as the current evidence for this session. */
  private acceptServerAgent(key: string, agent: string): void {
    const latest = this.latestTranscriptAgent(key);
    this.confirmedAgents.set(key, {
      agent,
      observedAt: this.deps.now(),
      ...(latest === undefined ? {} : { transcript: latest.mark }),
    });
  }

  /** Promotes a genuinely newer transcript switch into the session's accepted evidence. */
  private adoptTranscriptAgent(key: string): void {
    const latest = this.latestTranscriptAgent(key);
    if (latest === undefined) return;
    const accepted = this.confirmedAgents.get(key);
    if (accepted !== undefined && !this.transcriptSupersedes(latest, accepted)) return;
    this.confirmedAgents.set(key, {
      agent: latest.agent,
      transcript: latest.mark,
      observedAt: this.deps.now(),
    });
  }

  /**
   * The effective agent for one session. The summary is authoritative when it reports one;
   * OpenCode v2 may omit it, so the newest `agent-switched` or assistant message competes
   * with the last acknowledged switch by transcript order, not by which cache was written
   * first (#225, #253). Never borrow the overview draft or another project's selection.
   */
  effectiveAgentID(session: SessionSummary): string | undefined {
    if (session.agent !== undefined) return session.agent;
    const key = this.keyFor(session.serverID, session.id);
    const accepted = this.confirmedAgents.get(key);
    const latest = this.latestTranscriptAgent(key);
    if (
      latest !== undefined &&
      (accepted === undefined || this.transcriptSupersedes(latest, accepted))
    )
      return latest.agent;
    return accepted?.agent;
  }

  setAgentPickerQuery(query: string): void {
    this.setState('overlay', { kind: 'agent-picker', query, index: 0 });
  }

  selectAgentPickerIndex(index: number): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'agent-picker') return;
    this.setState('overlay', { ...overlay, index });
  }

  moveAgentPicker(direction: -1 | 1): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'agent-picker') return;
    const count = this.agentChoices(overlay.query).length;
    if (count === 0) return;
    this.setState('overlay', { ...overlay, index: (overlay.index + direction + count) % count });
  }

  async acceptAgentPicker(): Promise<void> {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'agent-picker') return;
    const choices = this.agentChoices(overlay.query);
    const choice = choices[overlay.index];
    this.setOverlay({ kind: 'none' });
    if (choice !== undefined) await this.setAgent(choice.id);
  }

  // ---------------------------------------------------------------- copy picker (#105)

  /** Messages of the attached conversation; empty outside a conversation route. */
  private loadedMessages(): readonly TranscriptMessage[] {
    if (this.state.route.kind !== 'conversation') return [];
    const { serverID, sessionID } = this.state.route;
    return this.state.transcripts[this.keyFor(serverID, sessionID)]?.messages ?? [];
  }

  /** Exact, UI-independent payloads from the viewed session's loaded transcript. */
  copyChoices(query: string): Copyable[] {
    const items = copyableFromMessages(this.loadedMessages());
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token !== '');
    return tokens.length === 0
      ? items
      : items.filter((item) => tokens.every((token) => item.label.toLowerCase().includes(token)));
  }

  openCopyPicker(): void {
    this.setOverlay({ kind: 'copy-picker', query: '', index: 0 });
  }

  setCopyPickerQuery(query: string): void {
    this.setState('overlay', { kind: 'copy-picker', query, index: 0 });
  }

  selectCopyPickerIndex(index: number): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'copy-picker') return;
    this.setState('overlay', { ...overlay, index });
  }

  moveCopyPicker(direction: -1 | 1): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'copy-picker') return;
    const count = this.copyChoices(overlay.query).length;
    if (count === 0) return;
    this.setState('overlay', { ...overlay, index: (overlay.index + direction + count) % count });
  }

  async acceptCopyPicker(): Promise<void> {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'copy-picker') return;
    const item = this.copyChoices(overlay.query)[overlay.index];
    this.setOverlay({ kind: 'none' });
    if (item === undefined) return;
    try {
      const result = await this.copyToDestination(item.text);
      const suffix =
        item.truncation === 'none'
          ? ''
          : ` (${item.truncation === 'server' ? 'server-truncated' : 'UI cap only'})`;
      this.showNotice(
        result.method === 'clipboard'
          ? `Clipboard sequence emitted for ${item.kind}${suffix} (no terminal acknowledgement).`
          : `Clipboard unavailable; saved ${result.path ?? 'a file'}${suffix}.`,
        'dim',
      );
    } catch (error) {
      this.showNotice(`Copy failed: ${errorText(error)}`, 'error');
    }
  }

  private async copyToDestination(text: string): Promise<CopyResult> {
    if (this.deps.copyText !== undefined) return this.deps.copyText(text);
    // Fall back to a client-local directory, not the (possibly remote) project cwd (#153).
    const dir = this.deps.copyFallbackDir ?? this.deps.cwd;
    const path = join(dir, `marg-copy-${process.pid}-${this.deps.now()}.txt`);
    const write = this.deps.writeFile ?? (async (file, body) => void (await Bun.write(file, body)));
    await write(path, text);
    return { method: 'file', path };
  }

  async openModelPicker(admit?: () => boolean): Promise<void> {
    const admission = admit ?? this.beginPickerOpen('model');
    if (!(await this.ensureCurrentModelCatalog())) return;
    if (!admission()) return;
    const current = this.effectiveModel();
    const index =
      current === undefined
        ? 0
        : Math.max(
            0,
            this.modelChoices('').findIndex(
              (choice) =>
                choice.providerID === current.providerID && choice.modelID === current.modelID,
            ),
          );
    this.setOverlay({ kind: 'model-picker', query: '', index });
  }

  /** One row per enabled model, provider-grouped and release/tier ordered (#165, #166). */
  modelChoices(query: string): ModelSelection[] {
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token !== '');
    const choices: ModelSelection[] = [];
    for (const model of sortModelCatalogForPicker(this.state.models)) {
      if (!model.enabled) continue;
      const haystack = `${model.providerID}/${model.modelID} ${model.name}`.toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) continue;
      // Effort is chosen in its own picker; selecting a model never silently pins a variant.
      choices.push({ providerID: model.providerID, modelID: model.modelID });
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

  /** Mouse row selection; acceptance still goes through the same server confirmation. */
  selectModelPickerIndex(index: number): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'model-picker') return;
    const count = this.modelChoices(overlay.query).length;
    if (count === 0) return;
    this.setState('overlay', { ...overlay, index: Math.max(0, Math.min(count - 1, index)) });
  }

  async acceptModelPicker(): Promise<void> {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'model-picker') return;
    const choice = this.modelChoices(overlay.query)[overlay.index];
    this.setOverlay({ kind: 'none' });
    if (choice !== undefined) await this.setModel(choice);
  }

  /** The model whose variants the effort picker edits: conversation first, overview default next. */
  private effectiveModel(): ModelSelection | undefined {
    const session = this.currentSession();
    if (session?.model !== undefined) return session.model;
    return this.modelFor(this.activeServerID(), this.currentDirectory()).model;
  }

  /** Currently effective variant; `undefined` means the server-defined default. */
  currentEffort(): string | undefined {
    return this.effectiveModel()?.variant;
  }

  /**
   * Effort rows come from the effective model's verified scoped catalog only. The first row
   * clears an explicit override and uses the server default; invalid catalogs expose no choices.
   */
  effortChoices(query: string): ReadonlyArray<{ label: string; variant: string | undefined }> {
    const current = this.effectiveModel();
    if (current === undefined) return [];
    const scoped = this.scopedModelsFor(this.activeServerID(), this.currentDirectory());
    const catalog = (scoped.length > 0 ? scoped : this.state.models).find(
      (model) =>
        model.enabled &&
        model.providerID === current.providerID &&
        model.modelID === current.modelID,
    );
    if (catalog === undefined) return [];
    const options: Array<{ label: string; variant: string | undefined }> = [
      { label: 'default (no override)', variant: undefined },
      ...catalog.variants.map((variant) => ({ label: variant, variant })),
    ];
    const needle = query.trim().toLowerCase();
    return needle === ''
      ? options
      : options.filter((option) => option.label.toLowerCase().includes(needle));
  }

  async openEffortPicker(admit?: () => boolean): Promise<void> {
    const admission = admit ?? this.beginPickerOpen('effort');
    if (!(await this.ensureCurrentModelCatalog())) return;
    if (!admission()) return;
    const current = effectiveVariant(this.currentEffort());
    const index = Math.max(
      0,
      this.effortChoices('').findIndex((choice) => effectiveVariant(choice.variant) === current),
    );
    this.setOverlay({ kind: 'effort-picker', query: '', index });
  }

  setEffortPickerQuery(query: string): void {
    this.setState('overlay', { kind: 'effort-picker', query, index: 0 });
  }

  moveEffortPicker(direction: -1 | 1): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'effort-picker') return;
    const count = this.effortChoices(overlay.query).length;
    if (count === 0) return;
    this.setState('overlay', { ...overlay, index: (overlay.index + direction + count) % count });
  }

  /** Mouse row selection; acceptance still uses the same verified model switch. */
  selectEffortPickerIndex(index: number): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'effort-picker') return;
    const count = this.effortChoices(overlay.query).length;
    if (count === 0) return;
    this.setState('overlay', { ...overlay, index: Math.max(0, Math.min(count - 1, index)) });
  }

  async acceptEffortPicker(): Promise<void> {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'effort-picker') return;
    const choice = this.effortChoices(overlay.query)[overlay.index];
    this.setOverlay({ kind: 'none' });
    if (choice === undefined) return;
    await this.setEffortChoice(choice.variant);
  }

  private async setEffortChoice(variant: string | undefined): Promise<void> {
    const current = this.effectiveModel();
    if (current === undefined) {
      this.showNotice('No model selected.', 'warn');
      return;
    }
    // Only authoritative confirmation changes the footer: setModel verifies with the server.
    await this.setModel(
      variant === undefined
        ? { providerID: current.providerID, modelID: current.modelID }
        : { providerID: current.providerID, modelID: current.modelID, variant },
    );
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
    const current = this.effectiveModel();
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
    if (variant === defaultVariant) {
      await this.setModel({ providerID: current.providerID, modelID: current.modelID });
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
    // A variant is only valid for the model that advertises it. Never carry an unsupported
    // effort onto a different model; fall back to that model's server-defined default (#165).
    const catalog = this.state.models.find(
      (entry) =>
        entry.enabled && entry.providerID === model.providerID && entry.modelID === model.modelID,
    );
    const unsupported =
      catalog !== undefined &&
      effectiveVariant(model.variant) !== undefined &&
      !catalog.variants.includes(model.variant ?? '');
    const reconciled = unsupported
      ? { providerID: model.providerID, modelID: model.modelID }
      : model.variant !== undefined && effectiveVariant(model.variant) === undefined
        ? normalizeModel(model)
        : model;
    if (unsupported) {
      this.showNotice(
        `Variant "${model.variant}" is not available for ${model.modelID}; using the server default.`,
        'dim',
      );
    }
    const session = this.currentSession();
    if (session === undefined) {
      // An unsent draft selection is a preference, not confirmed usage: it is remembered only
      // once the server confirms it on a created session (#191).
      // Solid merges objects on assignment; clear first so a dropped variant really disappears.
      this.setState('overview', 'model', undefined);
      this.setState('overview', 'model', reconciled);
      return;
    }
    await this.switchSessionModel(session, reconciled);
  }

  // ---------------------------------------------------------------- effective model

  /** Stable per-host, per-project scope for remembered and pinned models (#189). */
  private modelScope(serverID: string, directory: string): string {
    return modelScope(serverID, directory, this.platformFor(serverID));
  }

  /**
   * The one resolver behind the welcome panel, footer, pickers and createSession: it only
   * trusts a catalog verified for this exact (server, directory) scope.
   */
  private resolveModelFor(
    serverID: string,
    directory: string,
    selection?: ModelSelection,
  ): EffectiveModel {
    const directoryID = directoryKey(directory, this.platformFor(serverID));
    const scope = `${serverID}|${directoryID}`;
    const ready =
      this.state.catalogServerID === serverID &&
      this.state.catalogDirectory === directoryID &&
      !this.state.catalogLoading &&
      this.state.catalogError === undefined;
    const project = this.state.overview.project;
    const draft =
      selection ??
      (project.serverID === serverID && project.directory === directory
        ? this.state.overview.model
        : undefined);
    return resolveEffectiveModel({
      catalogReady: ready,
      catalog: this.state.models,
      selection: draft,
      pinnedProject: this.state.pinnedModels[`project:${scope}`],
      pinnedUser: this.state.pinnedModels['user'],
      lastUsed: this.state.lastModels[scope],
      serverDefault: this.state.defaultModel,
    });
  }

  /**
   * What the UI shows as the model for a conversation in this scope. Existing sessions show
   * only the server-confirmed model; a new session shows the model that would be sent.
   */
  modelFor(
    serverID: string,
    directory: string,
    existing = false,
  ): { model?: ModelSelection; status?: 'loading' | 'unavailable' } {
    const resolution = this.resolveModelFor(serverID, directory);
    if (resolution.kind === 'loading') {
      return { status: this.state.catalogError === undefined ? 'loading' : 'unavailable' };
    }
    if (existing) {
      return this.state.defaultModel === undefined ? {} : { model: this.state.defaultModel };
    }
    if (resolution.kind === 'blocked') return { status: 'unavailable' };
    return resolution.kind === 'model' ? { model: resolution.model } : {};
  }

  /** Records a server-confirmed model as last used for its scope and in the recents (#191). */
  private recordConfirmedModel(serverID: string, directory: string, model: ModelSelection): void {
    this.rememberModel(model);
    const lastModels = {
      ...this.state.lastModels,
      [this.modelScope(serverID, directory)]: model,
    };
    this.setState('lastModels', reconcile(lastModels));
    this.persistence.patch({ lastModels });
  }

  private async modelDefaultCommand(args: string): Promise<void> {
    const [action = 'show', scopeWord, ...extra] = args.split(/\s+/).filter((word) => word !== '');
    const projectScope = scopeWord === 'project';
    if (
      !['set', 'clear', 'show'].includes(action) ||
      extra.length > 0 ||
      (scopeWord !== undefined && scopeWord !== 'user' && !projectScope)
    ) {
      this.showNotice(
        'Usage: /model default [show] | set [user|project] | clear [user|project]',
        'warn',
      );
      return;
    }
    if (!(await this.ensureCurrentModelCatalog())) return;
    const serverID = this.activeServerID();
    const directory = this.currentDirectory();
    const pinProjectKey = `project:${this.modelScope(serverID, directory)}`;
    const key = projectScope ? pinProjectKey : 'user';
    const label = projectScope ? 'this project' : 'all projects';
    if (action === 'show') {
      const resolution = this.resolveModelFor(serverID, directory);
      const pins = this.state.pinnedModels;
      const userPin = pins['user'];
      const projectPin = pins[pinProjectKey];
      const pinText = [
        userPin === undefined ? undefined : `user pin ${formatModelRef(userPin)}`,
        projectPin === undefined ? undefined : `project pin ${formatModelRef(projectPin)}`,
      ].filter((part) => part !== undefined);
      const current =
        resolution.kind === 'model'
          ? `${formatModelRef(resolution.model)} (${resolution.source})`
          : resolution.kind === 'blocked'
            ? `${formatModelRef(resolution.model)} is unavailable (${resolution.source})`
            : 'no model yet';
      this.showNotice(
        `New sessions use: ${current} · ${pinText.length === 0 ? 'nothing pinned' : pinText.join(' · ')}`,
        'dim',
      );
      return;
    }
    if (action === 'clear') {
      if (this.state.pinnedModels[key] === undefined) {
        this.showNotice(`No model is pinned for ${label}.`, 'dim');
        return;
      }
      this.mutatePin(key, null);
      this.showNotice(
        `Cleared the pinned model for ${label}; automatic selection restored.`,
        'dim',
      );
      return;
    }
    const session = this.currentSession();
    if (session !== undefined) {
      const switchKey = this.keyFor(session.serverID, session.id);
      if (this.modelSwitches.has(switchKey) || this.failedModelSwitches.has(switchKey)) {
        this.showNotice('A model selection is unconfirmed. Wait for it before pinning.', 'warn');
        return;
      }
    }
    const resolution = this.resolveModelFor(serverID, directory);
    const model = session?.model ?? (resolution.kind === 'model' ? resolution.model : undefined);
    if (model === undefined) {
      this.showNotice('No confirmed model to pin yet. Select one with /model first.', 'warn');
      return;
    }
    this.mutatePin(key, model);
    this.showNotice(`Pinned ${formatModelRef(model)} as the default for ${label}.`, 'dim');
  }

  /**
   * Records one scope's pin intent and persists the full view derived from it. The explicit
   * operation (including a clear) is what lets another process merge unrelated scopes (#273).
   */
  private mutatePin(key: string, model: ModelSelection | null): void {
    const { operations, pins } = applyPin(
      this.pinOperations,
      this.state.pinnedModels,
      key,
      model,
      this.isoNow(),
    );
    this.pinOperations = operations;
    this.setState('pinnedModels', reconcile(pins));
    this.persistence.patch({ pinnedModels: pins, pinnedModelOps: operations });
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
    const epoch = this.sessionEpoch(key);
    const previous = this.modelSwitches.get(key);
    this.modelSwitchRevisions.set(key, (this.modelSwitchRevisions.get(key) ?? 0) + 1);
    this.showNotice(`Confirming ${formatModelRef(model)} with the server…`, 'dim', false);
    const operation = (async (): Promise<boolean> => {
      if (previous !== undefined) await previous;
      try {
        const backend = this.backendFor(session.serverID);
        if (!this.isSessionCurrent(key, epoch)) return false;
        await backend.switchModel(session.id, model);
        const confirmed = await backend.getSession(session.id);
        if (
          !this.isSessionCurrent(key, epoch) ||
          !this.isRegisteredBackend(session.serverID, backend)
        ) {
          return false;
        }
        if (confirmed.model === undefined || !sameModel(confirmed.model, model)) {
          throw new Error('Server did not confirm the requested model');
        }
        this.setStateTouchingOverview('sessions', key, {
          ...confirmed,
          serverID: session.serverID,
        });
        this.failedModelSwitches.delete(key);
        return true;
      } catch (error) {
        // A failure from a retired lifetime is not evidence about the current one.
        if (!this.isSessionCurrent(key, epoch)) return false;
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
      if (confirmed) {
        this.recordConfirmedModel(session.serverID, session.directory, model);
        this.showNotice(`Model confirmed: ${formatModelRef(model)}`, 'dim');
      }
    }
    return confirmed;
  }

  /** F2: next recently used model still present in the catalog. */
  async nextRecentModel(): Promise<void> {
    if (!(await this.ensureCurrentModelCatalog())) return;
    const current = this.effectiveModel();
    const available = this.state.recentModels.filter((recent) =>
      isModelAvailable(this.state.models, recent),
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
    this.persistence.patch({ recentModels: recent });
  }

  // ---------------------------------------------------------------- execution control

  /** Ctrl+C: interrupt via server and report the authoritative result. */
  async interrupt(): Promise<void> {
    const session = this.currentSession();
    if (session === undefined) return;
    try {
      // Bound to the session's owning host, never the launch backend (#178).
      const interrupted = await this.backendFor(session.serverID).interrupt(session.id);
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
    // Capture request-time identity BEFORE the async RPC: the transcript and turn can change
    // while it is pending, and ownership must never be derived from whatever is running after
    // the await (#147).
    const key = this.keyFor(session.serverID, session.id);
    const routeKey = this.routeKey(this.state.route);
    const turnGeneration = this.generations.eventSequence(key);
    const captured = this.runningToolIDs(session.id, session.serverID);
    try {
      await this.backendFor(session.serverID).backgroundTools(session.id);
      // Re-validate the captured session, host, route and turn. An acknowledgement from an
      // old turn can neither be lost when its tool finishes nor retargeted to a new turn/tool.
      if (
        this.disposed ||
        this.state.sessions[key]?.serverID !== session.serverID ||
        this.routeKey(this.state.route) !== routeKey ||
        this.generations.eventSequence(key) !== turnGeneration
      )
        return;
      const toolIDs = new Set(
        (this.state.transcripts[key]?.messages ?? []).flatMap((message) =>
          message.kind === 'assistant'
            ? message.parts.flatMap((part) => (part.kind === 'tool' ? [part.tool.id] : []))
            : [],
        ),
      );
      const acknowledged = captured.filter((toolID) => toolIDs.has(toolID));
      if (acknowledged.length === 0) return;
      // The confirmation belongs to the captured tool call, rendered inside the transcript.
      // A global notice would occupy a composer/footer row and shift the prompt bar (#129).
      // One event per tool ID: a second Ctrl+B updates the same event instead of duplicating it.
      const previous = this.state.backgrounded[key] ?? [];
      const events: BackgroundEvent[] = acknowledged.map((toolID) => ({
        toolID,
        text: 'Moved to background',
      }));
      this.setState('backgrounded', key, [
        ...previous.filter((event) => !acknowledged.includes(event.toolID)),
        ...events,
      ]);
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
    const clientCwd = this.deps.clientCwd ?? this.deps.cwd;
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
          `remote server, but exports are written locally to ${clientCwd}. Use a local path.`,
        'warn',
      );
      return;
    }
    const paths = this.deps.platform === 'win32' ? win32 : posix;
    const fileName = target === '' ? `marg-${session.id}.json` : target;
    const outputPath = paths.resolve(clientCwd, fileName);
    try {
      const backend = this.backendFor(session.serverID);
      const originSession = structuredClone(unwrap(session));
      const currentGoal = this.state.goals[this.keyFor(session.serverID, session.id)];
      const goal = currentGoal === undefined ? undefined : structuredClone(unwrap(currentGoal));
      const pages: TranscriptMessage[][] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await backend.listMessages(originSession.id, exportPageSize, cursor);
        pages.unshift(page.messages);
        if (
          (page.hasEarlier === true || page.retryable === true) &&
          page.olderCursor === undefined
        ) {
          throw new Error('The server reported earlier messages without a continuation cursor.');
        }
        cursor =
          page.hasEarlier === false && page.retryable !== true ? undefined : page.olderCursor;
        if (cursor !== undefined) {
          if (cursors.has(cursor)) throw new Error('The server repeated a transcript cursor.');
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      // Repeated messages are only valid at an adjacent page boundary. Reject other
      // overlaps because their order cannot be established from this pagination result.
      const messages: TranscriptMessage[] = [];
      const seen = new Set<string>();
      for (const page of pages) {
        if (new Set(page.map((message) => message.id)).size !== page.length) {
          throw new Error('The server returned duplicate messages within a transcript page.');
        }
        let overlap = 0;
        while (overlap < page.length && seen.has(page[overlap]?.id ?? '')) overlap += 1;
        if (
          page.slice(overlap).some((message) => seen.has(message.id)) ||
          overlap > messages.length ||
          page
            .slice(0, overlap)
            .some(
              (message, index) => message.id !== messages[messages.length - overlap + index]?.id,
            )
        ) {
          throw new Error('The server returned transcript pages in an inconsistent order.');
        }
        if (overlap > 0) messages.splice(messages.length - overlap, overlap);
        messages.push(...page);
        for (const message of page) seen.add(message.id);
      }
      const log = {
        format: 'margarita.chatlog.v1',
        exportedAt: new Date(this.deps.now()).toISOString(),
        server: backend.baseUrl,
        session: originSession,
        messages,
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
    const key = this.keyFor(session.serverID, session.id);
    const pending =
      this.pendingCompactions.has(key) ||
      (this.state.inbox[key] ?? []).some((item) => item.kind === 'compaction');
    if (pending) {
      this.showNotice('Compaction already pending', 'dim');
      return;
    }
    this.pendingCompactions.add(key);
    let backend: Backend;
    try {
      backend = this.backendFor(session.serverID);
      await backend.compactSession(session.id);
    } catch (error) {
      this.pendingCompactions.delete(key);
      this.showNotice(
        `Compaction request could not be confirmed (connection problem): ${errorText(error)}`,
        'warn',
      );
      return;
    }
    const current = this.currentSession();
    this.showNotice(
      current?.serverID === session.serverID && current.id === session.id
        ? 'Compaction requested'
        : `Compaction requested for ${session.id} on ${session.serverID}`,
      'dim',
    );
    try {
      await this.refreshInbox(session.id, session.serverID, backend);
    } catch (error) {
      this.showNotice(
        `Compaction requested, but inbox refresh failed: ${errorText(error)}`,
        'warn',
      );
    } finally {
      this.pendingCompactions.delete(key);
    }
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
    this.setStateTouchingOverview(
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

  /** First deliberate interaction with the pending card; required before Enter answers it. */
  focusPermission(): void {
    if (this.pendingPermission() === undefined) return;
    this.setState('permissionFocused', true);
  }

  movePermissionChoice(direction: -1 | 1): void {
    const count = this.permissionChoices().length;
    if (count === 0) return;
    this.setState('permissionFocused', true);
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
    // Toggling turn/session is a snapshot change, not a navigation away: keep the reader on
    // the same file and patch offset when that file still exists in the new snapshot (#276).
    const previous = this.state.overlay.kind === 'diff' ? this.state.overlay : undefined;
    const anchorFile = previous?.files[previous.index]?.file;
    const anchorOpen = previous?.open === true && anchorFile !== undefined;
    const anchorOffset = previous?.offset ?? 0;
    const base: DiffOverlay = {
      kind: 'diff',
      serverID: session.serverID,
      sessionID: session.id,
      scope,
      loading: true,
      files: [],
      index: 0,
      open: false,
      offset: 0,
    };
    const request = ++this.diffRequestSeq;
    this.setOverlay(base);
    const generation = this.interactionGeneration;
    try {
      const files = await this.backendFor(session.serverID).sessionDiff(session.id, range);
      if (this.isDiffOverlay(session.serverID, session.id, scope, request, generation)) {
        const anchored =
          anchorFile === undefined ? -1 : files.findIndex((f) => f.file === anchorFile);
        const index =
          anchored >= 0 ? anchored : Math.min(previous?.index ?? 0, Math.max(0, files.length - 1));
        const open = anchorOpen && files[index] !== undefined;
        const offset = open
          ? Math.min(anchorOffset, Math.max(0, patchLinesFor(files[index]!).length - 1))
          : 0;
        this.setState('overlay', { ...base, loading: false, files, index, open, offset });
      }
    } catch (error) {
      if (this.isDiffOverlay(session.serverID, session.id, scope, request, generation)) {
        this.setState('overlay', { ...base, loading: false, error: errorText(error) });
      }
    }
  }

  private isDiffOverlay(
    serverID: string,
    sessionID: string,
    scope: DiffScope,
    request: number,
    generation: number,
  ): boolean {
    const overlay = this.state.overlay;
    const route = this.state.route;
    return (
      generation === this.interactionGeneration &&
      request === this.diffRequestSeq &&
      route.kind === 'conversation' &&
      route.serverID === serverID &&
      route.sessionID === sessionID &&
      overlay.kind === 'diff' &&
      overlay.serverID === serverID &&
      overlay.sessionID === sessionID &&
      overlay.scope === scope &&
      this.state.sessions[this.keyFor(serverID, sessionID)] !== undefined &&
      this.serverIDs().includes(serverID)
    );
  }

  /**
   * List: ↑↓/PgUp/PgDn/Home/End select, Enter opens, t toggles turn/session.
   * Patch: ↑↓/PgUp/PgDn/Home/End scroll, ←/Esc returns to the same file. Paging uses the
   * rows the dialog can actually paint, so the selected file/line never falls outside the
   * window on a short terminal (#276).
   */
  diffKey(key: { name: string; text?: string }, pageRows: number = diffPageLines): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'diff') return;
    const update = (patch: Partial<DiffOverlay>) =>
      this.setState('overlay', { ...overlay, ...patch });
    const page = Math.max(1, Math.floor(pageRows));
    if (overlay.open) {
      const file = overlay.files[overlay.index];
      const lines = file === undefined ? 0 : patchLinesFor(file).length;
      const last = Math.max(0, lines - 1);
      const clamp = (offset: number) => Math.max(0, Math.min(offset, last));
      if (key.name === 'escape' || key.name === 'left' || key.name === 'q') {
        update({ open: false, offset: 0 });
      } else if (key.name === 'up') update({ offset: clamp(overlay.offset - 1) });
      else if (key.name === 'down') update({ offset: clamp(overlay.offset + 1) });
      else if (key.name === 'pageup') update({ offset: clamp(overlay.offset - page) });
      else if (key.name === 'pagedown') update({ offset: clamp(overlay.offset + page) });
      else if (key.name === 'home') update({ offset: 0 });
      else if (key.name === 'end') update({ offset: last });
      else if (key.text === 't') {
        void this.openDiff(overlay.scope === 'turn' ? 'session' : 'turn');
      }
      return;
    }
    const count = overlay.files.length;
    const last = Math.max(0, count - 1);
    const clamp = (index: number) => Math.max(0, Math.min(index, last));
    if (key.name === 'escape' || key.name === 'q') this.closeOverlay();
    else if (key.name === 'up' && count > 0) update({ index: clamp(overlay.index - 1) });
    else if (key.name === 'down' && count > 0) update({ index: clamp(overlay.index + 1) });
    else if (key.name === 'pageup' && count > 0) update({ index: clamp(overlay.index - page) });
    else if (key.name === 'pagedown' && count > 0) update({ index: clamp(overlay.index + page) });
    else if (key.name === 'home' && count > 0) update({ index: 0 });
    else if (key.name === 'end' && count > 0) update({ index: last });
    else if ((key.name === 'return' || key.name === 'right') && count > 0) {
      update({ open: true, offset: 0 });
    } else if (key.text === 't') {
      void this.openDiff(overlay.scope === 'turn' ? 'session' : 'turn');
    }
  }

  /** Mouse row selection in the file list opens that file through the same key path. */
  openDiffFile(index: number): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'diff' || overlay.open || overlay.files.length === 0) return;
    const selected = Math.max(0, Math.min(overlay.files.length - 1, Math.floor(index)));
    this.setState('overlay', { ...overlay, index: selected, open: true, offset: 0 });
  }

  /** Oldest pending agent question for the attached session; permissions go first. */
  pendingForm(): FormRequest | undefined {
    const session = this.currentSession();
    if (session === undefined) return undefined;
    return (this.state.forms[this.keyFor(session.serverID, session.id)] ?? [])[0];
  }

  openForm(): void {
    const session = this.currentSession();
    const form = this.pendingForm();
    if (session === undefined || form === undefined) return;
    this.formToken += 1;
    this.setOverlay({
      kind: 'form',
      serverID: session.serverID,
      sessionID: session.id,
      formSessionID: form.sessionID,
      formDirectory: session.directory,
      requestToken: this.formToken,
      editor: startEditor(form),
    });
  }

  /** The form an open form overlay is editing, if it is still pending. */
  openFormRequest(): FormRequest | undefined {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'form') return undefined;
    return (this.state.forms[this.keyFor(overlay.serverID, overlay.sessionID)] ?? []).find(
      (form) => form.id === overlay.editor.formID,
    );
  }

  /** Open the current external field's URL in a client-local browser; never a form reply. */
  async openFormExternalUrl(): Promise<void> {
    const overlay = this.state.overlay;
    const form = this.openFormRequest();
    if (overlay.kind !== 'form' || form === undefined) return;
    const field = currentField(form, overlay.editor);
    if (field?.kind !== 'external') return;
    const url = parseExternalUrl(field.url);
    if (url === undefined) {
      this.showNotice('Only http(s) URLs can be opened. Press c to copy the address.', 'warn');
      return;
    }
    const open =
      this.deps.openUrl ?? ((target: URL) => openExternalUrl(target, this.deps.platform));
    const result = await open(url);
    if (result.ok) {
      this.showNotice(
        'Opened in your browser. Opening is not an answer; the question stays pending.',
        'dim',
      );
    } else {
      this.showNotice(
        `Could not open a browser: ${result.error}. Press c to copy the URL.`,
        'warn',
      );
    }
  }

  /** Copy the current external URL; the pending question is left untouched. */
  async copyFormExternalUrl(): Promise<void> {
    const overlay = this.state.overlay;
    const form = this.openFormRequest();
    if (overlay.kind !== 'form' || form === undefined) return;
    const field = currentField(form, overlay.editor);
    if (field?.kind !== 'external') return;
    try {
      const result = await this.copyToDestination(field.url);
      this.showNotice(
        result.method === 'clipboard'
          ? 'External URL copied. The question stays pending until the server completes it.'
          : `Clipboard unavailable; saved the URL to ${result.path ?? 'a local file'}.`,
        'dim',
      );
    } catch (error) {
      this.showNotice(`Copy failed: ${errorText(error)}`, 'error');
    }
  }

  formKey(key: FormKey): void {
    const overlay = this.state.overlay;
    const form = this.openFormRequest();
    if (overlay.kind !== 'form' || form === undefined) {
      this.closeOverlay();
      return;
    }
    // Solid store objects are live proxies. Snapshot the request owner before replacing
    // the overlay, since navigation may otherwise mutate the captured reference.
    const origin = { ...overlay, editor: { ...overlay.editor } };
    const activeField = currentField(form, overlay.editor);
    if (activeField?.kind === 'external' && !key.ctrl) {
      // Deliberate, explicit actions: opening/copying never submits or acknowledges (#233).
      if (key.name === 'o') {
        void this.openFormExternalUrl();
        return;
      }
      if (key.name === 'c') {
        void this.copyFormExternalUrl();
        return;
      }
    }
    const { editor, outcome } = editorKey(form, overlay.editor, key);
    if (outcome === 'close') {
      this.closeOverlay();
      return;
    }
    this.setState('overlay', { ...overlay, editor });
    if (outcome === 'submit') {
      // An external-only elicitation is completed by the provider/browser flow. Enter,
      // Tab or a click cannot prove that flow finished, so never send an empty answer.
      // Eligibility uses the editor's *effective* fields: a hidden or conditionally
      // invisible text field must not make an all-external step look answerable (#257, #266).
      const visible = visibleFields(form, editor.answers);
      const hasAnswerableField = visible.some((field) => field.kind !== 'external');
      if (!hasAnswerableField && visible.some((field) => field.kind === 'external')) {
        this.showNotice(
          'This question is completed in the browser. Opening or copying the URL is not an answer; it stays pending until the server finishes it.',
          'warn',
          false,
        );
        return;
      }
      const answer = buildAnswer(form, editor.answers);
      void this.finishForm(origin, (backend) =>
        backend.replyForm(origin.formSessionID, origin.editor.formID, answer, origin.formDirectory),
      );
    } else if (outcome === 'decline') {
      void this.finishForm(origin, (backend) =>
        backend.cancelForm(origin.formSessionID, origin.editor.formID, origin.formDirectory),
      );
    }
  }

  /**
   * Click one visible choice row (#245). Choice fields highlight the row for a following
   * Enter; multiselect rows toggle immediately, matching Space. The window offset is the
   * caller's absolute row within the field's complete choice list.
   */
  clickFormChoice(index: number): void {
    const overlay = this.state.overlay;
    const form = this.openFormRequest();
    if (overlay.kind !== 'form' || form === undefined) return;
    const field = currentField(form, overlay.editor);
    if (field === undefined) return;
    if (field.kind === 'choice') {
      if (index < 0 || index >= field.options.length) return;
      this.setState('overlay', {
        ...overlay,
        editor: {
          ...overlay.editor,
          cursor: index,
          choiceCustom: false,
          choiceFocus: 'list',
          problem: undefined,
        },
      });
      return;
    }
    if (field.kind !== 'multi') return;
    const current = overlay.editor.answers[field.key];
    const chosen = Array.isArray(current) ? current : [];
    const choice = multiChoices(field, chosen)[index];
    if (choice === undefined) return;
    this.setState('overlay', {
      ...overlay,
      editor: {
        ...overlay.editor,
        cursor: index,
        answers: {
          ...overlay.editor.answers,
          [field.key]: toggleOption(field, chosen, choice.value),
        },
        problem: undefined,
      },
    });
  }

  private async finishForm(
    origin: Extract<Overlay, { kind: 'form' }>,
    send: (backend: Backend) => Promise<void>,
  ): Promise<void> {
    const formID = origin.editor.formID;
    const key = JSON.stringify([origin.serverID, origin.sessionID, origin.formSessionID, formID]);
    if (this.answeringForms.has(key)) return;
    this.answeringForms.add(key);
    const closeOrigin = () => {
      const current = this.state.overlay;
      if (
        current.kind === 'form' &&
        current.serverID === origin.serverID &&
        current.sessionID === origin.sessionID &&
        current.formSessionID === origin.formSessionID &&
        current.editor.formID === formID &&
        current.requestToken === origin.requestToken
      ) {
        this.closeOverlay();
      }
    };
    try {
      const backend = this.backendFor(origin.serverID);
      await send(backend);
      closeOrigin();
    } catch (error) {
      if (
        error instanceof BackendError &&
        (error.kind === 'not-found' || error.kind === 'conflict')
      ) {
        closeOrigin();
        this.showNotice('Already answered elsewhere.', 'dim');
      } else {
        this.showNotice(errorText(error), 'error');
      }
    }
    try {
      await this.refreshInputRequests(origin.sessionID, origin.serverID);
    } catch (error) {
      this.showNotice(`Could not refresh form requests: ${errorText(error)}`, 'error');
    } finally {
      this.answeringForms.delete(key);
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

  expandedSets(): { groups: Set<string>; diffs: Set<string>; tools: Set<string> } {
    const prefix = this.expansionPrefix();
    if (prefix === undefined) return { groups: new Set(), diffs: new Set(), tools: new Set() };
    const strip = (key: string): string => key.slice(prefix.length);
    const keys = (map: Record<string, true>): Set<string> =>
      new Set(
        Object.keys(map)
          .filter((key) => key.startsWith(prefix))
          .map(strip),
      );
    return {
      groups: keys(this.state.expandedGroups),
      diffs: keys(this.state.expandedDiffs),
      tools: keys(this.state.expandedTools),
    };
  }

  /** Whether one tool row inside an expanded group is open (#281). */
  isToolExpanded(id: string): boolean {
    const prefix = this.expansionPrefix();
    return prefix !== undefined && this.state.expandedTools[`${prefix}${id}`] === true;
  }

  toggleToolExpanded(id: string): void {
    const prefix = this.expansionPrefix();
    if (prefix === undefined) return;
    const qualified = `${prefix}${id}`;
    this.setStateTouchingOverview(
      produce((state) => {
        if (state.expandedTools[qualified] === true) delete state.expandedTools[qualified];
        else state.expandedTools[qualified] = true;
      }),
    );
  }

  toggleGroup(key: string): void {
    const prefix = this.expansionPrefix();
    if (prefix === undefined) return;
    const qualified = `${prefix}${key}`;
    this.setStateTouchingOverview(
      produce((state) => {
        if (state.expandedGroups[qualified] === true) delete state.expandedGroups[qualified];
        else state.expandedGroups[qualified] = true;
      }),
    );
  }

  /** Mouse: select and disclose one group summary without touching other groups. */
  clickToolGroup(key: string): void {
    this.setState('focusedGroup', key);
    this.toggleGroup(key);
  }

  /** Mouse: select and disclose one tool row inside an expanded group (#281). */
  clickToolRow(id: string): void {
    this.setState('focusedGroup', `tool:${id}`);
    this.toggleToolExpanded(id);
  }

  /** Folded nodes for the attached conversation; empty elsewhere. */
  private conversationNodes(): TranscriptNode[] {
    if (this.state.route.kind !== 'conversation') return [];
    const route = this.state.route;
    const target = route.sessionID;
    const key = this.keyFor(route.serverID, target);
    const messages = this.state.transcripts[key]?.messages ?? [];
    const expanded = this.expandedSets();
    const folded = foldTranscript(messages, {
      detailed: this.state.detailed,
      expandedGroups: expanded.groups,
      expandedDiffs: expanded.diffs,
      mcpServers: this.mcpServersFor(route.serverID, this.state.sessions[key]?.directory ?? ''),
    });
    return [...folded, ...workerNodes(this.state.workers[key] ?? [], expanded.groups)];
  }

  /** Server-confirmed workers for a session, in stable render order (#101). */
  workerNodes(sessionID: string, serverID: string = this.activeServerID()): WorkerNode[] {
    return workerNodes(
      this.state.workers[this.keyFor(serverID, sessionID)] ?? [],
      this.expandedSets().groups,
    );
  }

  /** Freshness of the retained worker rows; stale rows stay visible with a warning (#230). */
  workerJobStatus(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): JobListStatus | undefined {
    return this.state.workerStatus[this.keyFor(serverID, sessionID)];
  }

  /** Freshness of the retained shell rows; stale rows stay visible with a warning (#230). */
  shellJobStatus(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): JobListStatus | undefined {
    return this.state.shellStatus[this.keyFor(serverID, sessionID)];
  }

  /** Tool groups in render order; empty outside conversations and in detailed mode. */
  toolGroups(): Extract<TranscriptNode, { kind: 'tool-group' }>[] {
    return this.conversationNodes().filter((node) => node.kind === 'tool-group');
  }

  /**
   * Collapsible transcript items in render order: tool groups, standalone edit tools
   * whose inline diff exceeds the compact preview budget (keys `diff:<toolID>`), and
   * server-confirmed workers (keys `worker:<jobID>`). Detailed mode focuses individual
   * tool results (keys `tool:<toolID>`) because everything is already expanded (#222).
   */
  collapsibleItems(): { key: string; kind: 'group' | 'diff' | 'worker' | 'tool' }[] {
    const expandedGroups = this.expandedSets().groups;
    return this.conversationNodes().flatMap(
      (node): { key: string; kind: 'group' | 'diff' | 'worker' | 'tool' }[] => {
        if (node.kind === 'worker') return [{ key: node.key, kind: 'worker' as const }];
        if (node.kind === 'tool' && this.state.detailed) {
          return [{ key: `tool:${node.tool.id}`, kind: 'tool' as const }];
        }
        if (this.state.detailed) return [];
        if (node.kind === 'tool') {
          // Failures stay expanded and edits keep their inline diff. Other standalone calls
          // (notably delegated task/agent tools) get the same local disclosure as grouped
          // rows, without requiring global detailed mode (#298).
          if (node.expanded || isEditLike(node.tool)) {
            return hasOversizedDiff(node.tool)
              ? [{ key: `diff:${node.tool.id}`, kind: 'diff' as const }]
              : [];
          }
          return [{ key: `tool:${node.tool.id}`, kind: 'tool' as const }];
        }
        if (node.kind === 'tool-group') {
          const group = [{ key: node.key, kind: 'group' as const }];
          if (!expandedGroups.has(node.key)) return group;
          return [
            ...group,
            ...node.tools.map((tool) => ({ key: `tool:${tool.id}`, kind: 'tool' as const })),
          ];
        }
        return [];
      },
    );
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
    else if (item.kind === 'tool') {
      const id = item.key.slice('tool:'.length);
      if (this.state.detailed) {
        // Detailed tools are already expanded; only an oversized diff can grow further.
        const tool = this.toolByID(id);
        if (tool !== undefined && hasOversizedDiff(tool)) this.toggleDiffExpanded(tool.id);
      } else {
        this.toggleToolExpanded(id);
      }
    } else this.toggleGroup(item.key);
    return true;
  }

  /** The rendered tool call with this ID, if it is in the attached conversation. */
  private toolByID(id: string): ToolCall | undefined {
    for (const node of this.conversationNodes()) {
      if (node.kind === 'tool' && node.tool.id === id) return node.tool;
      if (node.kind === 'tool-group') {
        const tool = node.tools.find((entry) => entry.id === id);
        if (tool !== undefined) return tool;
      }
    }
    return undefined;
  }

  toggleDiffExpanded(id: string): void {
    const prefix = this.expansionPrefix();
    if (prefix === undefined) return;
    const qualified = `${prefix}${id}`;
    this.setStateTouchingOverview(
      produce((state) => {
        if (state.expandedDiffs[qualified] === true) delete state.expandedDiffs[qualified];
        else state.expandedDiffs[qualified] = true;
      }),
    );
  }

  clearGroupFocus(): void {
    if (this.state.focusedGroup !== undefined) this.setState('focusedGroup', undefined);
  }

  /** The focused row's tool, preferring the last child-bearing call inside a group. */
  private focusedChildTool(): ToolCall | undefined {
    const focused = this.state.focusedGroup;
    if (focused === undefined) return undefined;
    const nodes = this.conversationNodes();
    if (focused.startsWith('tool:') || focused.startsWith('diff:')) {
      const id = focused.slice(focused.indexOf(':') + 1);
      return nodes
        .flatMap((node) =>
          node.kind === 'tool' ? [node.tool] : node.kind === 'tool-group' ? [...node.tools] : [],
        )
        .find((tool) => tool.id === id);
    }
    if (!focused.startsWith('group:')) return undefined;
    const group = nodes.find((node) => node.kind === 'tool-group' && node.key === focused);
    if (group?.kind !== 'tool-group') return undefined;
    for (let index = group.tools.length - 1; index >= 0; index -= 1) {
      const tool = group.tools[index];
      if (tool !== undefined && (tool.children?.length ?? 0) > 0) return tool;
    }
    return group.tools.at(-1);
  }

  /** Child-page index for a tool; zero when the user has not paged it (#260). */
  childPageFor(toolID: string): number {
    const prefix = this.expansionPrefix();
    return prefix === undefined ? 0 : (this.state.childPages[`${prefix}${toolID}`] ?? 0);
  }

  private childBudgetFor(tool: ToolCall) {
    const prefix = this.expansionPrefix();
    const userExpanded =
      prefix !== undefined && this.state.expandedDiffs[`${prefix}${tool.id}`] === true;
    return toolChildBudget({ detailed: this.state.detailed, userExpanded });
  }

  /**
   * Page the focused execute call's nested child rows without exceeding the inline widget
   * budget. Returns false when the key should remain ordinary composer text: no focused
   * tool, no children, or a single page.
   */
  moveFocusedChildPage(direction: -1 | 1): boolean {
    const tool = this.focusedChildTool();
    if (tool?.children === undefined || tool.children.length === 0) return false;
    const view = pagedToolChildren(
      tool.children,
      this.childBudgetFor(tool),
      this.childPageFor(tool.id),
    );
    if (view.pages <= 1) return false;
    const prefix = this.expansionPrefix();
    if (prefix === undefined) return false;
    const next = (view.page + direction + view.pages) % view.pages;
    this.setState('childPages', `${prefix}${tool.id}`, next);
    return true;
  }

  // ---------------------------------------------------------------- output inspector (#222)

  /** Rows per PageUp/PageDown inside the inspector; the view windows by viewport height. */
  private static readonly INSPECTOR_PAGE_ROWS = 20;

  /** The focused tool result, if the current selection names one. */
  private inspectableTool(): { tool: ToolCall; messageID: string } | undefined {
    const nodes = this.conversationNodes();
    const tools = nodes.flatMap((node) =>
      node.kind === 'tool' ? [node.tool] : node.kind === 'tool-group' ? [...node.tools] : [],
    );
    const focused = this.state.focusedGroup;
    if (focused === undefined) return undefined;
    let candidate: ToolCall | undefined;
    if (focused.startsWith('tool:') || focused.startsWith('diff:')) {
      const id = focused.slice(focused.indexOf(':') + 1);
      candidate = tools.find((tool) => tool.id === id);
    } else if (focused.startsWith('group:')) {
      const group = nodes.find((node) => node.kind === 'tool-group' && node.key === focused);
      candidate = group?.kind === 'tool-group' ? group.tools.at(-1) : undefined;
    }
    if (candidate === undefined) return undefined;
    const found = findToolMessage(this.loadedMessages(), candidate.id);
    return found === undefined ? undefined : { tool: found.tool, messageID: found.messageID };
  }

  /**
   * True when the focused transcript row has a result the inspector can open. Plain `i`
   * stays ordinary text otherwise, so a first-character "i" is never hijacked (#222).
   */
  canInspectFocusedTool(): boolean {
    return this.inspectableTool() !== undefined;
  }

  /**
   * Opens the focused tool's retained result. Cached head/tail content shows immediately;
   * the original message is fetched once, on this deliberate request only (#221).
   */
  openInspector(): boolean {
    const route = this.state.route;
    if (route.kind !== 'conversation') return false;
    const target = this.inspectableTool();
    if (target === undefined) {
      this.showNotice('Nothing to inspect in this conversation yet.', 'warn');
      return false;
    }
    const first = Object.values(target.tool.input).find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    );
    const detail =
      first === undefined
        ? ''
        : ` · ${sanitizeTerminalText(first.split('\n')[0] ?? first).slice(0, 72)}`;
    this.setOverlay({
      kind: 'inspector',
      serverID: route.serverID,
      sessionID: route.sessionID,
      messageID: target.messageID,
      toolID: target.tool.id,
      title: `${target.tool.name}${detail}`,
      query: '',
      queryCursor: 0,
      searching: false,
      offset: 0,
      column: 0,
      loading: true,
      payload: cachedToolResult(target.tool),
    });
    void this.loadInspector(route.serverID, route.sessionID, target.messageID, target.tool.id);
    return true;
  }

  private inspectorIsCurrent(generation: number, toolID: string): boolean {
    const overlay = this.state.overlay;
    return (
      this.interactionGeneration === generation &&
      overlay.kind === 'inspector' &&
      overlay.toolID === toolID
    );
  }

  private async loadInspector(
    serverID: string,
    sessionID: string,
    messageID: string,
    toolID: string,
  ): Promise<void> {
    const generation = this.interactionGeneration;
    try {
      const backend = this.backendFor(serverID);
      const fetched =
        backend.getToolResult === undefined
          ? undefined
          : await backend.getToolResult(sessionID, messageID, toolID);
      if (!this.inspectorIsCurrent(generation, toolID)) return;
      const overlay = this.state.overlay;
      if (overlay.kind !== 'inspector') return;
      if (fetched === undefined) {
        this.setState('overlay', {
          ...overlay,
          loading: false,
          error:
            'on-demand retrieval is unavailable for this server · showing the retained preview',
        });
        return;
      }
      this.setState('overlay', { ...overlay, loading: false, payload: fetched, error: undefined });
    } catch (error) {
      if (!this.inspectorIsCurrent(generation, toolID)) return;
      const overlay = this.state.overlay;
      if (overlay.kind !== 'inspector') return;
      this.setState('overlay', {
        ...overlay,
        loading: false,
        error: `full result unavailable: ${errorText(error)} · showing the retained preview`,
      });
    }
  }

  /** The materialized document for the open inspector, reused until its payload changes. */
  private inspectorDoc(): InspectorIndex | undefined {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'inspector') return undefined;
    return this.inspectorCache.get(overlay.payload);
  }

  /** The visible window for the inspector view; materializes only `rows` lines. */
  inspectorView(rows: number): { lines: readonly string[]; offset: number; total: number } {
    const document = this.inspectorDoc();
    const overlay = this.state.overlay;
    if (document === undefined || overlay.kind !== 'inspector') {
      return { lines: [], offset: 0, total: 0 };
    }
    return inspectorWindow(document.lines, overlay.offset, rows);
  }

  /** Matches for the current query, memoized per query and source identity (#234). */
  inspectorMatches(): readonly number[] {
    const document = this.inspectorDoc();
    const overlay = this.state.overlay;
    if (document === undefined || overlay.kind !== 'inspector') return [];
    return document.matches(overlay.query);
  }

  /** O(1) row highlight membership from the same memoized match set (#234). */
  inspectorMatch(lineIndex: number): boolean {
    const document = this.inspectorDoc();
    const overlay = this.state.overlay;
    if (document === undefined || overlay.kind !== 'inspector') return false;
    return document.matchSet(overlay.query).has(lineIndex);
  }

  private setInspectorState(patch: Partial<Extract<Overlay, { kind: 'inspector' }>>): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'inspector') return;
    this.setState('overlay', { ...overlay, ...patch });
  }

  private moveInspector(delta: number): void {
    const overlay = this.state.overlay;
    const document = this.inspectorDoc();
    if (overlay.kind !== 'inspector' || document === undefined) return;
    const max = Math.max(0, document.lines.length - 1);
    this.setState('overlay', {
      ...overlay,
      offset: Math.min(max, Math.max(0, overlay.offset + delta)),
    });
  }

  private scrollInspector(delta: number): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'inspector') return;
    this.setInspectorState({ column: Math.max(0, overlay.column + delta) });
  }

  /**
   * Applies one grapheme-aware edit to the search field. The query remains a literal,
   * case-insensitive substring; only the cursor plumbing changed (#236).
   */
  private setInspectorSearch(composer: Composer): void {
    const document = this.inspectorDoc();
    if (document === undefined) return;
    const overlay = this.state.overlay;
    if (overlay.kind !== 'inspector') return;
    const matches = document.matches(composer.text);
    this.setState('overlay', {
      ...overlay,
      query: composer.text,
      queryCursor: composer.cursor,
      searching: true,
      offset: matches[0] ?? overlay.offset,
    });
  }

  private jumpInspectorMatch(previous: boolean): void {
    const matches = this.inspectorMatches();
    const overlay = this.state.overlay;
    if (overlay.kind !== 'inspector' || matches.length === 0) return;
    // Start strictly past the current match so repeated Enter/Shift+Enter advances exactly
    // one match instead of landing on the line already shown (#254).
    const next = nextMatch(matches, overlay.offset + (previous ? 0 : 1), previous ? -1 : 1);
    this.setInspectorState({ offset: next });
  }

  /**
   * Inspector keys. `/` enters the search field (and is literal once there); Escape clears a
   * non-empty query before closing; Enter jumps to the next match, Shift+Enter the previous.
   * Backspace/Delete and Left/Right operate on whole graphemes while searching. Ctrl+Y copies
   * the source payload and Ctrl+S saves it.
   */
  inspectorKey(
    key: Readonly<{ name: string; ctrl: boolean; alt: boolean; shift: boolean; text?: string }>,
  ): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'inspector') return;
    if (key.ctrl && key.name === 'y') {
      void this.inspectCopy();
      return;
    }
    if (key.ctrl && key.name === 's') {
      void this.inspectSave();
      return;
    }
    if (key.ctrl && key.name === 'c') {
      this.closeOverlay();
      return;
    }

    const composer: Composer = { text: overlay.query, cursor: overlay.queryCursor };

    if (!overlay.searching) {
      if (key.name === 'escape') {
        this.closeOverlay();
        return;
      }
      switch (key.name) {
        case 'up':
          this.moveInspector(-1);
          return;
        case 'down':
          this.moveInspector(1);
          return;
        case 'left':
          this.scrollInspector(-8);
          return;
        case 'right':
          this.scrollInspector(8);
          return;
        case 'pageup':
          this.moveInspector(-AppController.INSPECTOR_PAGE_ROWS);
          return;
        case 'pagedown':
          this.moveInspector(AppController.INSPECTOR_PAGE_ROWS);
          return;
        case 'home':
          this.moveInspector(-overlay.offset);
          return;
        case 'end': {
          const total = this.inspectorDoc()?.lines.length ?? 1;
          this.moveInspector(total);
          return;
        }
        case 'return':
          this.jumpInspectorMatch(key.shift);
          return;
        default:
          if (key.text !== undefined && key.text !== '') {
            // `/` focuses without entering the slash; any other printable key starts typing.
            if (key.text === '/') this.setInspectorState({ searching: true });
            else this.setInspectorSearch(insertText(composer, key.text));
          }
      }
      return;
    }

    if (key.name === 'escape') {
      if (overlay.query !== '') this.setInspectorSearch({ text: '', cursor: 0 });
      else this.closeOverlay();
      return;
    }
    if ((key.shift || key.ctrl) && (key.name === 'left' || key.name === 'right')) {
      this.scrollInspector(key.name === 'left' ? -8 : 8);
      return;
    }
    switch (key.name) {
      case 'left':
        this.setInspectorSearch(moveLeft(composer));
        return;
      case 'right':
        this.setInspectorSearch(moveRight(composer));
        return;
      case 'home':
        this.setInspectorSearch(moveLineStart(composer));
        return;
      case 'end':
        this.setInspectorSearch(moveLineEnd(composer));
        return;
      case 'up':
        this.moveInspector(-1);
        return;
      case 'down':
        this.moveInspector(1);
        return;
      case 'pageup':
        this.moveInspector(-AppController.INSPECTOR_PAGE_ROWS);
        return;
      case 'pagedown':
        this.moveInspector(AppController.INSPECTOR_PAGE_ROWS);
        return;
      case 'return':
        this.jumpInspectorMatch(key.shift);
        return;
      case 'backspace':
        if (overlay.query === '') {
          this.setInspectorState({ searching: false });
          return;
        }
        this.setInspectorSearch(deleteBackward(composer));
        return;
      case 'delete':
        this.setInspectorSearch(deleteForward(composer));
        return;
      default:
        if (key.text !== undefined && key.text !== '' && !key.ctrl && !key.alt) {
          this.setInspectorSearch(insertText(composer, key.text));
        }
    }
  }

  /** Copy exactly what the source supplied, labeled with its real completeness. */
  async inspectCopy(): Promise<void> {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'inspector' || overlay.payload === undefined) return;
    const text = inspectorText(overlay.payload);
    if (text === '') {
      this.showNotice('This result has no text to copy; file metadata is shown instead.', 'warn');
      return;
    }
    try {
      const result = await this.copyToDestination(text);
      const suffix = ` · ${completenessLabel(overlay.payload.completeness)}`;
      this.showNotice(
        result.method === 'clipboard'
          ? `Clipboard sequence emitted (no terminal acknowledgement)${suffix}.`
          : `Clipboard unavailable; saved ${result.path ?? 'a local file'}${suffix}.`,
        'dim',
      );
    } catch (error) {
      this.showNotice(`Copy failed: ${errorText(error)}`, 'error');
    }
  }

  /** Save exactly what the source supplied to a client-local file. */
  async inspectSave(): Promise<void> {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'inspector' || overlay.payload === undefined) return;
    const text = inspectorText(overlay.payload);
    if (text === '') {
      this.showNotice('This result has no text to save; file metadata is shown instead.', 'warn');
      return;
    }
    const dir = this.deps.copyFallbackDir ?? this.deps.cwd;
    const path = join(dir, `marg-inspect-${process.pid}-${this.deps.now()}.txt`);
    const write = this.deps.writeFile ?? (async (file, body) => void (await Bun.write(file, body)));
    try {
      await write(path, text);
      this.showNotice(`Saved ${path} · ${completenessLabel(overlay.payload.completeness)}.`, 'dim');
    } catch (error) {
      this.showNotice(`Save failed: ${errorText(error)}`, 'error');
    }
  }

  setOverlay(overlay: Overlay): void {
    this.interactionGeneration += 1;
    // Opening any overlay settles a pending footer open: the request that produced it already
    // succeeded, and a later close/Escape must not be mistaken for a toggle-off double click.
    if (overlay.kind !== 'none') this.pendingPickerOpen = undefined;
    this.setState('overlay', overlay);
  }

  closeOverlay(): void {
    this.interactionGeneration += 1;
    const overlay = this.state.overlay;
    if (overlay.kind === 'rewind-picker' && this.state.rewindPending) {
      this.setState('rewindPending', false);
    }
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

  /** Esc Esc / /rewind: open a history-focused selector without touching files (#102). */
  enterRewindSelection(): void {
    const session = this.requireSession();
    if (session === undefined) return;
    const key = this.keyFor(session.serverID, session.id);
    if (this.state.running[key] === true) {
      this.showNotice('Wait for the current run to finish before rewinding.', 'warn');
      return;
    }
    const choices = this.rewindChoices(session.id, session.serverID);
    if (choices.length === 0) {
      this.showNotice('No earlier prompt to rewind to.', 'warn');
      return;
    }
    this.rewindPreviewSeq += 1;
    this.setState('rewindPending', true);
    this.setOverlay({
      kind: 'rewind-picker',
      serverID: session.serverID,
      sessionID: session.id,
      // The latest prompt is the default boundary, matching /revert's existing behaviour.
      index: choices.length - 1,
      files: [],
      loading: true,
      previewUnavailable: false,
    });
    void this.track('rewind-preview', this.refreshRewindPreview());
  }

  /** Previous user prompts in the loaded transcript, oldest first. */
  rewindChoices(
    sessionID: string = this.currentSession()?.id ?? '',
    serverID: string = this.activeServerID(),
  ): RewindCandidate[] {
    const key = this.keyFor(serverID, sessionID);
    return rewindCandidates(this.state.transcripts[key]?.messages ?? []);
  }

  /** Move within the selector and refresh the read-only file preview for the new row. */
  moveRewindPicker(direction: -1 | 1): void {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'rewind-picker') return;
    const count = this.rewindChoices(overlay.sessionID, overlay.serverID).length;
    if (count === 0) return;
    const index = Math.max(0, Math.min(count - 1, overlay.index + direction));
    if (index === overlay.index) return;
    this.rewindPreviewSeq += 1;
    this.setOverlay({ ...overlay, index, files: [], loading: true, previewUnavailable: false });
    void this.track('rewind-preview', this.refreshRewindPreview());
  }

  /**
   * Read-only `session.diff` for the selected prompt. Stale replies are discarded; the
   * preview never stages or commits anything and can be inspected freely before deciding.
   */
  private async refreshRewindPreview(): Promise<void> {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'rewind-picker') return;
    const request = this.rewindPreviewSeq;
    const choice = this.rewindChoices(overlay.sessionID, overlay.serverID)[overlay.index];
    if (choice === undefined) return;
    try {
      const files = await this.backendFor(overlay.serverID).sessionDiff(overlay.sessionID, {
        from: choice.messageID,
      });
      if (this.disposed || request !== this.rewindPreviewSeq) return;
      const current = this.state.overlay;
      if (current.kind !== 'rewind-picker' || current.index !== overlay.index) return;
      this.setOverlay({ ...current, files, loading: false, previewUnavailable: false });
    } catch {
      if (this.disposed || request !== this.rewindPreviewSeq) return;
      const current = this.state.overlay;
      if (current.kind !== 'rewind-picker' || current.index !== overlay.index) return;
      // No preview is not a reason to fabricate a scope; the row stays visible with a
      // clear "unavailable" label and staging will still verify on the server.
      this.setOverlay({ ...current, files: [], loading: false, previewUnavailable: true });
    }
  }

  /** Enter on the selector stages the chosen boundary, then uses the existing confirm dialog. */
  async acceptRewindPicker(): Promise<void> {
    const overlay = this.state.overlay;
    if (overlay.kind !== 'rewind-picker') return;
    const choice = this.rewindChoices(overlay.sessionID, overlay.serverID)[overlay.index];
    if (choice === undefined) return;
    this.closeOverlay();
    await this.stageRevertAt(overlay.serverID, overlay.sessionID, choice.messageID);
  }

  currentDirectory(): string {
    return this.currentProject().directory;
  }

  describeModel(model: ModelSelection | undefined): string {
    return model === undefined ? 'server default' : formatModelRef(model);
  }

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

  /**
   * Commits a confirmed snapshot only when it is at least as new as the last UI revision for
   * this session. A late read or an out-of-order save can never make the view regress (#161).
   */
  private commitGoalUI(key: string, doc: GoalPlanV1): boolean {
    if (!this.goalRevisions.commit(key, doc.revision)) return false;
    this.setState('goals', key, doc);
    return true;
  }

  private async loadGoal(
    sessionID: string,
    serverID: string = this.activeServerID(),
  ): Promise<void> {
    const key = this.keyFor(serverID, sessionID);
    // Capture the lifetime and the last goal revision admitted *before* the read. A session
    // deleted and recreated under the same ID has a new epoch, and any newer local commit
    // supersedes this snapshot even when its revision number happens to match (#278).
    const epoch = this.sessionEpoch(key);
    const existed = this.state.sessions[key] !== undefined;
    const revisionAtStart = this.goalRevisions.revision(key);
    try {
      const doc = await this.goalStore.load({ serverID, sessionID });
      if (doc === undefined || this.disposed) return;
      if (!this.isSessionCurrent(key, epoch)) return;
      // A new-session read is allowed while the session is still unindexed; it is rejected
      // once the lifetime changed or a local/newer goal state was committed meanwhile.
      if (existed && this.state.sessions[key] === undefined) return;
      if (this.goalRevisions.revision(key) !== revisionAtStart) return;
      this.commitGoalUI(key, doc);
    } catch (error) {
      if (!this.isSessionCurrent(key, epoch)) return;
      this.showNotice(`Goal file unreadable: ${errorText(error)}`, 'warn');
    }
  }

  private requireSession(): SessionSummary | undefined {
    const session = this.currentSession();
    if (session === undefined) this.showNotice('Open a session first.', 'warn');
    return session;
  }

  /**
   * Applies an edit and saves with compare-and-swap. Local edits are serialized per session so
   * they rebase deterministically instead of racing; conflicts from other windows are retried
   * with a bounded budget rather than a single blind retry (#161).
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
    const previous = this.goalEditChains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.goalEditChains.set(
      key,
      previous.then(() => tail),
    );
    await previous;
    try {
      return await this.applyGoalChange(key, serverID, sessionID, change, notice);
    } finally {
      release();
      const chain = this.goalEditChains.get(key);
      if (chain !== undefined) {
        void chain.then(() => {
          if (this.goalEditChains.get(key) === chain) this.goalEditChains.delete(key);
        });
      }
    }
  }

  /** Bounded CAS loop: each conflict rebases the same edit onto the newest disk snapshot. */
  private async applyGoalChange(
    key: string,
    serverID: string,
    sessionID: string,
    change: (doc: GoalPlanV1) => GoalPlanV1,
    notice?: string,
  ): Promise<GoalPlanV1 | undefined> {
    const session = this.state.sessions[key];
    let base =
      this.state.goals[key] ?? emptyGoalPlan(serverID, sessionID, session?.projectID ?? '');
    const maxAttempts = 5;
    let rebased = false;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const saved = await this.goalStore.save(change(base));
        this.commitGoalUI(key, saved);
        if (notice !== undefined) {
          this.showNotice(
            `${notice}${rebased ? ' · merged with a change from another window' : ''}`,
            'dim',
          );
        }
        return saved;
      } catch (error) {
        if (!(error instanceof GoalConflictError)) {
          this.showNotice(`Goal not saved: ${errorText(error)}`, 'error');
          return undefined;
        }
        if (attempt === maxAttempts - 1) {
          this.showNotice(
            `Goal not saved after ${maxAttempts} conflicting updates; keep your edits and retry.`,
            'error',
          );
          return undefined;
        }
        base = error.current;
        rebased = true;
      }
    }
    return undefined;
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
    } else if (key.name === 'pageup' && count > 0) {
      this.setOverlay({ ...overlay, index: Math.max(0, overlay.index - 10) });
    } else if (key.name === 'pagedown' && count > 0) {
      this.setOverlay({ ...overlay, index: Math.min(count - 1, overlay.index + 10) });
    } else if (key.name === 'home' && count > 0) {
      this.setOverlay({ ...overlay, index: 0 });
    } else if (key.name === 'end' && count > 0) {
      this.setOverlay({ ...overlay, index: count - 1 });
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
      const backend = this.backendFor(session.serverID);
      await backend.renameSession(session.id, title);
      // A host unpaired during the RPC must not get its row resurrected.
      if (!this.isRegisteredBackend(session.serverID, backend)) return;
      // The server's session event carries the authoritative title; reflect it now too.
      this.setStateTouchingOverview('sessions', this.keyFor(session.serverID, session.id), {
        ...session,
        title,
      });
      this.showNotice(`Renamed to ${title}`, 'dim');
    } catch (error) {
      this.showNotice(`Rename failed: ${errorText(error)}`, 'error');
    }
  }

  private async forkCurrent(): Promise<void> {
    const session = this.requireSession();
    if (session === undefined) return;
    const { serverID, id: sessionID } = session;
    const generation = this.interactionGeneration;
    const currentGoal = this.state.goals[this.keyFor(serverID, sessionID)];
    const doc = currentGoal === undefined ? undefined : structuredClone(unwrap(currentGoal));
    try {
      const backend = this.backendFor(serverID);
      const forked = await backend.forkSession(sessionID);
      const forkKey = this.keyFor(serverID, forked.id);
      if (this.isRegisteredBackend(serverID, backend)) {
        this.setStateTouchingOverview('sessions', forkKey, { ...forked, serverID });
      }
      let goalError: string | undefined;
      if (doc !== undefined) {
        // Copy, never alias: the fork gets its own sidecar file.
        const copy = forkGoalPlan(doc, forked.id);
        try {
          const saved = await this.goalStore.save(copy);
          if (
            this.isRegisteredBackend(serverID, backend) &&
            this.state.sessions[forkKey] !== undefined
          ) {
            this.setState('goals', forkKey, saved);
          }
        } catch (error) {
          goalError = errorText(error);
        }
      }
      const current = this.currentSession();
      if (
        this.interactionGeneration === generation &&
        current?.serverID === serverID &&
        current.id === sessionID &&
        this.isRegisteredBackend(serverID, backend) &&
        this.state.sessions[forkKey] !== undefined
      ) {
        this.openSession(forked.id, serverID);
      }
      this.showNotice(
        goalError === undefined
          ? 'Forked into a new session'
          : `Fork created, but its goal could not be saved: ${goalError}`,
        goalError === undefined ? 'dim' : 'warn',
      );
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
    if (overlay.kind === 'rewind-picker') {
      // An external stage while selecting supersedes the picker; never swap it for a
      // different conversation's dialog (#82, #102).
      if (overlay.serverID === serverID && overlay.sessionID === sessionID) this.closeOverlay();
      return;
    }
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
    const messageID = turnStart(
      this.state.transcripts[this.keyFor(session.serverID, session.id)]?.messages ?? [],
    );
    if (messageID === undefined) {
      this.showNotice('Nothing to revert yet.', 'warn');
      return;
    }
    await this.stageRevertAt(session.serverID, session.id, messageID);
  }

  /**
   * Stages one verified boundary on its owning host. Route ownership is rechecked after the
   * RPC so a host/session switch during the call cannot open the wrong dialog (#82, #102).
   */
  private async stageRevertAt(
    serverID: string,
    sessionID: string,
    messageID: string,
  ): Promise<void> {
    try {
      const files = await this.backendFor(serverID).stageRevert(sessionID, messageID);
      // The route may have changed while the RPC was in flight: the dialog belongs to the
      // host whose stage this is, and only that conversation may open it.
      const route = this.state.route;
      if (
        route.kind !== 'conversation' ||
        route.serverID !== serverID ||
        route.sessionID !== sessionID
      ) {
        this.showNotice('A revert was staged on this session. Return to it to confirm.', 'warn');
        return;
      }
      this.setOverlay({
        kind: 'revert',
        serverID,
        sessionID,
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
      this.releaseRevertOverlay(overlay);
      this.showNotice(`Revert failed: ${errorText(error)}`, 'error');
    });
  }

  /** True only while the exact busy dialog this operation was started from is displayed. */
  private isRevertOverlayShown(origin: {
    serverID: string;
    sessionID: string;
    messageID: string;
  }): boolean {
    const current = this.state.overlay;
    return (
      current.kind === 'revert' &&
      current.busy &&
      current.serverID === origin.serverID &&
      current.sessionID === origin.sessionID &&
      current.messageID === origin.messageID
    );
  }

  /** Re-enables the originating dialog; never touches a different overlay (#197). */
  private releaseRevertOverlay(origin: {
    serverID: string;
    sessionID: string;
    messageID: string;
  }): void {
    if (!this.isRevertOverlayShown(origin)) return;
    this.setState('overlay', (current) =>
      current.kind === 'revert' ? { ...current, busy: false } : current,
    );
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
      this.releaseRevertOverlay(overlay);
      this.showNotice(
        `Revert not ${confirm ? 'committed' : 'cancelled'}: could not verify the staged revert (${errorText(error)}).`,
        'error',
      );
      return;
    }
    const staged = summary?.revert;
    this.setStateTouchingOverview(
      'sessions',
      this.keyFor(overlay.serverID, overlay.sessionID),
      reconcile({ ...summary, serverID: overlay.serverID }),
    );
    if (staged?.messageID !== overlay.messageID) {
      // The stage changed or vanished under us (another client committed/cleared it).
      if (this.isRevertOverlayShown(overlay)) this.closeOverlay();
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
      this.releaseRevertOverlay(overlay);
      this.showNotice(`Revert failed: ${errorText(error)}`, 'error');
      return;
    }
    if (this.isRevertOverlayShown(overlay)) this.closeOverlay();
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
 * than (or exactly as old as) the page are kept, everything the page covers is replaced by
 * server data. Timestamps alone never prove a cached message was replaced (#205).
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
      ? cached.filter((message) => !pageIDs.has(message.id) && message.createdAt <= first.createdAt)
      : cached.slice(0, boundary);
  return [...older, ...page];
}

// Kept as a stable re-export while the CLI and production assembly migrate to the
// focused module (#316).
export { errorText } from './error-text.ts';

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
