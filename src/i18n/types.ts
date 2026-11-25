/**
 * The locale contract for every human-authored string Margarita shows.
 *
 * Semantic values (`'all'`, `'working'`, protocol field kinds, command names) stay in the
 * application layers; this file only describes display text. Locale modules import nothing
 * but other i18n modules, so the catalog can never depend back on `domain`, `ui` or `app`.
 */

/** Time-of-day pools used to pick a greeting (mirrors `domain/greeting-time.ts`). */
export type GreetingPeriod = 'morning' | 'afternoon' | 'evening' | 'night';

/**
 * One display wording, or a pool of interchangeable wordings. A plain string means "always
 * say this"; an array lets the presentation layer rotate between variants slowly. Pools are
 * only for words that describe the same state, never for different facts or commands.
 */
export type Variations = string | readonly string[];

/** Tool categories whose running/completed activity is described to the user. */
export type ToolCategory =
  'read' | 'search' | 'edit' | 'shell' | 'code' | 'web' | 'delegate' | 'other';

/** Overview filter identities; only their display labels live in this catalog. */
export type OverviewTab = 'all' | 'local' | 'remotes' | 'active' | 'needs-input';

/** Footer execution states, derived from server facts by the domain layer. */
export type ExecutionStateName =
  'idle' | 'failed' | 'interrupted' | 'working' | 'needs-input' | 'reconnecting' | 'unknown';

/** Names of frontend-local slash commands; descriptions are localized, names are not. */
export type LocalCommandName =
  | 'sessions'
  | 'bg'
  | 'new'
  | 'resume'
  | 'agent'
  | 'model'
  | 'effort'
  | 'transcript'
  | 'copy'
  | 'diff'
  | 'usage'
  | 'btw'
  | 'interrupt'
  | 'queue'
  | 'compact'
  | 'export'
  | 'criteria'
  | 'plan'
  | 'rename'
  | 'fork'
  | 'revert'
  | 'rewind'
  | 'steer'
  | 'status'
  | 'keys'
  | 'help'
  | 'quit'
  | 'server'
  | 'pair'
  | 'servers'
  | 'unpair';

/** Elapsed-time forms used by the inline activity indicator. */
export interface ThrobberElapsedStrings {
  readonly hoursMinutes: (hours: number, minutes: number) => string;
  readonly minutesSeconds: (minutes: number, seconds: number) => string;
  readonly seconds: (seconds: number) => string;
}

export interface GreetingStrings {
  readonly catalog: Readonly<Record<GreetingPeriod | 'anytime', readonly string[]>>;
  /** Last-resort greeting when every pool is empty. Must be non-empty. */
  readonly fallback: string;
}

/**
 * User-facing text for the inline activity indicator (docs/21-throbber.md). Only display
 * text lives here; glyphs and animation frames are presentation mechanics.
 */
export interface ThrobberStrings {
  readonly decorativeVerbs: readonly string[];
  readonly fallbackVerb: string;
  /** Live state labels. Each value may be one wording or a slowly rotating pool. */
  readonly activity: Readonly<Record<ToolCategory, Variations>>;
  readonly compacting: string;
  readonly thinking: string;
  readonly tipPrefix: string;
  readonly tips: readonly string[];
  readonly tokens: (count: string) => string;
  readonly finishedAt: (time: string) => string;
  readonly interrupted: string;
  readonly failed: string;
  readonly elapsed: ThrobberElapsedStrings;
}

export interface OverviewStrings {
  readonly title: string;
  readonly tabs: Readonly<Record<OverviewTab, string>>;
  readonly compactTabs: Readonly<Record<OverviewTab, string>>;
  readonly tinyTabs: Readonly<Record<OverviewTab, string>>;
  readonly loading: string;
  readonly empty: string;
  readonly remoteGlyph: string;
  readonly remoteAsciiMarker: string;
  readonly remoteFallbackLabel: string;
  readonly offlineMarker: string;
  readonly showLess: string;
  readonly showMore: (hidden: number) => string;
  readonly pairedUnavailable: (label: string) => string;
  readonly restoringPaired: (label: string) => string;
  readonly recentOnly: string;
  readonly loadingMore: string;
  readonly retryLoadMore: string;
  readonly loadMore: string;
  readonly couldNotLoadMore: (error: string) => string;
  readonly allLoaded: string;
  readonly newSessionIn: (directory: string) => string;
  readonly tasksProgress: (done: number, total: number) => string;
  readonly now: string;
}

export interface ChromeStrings {
  readonly productVersion: (version: string) => string;
  readonly welcome: {
    readonly loadingModel: string;
    readonly modelUnavailable: string;
    readonly agentUnavailable: string;
    readonly overviewHint: string;
    readonly modelHint: string;
    readonly detailsHint: string;
  };
  readonly composer: {
    readonly newSessionIn: (directory: string) => string;
    readonly newSessionWithOverview: (directory: string) => string;
    readonly conversationPlaceholder: string;
    readonly externalEditorMissing: string;
    readonly editorExited: (code: string) => string;
  };
  readonly footer: {
    readonly loadingModel: string;
    readonly modelUnavailable: string;
    readonly queued: (count: number) => string;
    readonly contextPercent: (percent: number) => string;
    readonly contextTokens: (count: string) => string;
    readonly tokensInOut: (mark: string, input: string, output: string) => string;
    readonly tokensTotal: (mark: string, total: string) => string;
    readonly tokensUnknown: string;
  };
  readonly execution: Readonly<Record<ExecutionStateName, string>>;
  readonly goalBadge: {
    readonly statusWords: Readonly<Record<'active' | 'paused' | 'complete', string>>;
    readonly stale: (glyph: string) => string;
    readonly followUp: (glyph: string) => string;
    readonly active: (glyph: string, rounds: number) => string;
    readonly status: (glyph: string, word: string) => string;
  };
}

export interface KeysStrings {
  readonly unbound: string;
  readonly left: string;
  readonly leftDetail: string;
  readonly interrupt: string;
  readonly interruptDetail: string;
  readonly helpTitle: string;
  readonly helpRows: (start: number, end: number, total: number) => string;
}

export interface UsageStrings {
  readonly title: string;
  readonly notApplicable: string;
  readonly contextPending: string;
  readonly contextUnknown: string;
  readonly contextLine: (tokens: string) => string;
  readonly contextWithLimit: (tokens: string, limit: string, percent: number) => string;
  readonly contextLimitUnknown: (tokens: string) => string;
  readonly sessionLine: (sessionID: string, serverID: string, stale: boolean) => string;
  readonly sinceCompaction: (tokens: string, compactions: number) => string;
  readonly lastCompaction: (at: string) => string;
  readonly lifetimeHeading: string;
  readonly lifetimeUnreported: string;
  readonly lifetimeCounts: (input: string, output: string, reasoning: string) => string;
  readonly lifetimeCache: (read: string, write: string) => string;
  readonly spend: (cost: string) => string;
  readonly activityHeading: string;
  readonly toolTurns: (turns: number, total: number, percent: string, calls: number) => string;
  readonly toolCategoryLine: (counts: Readonly<Record<ToolCategory | 'mcp', number>>) => string;
  readonly outcomes: (
    completed: number,
    failed: number,
    running: number,
    other: number,
    percent: string,
  ) => string;
  readonly loadedOnly: string;
  readonly notReported: string;
}

export interface InspectorStrings {
  readonly title: (title: string) => string;
  readonly lineSummary: (total: string, first: number, last: number) => string;
  readonly source: (label: string) => string;
  readonly fetching: string;
  readonly hints: string;
  readonly searchPrompt: (query: string, matches: number) => string;
  readonly noRetainedText: string;
}

export interface ServersStrings {
  readonly title: string;
  readonly row: (marker: string, label: string, baseUrl: string, state: string) => string;
  readonly unpairTitle: string;
  readonly unpairConfirm: (label: string) => string;
  readonly unpairDetail: string;
}

export interface QueueStrings {
  readonly title: string;
  readonly empty: string;
  readonly row: (marker: string, delivery: string, text: string) => string;
  readonly position: (index: number, total: number) => string;
}

export interface ModelStrings {
  readonly titleConversation: string;
  readonly titleNewSession: string;
  readonly empty: string;
  readonly position: (index: number, total: number) => string;
  readonly noVariants: string;
  readonly effortTitle: string;
  readonly current: string;
  readonly currentLabel: string;
}

export interface AgentStrings {
  readonly titleConversation: string;
  readonly titleNewSession: string;
  readonly empty: string;
  readonly currentLabel: string;
  readonly position: (index: number, total: number) => string;
}

export interface CopyStrings {
  readonly title: string;
  readonly empty: string;
  readonly unretainedHint: string;
  readonly customValue: string;
  readonly position: (index: number, total: number) => string;
}

export interface TasksStrings {
  readonly proposedTitle: string;
  readonly title: (done: number, total: number) => string;
  readonly goal: (objective: string) => string;
  readonly localGoal: (title: string) => string;
  readonly nativeActive: (rounds: number, maxRounds: number) => string;
  readonly nativeComplete: (rounds: number, maxRounds: number) => string;
  readonly nativePaused: (rounds: number, maxRounds: number, reason: string) => string;
  readonly nativeUnavailable: (reason: string) => string;
  readonly nativeLastKnown: (status: string, reason: string) => string;
  readonly selectSession: string;
  readonly noPlan: string;
  readonly evidence: (count: number) => string;
  readonly position: (index: number, total: number) => string;
  readonly acceptance: (count: number) => string;
}

export interface RewindStrings {
  readonly title: string;
  readonly promptPicker: (count: number, index: number) => string;
  readonly scope: (ordinal: string, summary: string) => string;
  readonly reading: string;
  readonly scopeUnavailable: string;
  readonly filesOnly: string;
  readonly utc: string;
  readonly staging: string;
}

export interface RevertStrings {
  readonly title: string;
  readonly confirm: (summary: string) => string;
  readonly working: string;
}

export interface DiffStrings {
  readonly title: (file: string) => string;
  readonly noPatchLines: (index: number, total: number) => string;
  readonly position: (
    first: number,
    last: number,
    total: number,
    index: number,
    files: number,
  ) => string;
  readonly serverTruncated: string;
  readonly changesTitle: (scope: string, summary: string, otherScope: string) => string;
  readonly thisTurn: string;
  readonly session: string;
  readonly loading: string;
  readonly empty: string;
  readonly noFiles: string;
  readonly noChanges: string;
  readonly summary: (files: number, additions: number, deletions: number) => string;
  readonly filesPosition: (first: number, last: number, total: number, selected: number) => string;
}

export interface FormDialogStrings {
  readonly answeredOrWithdrawn: string;
  readonly externalStep: (url: string) => string;
  readonly openUrl: string;
  readonly copyUrl: string;
  readonly externalDetail: string;
  readonly customEditing: string;
  readonly customListed: string;
  readonly customPrompt: string;
  readonly choicePosition: (index: number, total: number) => string;
  readonly externalHints: string;
  readonly hints: (custom: boolean) => string;
  readonly multiCustomHints: string;
  readonly yes: string;
  readonly no: string;
}

export interface HistoryStrings {
  readonly title: (key: string) => string;
  readonly noMatch: string;
}

export interface OverlaysStrings {
  readonly keys: KeysStrings;
  readonly inspector: InspectorStrings;
  readonly usage: UsageStrings;
  readonly status: {
    readonly title: string;
    readonly server: (url: string) => string;
    readonly stream: (stream: string) => string;
    readonly project: (directory: string) => string;
    readonly session: (id: string) => string;
  };
  readonly servers: ServersStrings;
  readonly queue: QueueStrings;
  readonly model: ModelStrings;
  readonly effort: ModelStrings;
  readonly agent: AgentStrings;
  readonly copy: CopyStrings;
  readonly tasks: TasksStrings;
  readonly rewind: RewindStrings;
  readonly revert: RevertStrings;
  readonly diff: DiffStrings;
  readonly form: FormDialogStrings;
  readonly history: HistoryStrings;
}

export interface TranscriptStrings {
  readonly completeness: {
    readonly complete: string;
    readonly frontendElided: string;
    readonly serverTruncated: string;
  };
  readonly meta: {
    readonly agentSwitched: (agent: string) => string;
    readonly modelSwitched: (model: string, variant: string | undefined) => string;
  };
  readonly notices: {
    readonly runFailed: (error: string | undefined) => string;
    readonly interrupted: string;
    readonly compactionFailed: string;
    readonly compacted: string;
  };
  readonly tools: Readonly<Record<ToolCategory, (count: number) => string>> & {
    readonly externalCalls: (count: number) => string;
    readonly serverCalls: (server: string, count: number) => string;
  };
  /** Live label beneath a collapsed tool group; same variation rules as throbber activity. */
  readonly live: Readonly<Record<ToolCategory, Variations>>;
  readonly history: {
    readonly loadingEarlier: string;
    readonly checkFailed: string;
    readonly hidden: string;
    readonly loadingConversation: string;
  };
  readonly background: {
    readonly retained: (detail: string) => string;
    readonly unavailable: (detail: string) => string;
    readonly refreshFailed: string;
  };
  readonly reasoning: {
    readonly done: string;
    readonly inProgress: string;
    readonly unavailable: (tokens: number) => string;
    readonly hiddenRows: (rows: number) => string;
  };
  readonly shell: {
    readonly stillRunning: string;
    readonly lastReportedRunning: string;
    readonly status: (status: string, exitCode: number | undefined) => string;
    readonly hiddenRows: (rows: number, action: string) => string;
    readonly outputTruncated: string;
  };
  readonly tool: {
    readonly write: string;
    readonly update: string;
    readonly changed: (name: string) => string;
    readonly scriptFailed: (text: string) => string;
    readonly scriptRowsHidden: (rows: number) => string;
    readonly moreFiles: (files: number) => string;
    readonly diffUnavailable: string;
    readonly moreRows: (rows: number) => string;
    readonly earlierRowsHidden: (rows: number) => string;
    readonly childMissingReason: string;
    readonly childSummary: (shown: number, total: number, counts: string) => string;
    readonly childPage: (page: number, pages: number, keys: string) => string;
    readonly failedCount: (failed: number, shown: number | undefined) => string;
    readonly runningCount: (running: number) => string;
    readonly completedCount: (completed: number) => string;
    readonly pageKeys: (previous: string, next: string) => string;
    readonly changeSummary: (added: string, removed: string) => string;
    readonly clamps: {
      readonly detailed: (lines: string) => string;
      readonly compact: (lines: string) => string;
    };
    readonly outputTruncated: string;
    readonly outputElided: string;
  };
  readonly marker: {
    readonly completed: string;
    readonly failed: string;
    readonly interrupted: string;
    readonly in: string;
    readonly after: string;
    readonly event: (status: string, preposition: string | undefined, elapsed: string) => string;
    readonly done: (event: string, time: string) => string;
  };
  readonly permission: {
    readonly title: string;
    readonly more: (count: number) => string;
    readonly focusedHints: string;
    readonly hints: string;
    readonly allowOnce: string;
    readonly alwaysAllow: string;
    readonly reject: string;
  };
  readonly formCard: {
    readonly title: string;
    readonly noQuestions: (key: string) => string;
    readonly fields: (count: number, key: string) => string;
  };
  readonly requests: {
    readonly title: string;
    readonly missing: (detail: string) => string;
    readonly cached: (key: string) => string;
  };
  readonly backgroundHint: (key: string) => string;
  readonly queued: {
    readonly label: (key: string) => string;
    readonly nextSteer: (key: string) => string;
    readonly more: (count: number) => string;
  };
  readonly worker: {
    readonly line: (
      focus: string,
      agent: string,
      description: string,
      status: string,
      running: string,
      stale: string,
      enter: string,
    ) => string;
    readonly childSession: (id: string) => string;
    readonly started: (at: string) => string;
    readonly completed: (at: string) => string;
    readonly resultLocation: string;
  };
  /** `… N more rows · inspect to read the rest` inside a bounded preview. */
  readonly moreRowsInspect: (rows: number) => string;
  readonly outputTruncatedByServer: string;
}

export interface FormsStrings {
  readonly required: string;
  readonly pickOneOfOptions: string;
  readonly expectedWholeNumber: string;
  readonly expectedNumber: string;
  readonly atLeast: (minimum: number) => string;
  readonly atMost: (maximum: number) => string;
  readonly pickAtLeast: (minimum: number) => string;
  readonly pickAtMost: (maximum: number) => string;
  readonly minLength: (minimum: number) => string;
  readonly maxLength: (maximum: number) => string;
  readonly patternMismatch: string;
  readonly email: string;
  readonly uri: string;
  readonly date: string;
  readonly dateTime: string;
  readonly alreadyChosen: string;
  readonly noFieldSelected: string;
  readonly openExternalInBrowser: string;
  readonly fieldDoesNotAcceptText: string;
}

export interface ErrorsStrings {
  readonly pairing: {
    readonly invalidUrl: string;
    readonly httpOnly: string;
    readonly embeddedCredentials: string;
    readonly queryOrFragment: string;
    readonly missingConnectSuffix: string;
    readonly missingCode: string;
    readonly usageShortname: string;
    readonly usageUrl: string;
    readonly onlyOneUrl: string;
    readonly unknownOption: (option: string) => string;
    readonly usageFull: string;
    readonly manualNeedsShortname: string;
    readonly invalidServerUrl: string;
    readonly serverHttpOnly: string;
    readonly serverEmbeddedCredentials: string;
    readonly serverQueryOrFragment: string;
  };
  readonly inspector: {
    readonly scriptFailed: string;
    readonly files: (count: number) => string;
  };
  readonly profile: {
    readonly shortname: string;
    readonly invalidUrl: string;
    readonly unsupportedProtocol: (protocol: string) => string;
    readonly credentials: string;
    readonly fragment: string;
    readonly needsIdentity: string;
    readonly localReserved: string;
    readonly shortnameInUse: (name: string) => string;
    readonly alreadyRegistered: string;
    readonly noProfile: (serverID: string) => string;
    readonly unreadable: (detail: string) => string;
    readonly unreadablePreserved: (backup: string, detail: string) => string;
    readonly unreadablePreservedShort: (backup: string) => string;
    readonly malformed: (path: string) => string;
    readonly skipped: (count: number, path: string) => string;
  };
}

export interface CommandsStrings {
  readonly descriptions: Readonly<Record<LocalCommandName, string>>;
  readonly serverCommandFallback: string;
}

export interface CliStrings {
  readonly prefix: string;
  readonly version: (version: string) => string;
  readonly usageHint: string;
  readonly unknownServer: (alias: string) => string;
  readonly startingService: string;
  readonly connectFailedAdvice: string;
  readonly couldNotLoad: (url: string, detail: string) => string;
  readonly configWarning: (warning: string) => string;
  readonly keyWarning: (error: string) => string;
  readonly printNeedsPrompt: string;
  readonly remoteNeedsCwd: string;
  readonly noSessionToContinue: string;
  readonly couldNotContinue: (detail: string) => string;
  readonly localStateNotSaved: (detail: string) => string;
  readonly revertNotCancelled: (detail: string) => string;
  readonly postMountMaintenanceFailed: (detail: string) => string;
  readonly sessionNotFound: (sessionID: string) => string;
  readonly catalogUnavailable: (directory: string) => string;
  readonly modelNotConfirmed: string;
  readonly selectionFailed: (detail: string) => string;
  readonly serverNotRegistered: (name: string) => string;
  readonly resolveSessionFailed: (sessionID: string, detail: string) => string;
  readonly sessionAmbiguous: (sessionID: string, servers: string) => string;
  readonly agentNotSelectable: (requested: string, available: string) => string;
  readonly args: {
    readonly requiresValue: (flag: string) => string;
    readonly duplicated: (flag: string) => string;
    readonly unknownOption: (flag: string) => string;
    readonly jsonRequiresPrint: string;
    readonly continueResumeConflict: string;
    readonly serverStartServerConflict: string;
    readonly remoteLocalConflict: string;
    readonly remoteServerConflict: string;
    readonly remoteStartServerConflict: string;
    readonly localServerConflict: string;
    readonly resumeNeedsId: string;
    readonly printNeedsPrompt: string;
  };
  readonly help: string;
  readonly model: {
    readonly effortRequiresModel: string;
    readonly providerNeedsModel: (provider: string, available: string) => string;
    readonly invalidModel: (raw: string) => string;
    readonly providerMismatch: (parsed: string, flag: string) => string;
    readonly variantMismatch: (parsed: string, flag: string) => string;
    readonly notInCatalog: (raw: string) => string;
    readonly noCatalogMatch: string;
    readonly offeredBySeveral: (model: string, providers: string) => string;
    readonly disabled: (providerID: string, modelID: string) => string;
    readonly noVariant: (
      providerID: string,
      modelID: string,
      variant: string,
      available: string,
    ) => string;
    readonly noneAvailable: string;
    readonly blocked: (selected: boolean) => string;
  };
  readonly print: {
    readonly cancelledCreatingSession: (sessionID: string) => string;
    readonly cancelledSubmitting: (sessionID: string, detail: string) => string;
    readonly cancelledAfterSubmit: (sessionID: string) => string;
    readonly sessionStopped: (cause: string | undefined) => string;
    readonly promptLeftQueue: string;
    readonly promptDidNotStart: (ms: number) => string;
    readonly turnFinished: (outcome: string, detail: string) => string;
  };
}

export interface LocaleStrings {
  readonly greetings: GreetingStrings;
  readonly throbber: ThrobberStrings;
  readonly overview: OverviewStrings;
  readonly chrome: ChromeStrings;
  readonly overlays: OverlaysStrings;
  readonly transcript: TranscriptStrings;
  readonly forms: FormsStrings;
  readonly errors: ErrorsStrings;
  readonly commands: CommandsStrings;
  readonly notices: NoticesStrings;
  readonly cli: CliStrings;
}

/** User-facing controller notices, grouped by the feature that emits them. */
export interface NoticesStrings {
  readonly clipboard: {
    readonly empty: string;
    readonly cannotRead: (detail: string) => string;
    readonly cannotPaste: (detail: string) => string;
    readonly readFailed: (detail: string) => string;
    readonly copyFailed: (detail: string) => string;
    readonly noCompleteResponseHistory: string;
    readonly noCompleteResponse: string;
    readonly copied: (label: string, suffix: string) => string;
    readonly unconfirmed: (label: string, suffix: string) => string;
    readonly savedToFile: (label: string, path: string, suffix: string) => string;
    readonly unavailable: (label: string, detail: string, suffix: string) => string;
    readonly failed: (suffix: string) => string;
    readonly noSelection: string;
    readonly noSession: string;
  };
  readonly attachments: {
    readonly notText: string;
    readonly notTextOrImage: string;
    readonly questionsTextOnly: string;
    readonly dialogTextOnly: string;
    readonly questionChangedClipboard: string;
    readonly questionChanged: string;
    readonly answeredOrWithdrawn: string;
    readonly pasteTruncated: (limit: number) => string;
    readonly pasteStashedImages: (count: number) => string;
    readonly pasteStashedText: string;
    readonly unsupportedType: (type: string) => string;
    readonly emptyAttachment: string;
    readonly tooLarge: (limit: string) => string;
    readonly removed: (label: string) => string;
    readonly attachedOne: (name: string) => string;
    readonly attachedMany: (count: number) => string;
    readonly externalSaved: (origin: string) => string;
    readonly externalNotApplied: (origin: string, path: string) => string;
    readonly externalFailed: (origin: string, detail: string) => string;
  };
  readonly session: {
    readonly localStateWarning: (detail: string) => string;
    readonly localStateNotSaved: (detail: string) => string;
    readonly projectCatalogFailed: (detail: string) => string;
    readonly sessionIndexFailed: (detail: string) => string;
    readonly deleted: string;
    readonly connectionLost: string;
    readonly queueOutOfDate: (detail: string) => string;
    readonly draftStashed: string;
    readonly unknownCommand: (name: string) => string;
    readonly noActiveSession: string;
    readonly stillLoading: string;
    readonly sendInFlight: string;
    readonly creatingSession: string;
    readonly queuedParked: string;
    readonly queuedCancelled: string;
    readonly alreadyDelivered: string;
    readonly exitHint: (key: string) => string;
    readonly unresolvedReference: (where: string, detail: string) => string;
    readonly sessionCreatedModelUnconfirmed: (
      sessionID: string,
      model: string,
      detail: string,
    ) => string;
    readonly sessionCreatedPromptNotSent: (sessionID: string) => string;
    readonly unreachable: string;
    readonly originalServerGone: string;
    readonly originalServerGoneSession: (sessionID: string) => string;
    readonly deliveryUncertain: (sessionID: string) => string;
    readonly promptNotSent: (sessionID: string) => string;
    readonly localFailure: (effect: string, detail: string) => string;
  };
  readonly delivery: {
    readonly cancelled: string;
    readonly cancelFailed: (detail: string) => string;
    readonly steerUsage: string;
    readonly unknown: string;
  };
  readonly pairing: {
    readonly unavailable: string;
    readonly pairing: (label: string) => string;
    readonly paired: (label: string) => string;
    readonly unknownServer: (label: string) => string;
    readonly invalidArgs: string;
    readonly credentialsRejected: string;
    readonly credentialsRequired: string;
  };
  readonly servers: {
    readonly managementUnavailable: string;
    readonly renameUsage: string;
    readonly renamed: (from: string, to: string) => string;
    readonly renameFailed: (detail: string) => string;
    readonly unpairUsage: string;
    readonly unpairedCredentialFailed: (label: string, detail: string) => string;
    readonly unpaired: (label: string) => string;
    readonly unpairFailed: (detail: string) => string;
    readonly cannotUnpairLaunch: string;
    readonly restoreAllFailed: (detail: string) => string;
  };
  readonly agent: {
    readonly noneSelectable: string;
    readonly pending: string;
    readonly unconfirmed: string;
    readonly notSelectable: (id: string) => string;
    readonly switched: (id: string) => string;
    readonly failed: (detail: string) => string;
    readonly unavailable: (id: string) => string;
  };
  readonly model: {
    readonly noSelection: string;
    readonly variants: (variants: string) => string;
    readonly noVariant: (name: string, available: string) => string;
    readonly variantUnavailable: (name: string, model: string) => string;
    readonly pinUsage: string;
    readonly newSessionsUse: (model: string, source: string) => string;
    readonly noPin: (scope: string) => string;
    readonly clearedPin: (scope: string) => string;
    readonly pinUnconfirmed: string;
    readonly noConfirmedModel: string;
    readonly pinned: (model: string, scope: string) => string;
    readonly pending: string;
    readonly unconfirmed: string;
    readonly confirming: (model: string) => string;
    readonly failed: (detail: string) => string;
    readonly confirmed: (model: string) => string;
    readonly noRecent: string;
    readonly nothingPinned: string;
    readonly unavailable: (model: string, scope: string, where: string) => string;
    readonly goalResumeFailed: (detail: string) => string;
    readonly refreshFailed: (detail: string) => string;
  };
  readonly export: {
    readonly noSession: string;
    readonly saved: (count: number, path: string) => string;
    readonly failed: (detail: string) => string;
    readonly remotePathRefused: (target: string, shape: string, clientCwd: string) => string;
  };
  readonly compaction: {
    readonly usage: string;
    readonly pending: string;
    readonly unconfirmed: (detail: string) => string;
    readonly requestedRefreshFailed: (detail: string) => string;
    readonly requested: string;
    readonly requestedFor: (sessionID: string, serverID: string) => string;
  };
  readonly forms: {
    readonly answeredElsewhere: string;
    readonly permissionsRefreshFailed: (detail: string) => string;
    readonly formsRefreshFailed: (detail: string) => string;
    readonly noSessionChanges: string;
    readonly noTurnWholeSession: string;
    readonly openOnlyHttp: string;
    readonly openedBrowser: string;
    readonly browserFailed: (detail: string) => string;
    readonly completedInBrowser: string;
    readonly childOwnerFailed: (detail: string) => string;
  };
  readonly inspector: {
    readonly nothingToInspect: string;
    readonly noTextToCopy: string;
    readonly noTextToSave: string;
    readonly saved: (path: string, label: string) => string;
    readonly saveFailed: (detail: string) => string;
  };
  readonly copy: {
    readonly usage: string;
    readonly btwDesktopOnly: string;
  };
  readonly background: {
    readonly nothingRunning: string;
    readonly failed: (detail: string) => string;
    readonly interrupted: string;
    readonly nothingWasRunning: string;
  };
  readonly rewind: {
    readonly waitForRun: string;
    readonly noEarlierPrompt: string;
    readonly stagedElsewhere: string;
    readonly resolvedElsewhere: string;
    readonly nothingToRevert: string;
    readonly returnToConfirm: string;
    readonly unavailable: (detail: string) => string;
    readonly failed: (detail: string) => string;
    readonly unverified: (state: string, detail: string) => string;
    readonly changed: string;
    readonly reverted: string;
    readonly revertCancelled: string;
  };
  readonly goals: {
    readonly unreadable: (detail: string) => string;
    readonly openSessionFirst: string;
    readonly notSaved: (detail: string) => string;
    readonly conflict: (rounds: number) => string;
    readonly adoptHint: string;
    readonly noListInReply: string;
    readonly noAgentMessage: string;
    readonly merged: (notice: string) => string;
  };
  readonly rename: {
    readonly usage: string;
    readonly renamed: (title: string) => string;
    readonly failed: (detail: string) => string;
    readonly forkFailed: (detail: string) => string;
    readonly forked: string;
    readonly forkedGoalFailed: (detail: string) => string;
  };
  readonly generic: {
    readonly failed: (detail: string) => string;
    readonly unavailable: (detail: string) => string;
    readonly operationFailed: (label: string, detail: string) => string;
  };
}
