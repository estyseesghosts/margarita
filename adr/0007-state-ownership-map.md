# ADR 0007: State ownership map and incremental controller decomposition

- **Status:** Proposed (migration contract, not a code change)
- **Date:** 2026-11-22
- **Audit baseline:** `4d9c6af`; line references below use the current checkout,
  which contains only documentation and tooling changes since that revision.
- **Drivers:** issue #305 (this map), #306 (characterization harness), #307
  (enforcement), and the architecture findings in `docs/marg-audit.md`.
- **Guides:** all of `style-guides/README.md` and
  `style-guides/typescript-javascript-style-guide.md` (local paths and mirror are
  recorded in `AGENTS.md`).

## Context

`src/app/controller.ts` is a ~9,080-line `AppController` with roughly seventy
mutable private fields (declarations at `src/app/controller.ts:484-664`) and
hundreds of methods. The problem is not its length. The fields in that one
class have unrelated lifetimes and writers:

- server-authoritative facts (session index, transcripts, forms, jobs) arrive
  asynchronously from several hosts and need generations, server-qualified keys
  and stale-response rejection;
- frontend-persisted facts (history, model pins, goal plans, drafts) come from
  `config/local-state.ts` and `config/goal-store.ts` and are merged with disk;
- ephemeral UI facts (route, overlay, focus, caret, scroll window, notice timer)
  change on every keystroke and must not invalidate network caches;
- reactive coordination is split between a Solid store setter wrapper
  (`src/app/controller.ts:680-685`) and an explicit overview revision signal
  (`src/app/controller.ts:560-566`), with several hand-maintained cache
  structures at `src/app/controller.ts:558-590`.

Consequently, changing one capability currently means reasoning about unrelated
network, persistence and rendering lifecycles. The audit's completion criterion
is changeability, not a smaller `controller.ts`: a developer should be able to
change one feature without understanding unrelated state owners.

Existing strengths must be preserved: the typed `Backend` port, domain modules
that do not import Solid or transport, per-session generations, incremental
transcript projection, bounded caches, explicit benchmarks, and roughly 1,282
passing tests.

## Decision

1. **One writer per state family.** Every mutable field listed below gets one
   owning service. A service owns its caches, timers, generations and in-flight
   work, and exposes named operations plus read-only views. No capability writes
   another capability's state directly.
2. **A small `AppController` facade remains** throughout the migration. It
   composes the capability services, keeps existing call sites working, and is
   gradually reduced to forwarding plus UI-only state. Compatibility delegation
   is removed only when its last caller moves; no "big bang" replacement.
3. **Dependency direction is `ui → app/use-cases → domain`**, with `adapter/`
   as the only wire translator and `config/` as the only persistence transport
   for ordinary local JSON. Domain stays free of `app/`, `ui/`, Solid, OpenTUI,
   `@opencode/client` and Node I/O. This is enforced by the gate added in #307
   (`scripts/check-architecture.ts`) and documented in
   `docs/28-style-and-architecture-enforcement.md`.
4. **Server-qualified identity everywhere.** A bare session ID is never a key
   for state shared across hosts; generations/epochs accompany every read whose
   reply can arrive after teardown, unpair or replacement.
5. **Invalidation is explicit.** Derived caches name the signal/revision that
   invalidates them and the operation that bumps it. The overloaded setter
   wrapper may be removed only after behavioral parity is proved (#316).
6. **Extraction is staged and independently reviewable.** Each stage has its own
   tests, passes `bun run verify`, and shrinks (never grows) the architecture
   cycle baseline. Size reduction is a consequence, never an acceptance target.

## Ownership map

Format for each capability: current owner and authoritative source; mutable
fields and long-lived work; readers/writers; intended owner and public contract;
tests to move or keep. Line ranges are from the current controller unless noted.

### Audit findings: multiple writers and gaps

These are concrete source observations, not hypotheses:

- **One invalidation signal, two writers.** `overviewRevision` is declared at
  `src/app/controller.ts:566`, bumped by the overloaded store setter wrapper at
  line 700 and again by `onStreamStatus()` at line 2001, and read by the overview
  getters at lines 1007, 1038 and 1068. A new update path can silently omit a
  bump; owner: reactive coordination (#316).
- **Draft fields have many writers.** `state.drafts`, `draftAttachments` and
  `stashes` are written from navigation (3425-3426), paste (3776, 3788), external
  editor (4055), stash/restore (4337, 4349, 6814) and submission recovery
  (5059-5060); owner: route-scoped composer (#311).
- **Verification cache has split teardown.** `verifiedDescendants` is written at
  2709, cleared for one session at 1740 and for a whole host at 5597-5598;
  owner: request inbox (#310).
- **One pre-existing domain import cycle** (`execution-segment.ts`,
  `transcript.ts`, `worker.ts`) is recorded in `scripts/architecture-baseline.json`.
  The gate forbids new cycles; the #319 domain split should remove this one.
- **No dedicated owner yet** for the combined store setter wrapper and the
  overview/usage caches at 560-586; they are assigned to #316 below.

### 1. Bootstrap, host index, sessions and pagination (#308)

- **Current owner:** `AppController` — `bootstrap()` at 1124,
  `loadCatalog()`/`innerLoadCatalog()` at 1176-1275, `loadSessions()` at 1411,
  `loadMoreSessions()` at 1763, `refreshSummary()` at 2261,
  `streamStatusOf()` at 798.
- **Authoritative source:** per-server `session.list` + `session.get` snapshots
  and live events; health from the owning `Backend`/connection manager.
- **Readers / writers:** overview groups/rows, conversation footer and CLI target resolution read it; bootstrap, loadSessions, onEvents and resync write it.
- **Mutable state:** `streamByServer` (525), `summaryReadSeq` / `summaryAdmitted`
  (516-517), `summaryTimers` (521), `transcriptOrder` (522), `serverPages` in
  `AppState`. Host/session/resync epochs and event/usage stamps are now owned by
  `src/app/refresh-generations.ts` (first #308 slice).
- **Async/teardown:** per-host refresh epochs (`RefreshGenerations`), host-qualified
  keys, timers in `summaryTimers`; `forgetServer()` and
  `clearRuntimeStateForServer()` are the current teardown points. Paged reads and
  definite-not-found reconciliation lives in `src/app/session-fetch.ts`
  (second #308 slice), and the pure merge/page/flag rules for committing a verified
  snapshot are in `src/app/session-snapshot.ts` (third #308 slice) with eight
  focused tests. Event admission routing is now pure in `src/app/event-admission.ts`
  (fourth #308 slice); the facade only executes the returned commands.
- **Intended owner:** `HostSessionIndex` with contract
  `initialize(hosts)`, `refresh(host)`, `loadMore(host)`, `applyEvent(host, event)`,
  `resync(host)`, `status(host)`, `forget(host)`, `dispose()`; it updates an
  immutable snapshot and emits a named invalidation, but never selects navigation.
- **Tests:** `src/app/controller.test.ts`, `src/app/multi-server-events.test.ts`,
  `src/app/multi-server-aggregation.test.ts`, `test/production-assembly.test.ts`.

### 2. Event admission and reconnection (#308)

- **Current owner:** `onStreamStatus()` at 1993, `onEvents()` at 2019,
  `resync()` at 2088, `applyEvent()` at 2149, `markStale()` at 2241.
- **Authoritative source:** the owning server's event stream and its snapshot;
  a disconnect is not a confirmed empty result.
- **Readers / writers:** the transcript/job hint consumers and overview read events; the event pump writes them through onEvents and onStreamStatus.
- **Mutable state:** per-host stream status is now owned by `HostSessionIndex`
  in `src/app/host-session-index.ts` (fifth #308 slice, eight tests); transcript
  dirty hints (`transcriptDirty` at 499), job hints (`jobRefreshes` /
  `jobRefreshDirty` at 588-589, `transcriptJobsDirty` at 591) and the generations
  above remain in the controller.
- **Async/teardown:** one stream per host, generations and per-key epochs; event
  batches must be admitted atomically and drained independently of failed reads.
  The duplicated route-host and attached-session rules in `resync`/`applyEvent`
  are pure in `src/app/route-server.ts` (two tests), and the full event→command
  dispatcher is delivered as `src/app/event-admission.ts`: `admitEvent(context)`
  takes an explicit `EventAdmissionContext` (event, attached session, route-host
  match, session lookup, lazy request targets) and returns an ordered
  `EventCommand[]`. The facade's `applyEvent` now only builds the context and
  runs `executeEventCommand` per effect — no routing decisions remain in the
  controller.
  Stream status transitions are decided by `HostSessionIndex.transition()`: a
  host's status is keyed independently with the launch badge as fallback (#109),
  and the returned effects are split at the reactive batch boundary so remote
  hosts never touch the badge. The two duplicated per-host health emissions in
  the full and paged index reads now share `healthCommands()`, which drops
  unregistered and stale results before reporting.
- **Owner:** `admitEvent` in `src/app/event-admission.ts` and `HostSessionIndex`
  in `src/app/host-session-index.ts`; typed inputs in, ordered named commands
  out. Still to extract: `resync`/reconnect orchestration, per-host page state
  and the rest of `HostSessionIndex` (the index currently owns stream status only).
- **Tests:** `src/app/event-admission.test.ts` (8),
  `src/app/host-session-index.test.ts` (8), `src/adapter/event-pump.test.ts`,
  multi-server event suites, `src/app/async-audit-regressions.test.ts`.

### 3. Transcript refresh, pagination and cache lifetime (#309)

- **Current owner:** `scheduleTranscript()` at 2929, `handleTranscriptFailure()`
  at 2984, `fetchLatest()` at 3030, `loadOlder()` at 3099,
  `touchTranscript()`/`inFlightTranscriptKeys()` at 3240-3288.
- **Authoritative source:** `session.messages` pages for a server-qualified
  session; live events are hints, never authoritative page content.
- **Readers / writers:** transcript-view rows, the raw-output inspector and usage analytics read it; live hints, fetchLatest and loadOlder write it.
- **Mutable state:** `transcriptInFlight` (498), `transcriptDirty` (499),
  `transcriptRetryTimers` (501), `transcriptRetryAttempts` (502),
  `transcriptReadSeq` / `transcriptCommitted` (509-510), `transcriptOrder` (522),
  plus `AppState.transcripts` and `transcriptWindow`. The LRU/byte-budget eviction
  decision is now a pure planner in `src/app/transcript-eviction.ts` (first #309
  slice, five tests). The retryability rule, exponential backoff and per-session
  attempt counters live in `src/app/transcript-retry.ts` (second #309 slice,
  four tests), and read generations/commit watermarks in
  `src/app/transcript-generations.ts` (third #309 slice, three tests), and the
  single-flight/dirty-hint coalescer in `src/app/transcript-flight.ts` (fourth
  #309 slice, four tests). The resync stale/fresh rule and the failure
  classification rule are now pure in `src/app/transcript-freshness.ts` (fifth
  #309 slice, nine tests): `planResyncStaleFlags` keeps only an attached session
  that committed a newer page fresh, and `classifyTranscriptFailure` orders
  stale marking, independent job hints, retry reset and bounded retry scheduling.
  Timers, notices and store writes still stay in the controller.
- **Async/teardown:** single-flight reads, bounded retries, failure backoff,
  active/in-flight sessions exempt from eviction; timers cleared in `dispose()`
  at 712.
- **Intended owner:** `TranscriptRepository/Coordinator` with
  `open`, `refresh`, `applyHint`, `loadOlder`, `invalidate`, `forgetHost`,
  `dispose`, returning immutable read-only views.
- **Tests:** `src/app/transcript-freshness.test.ts` (9),
  `src/app/transcript-eviction.test.ts` (5), `src/app/transcript-retry.test.ts` (4),
  `src/app/transcript-generations.test.ts` (3), `src/app/transcript-flight.test.ts` (4),
  `src/app/controller.test.ts`, `src/app/merge-latest.test.ts`,
  `src/domain/transcript-projector.test.ts`, `scripts/bench.ts` scenarios
  `projectorTailUpdate`, `livePageReconcile`.

### 4. Summaries, worker and shell job status (#308/#309)

- **Current owner:** `refreshSummary()` at 2261, `refreshWorkers()` at 2810,
  `refreshShellJobs()` at 2838, `scheduleJobRefresh()` at 2882,
  `scheduleJobStartProbe()` at 2908.
- **Authoritative source:** server `session.get`, worker/shell job lists; a
  failed refresh keeps confirmed rows and marks them stale (#230).
- **Readers / writers:** footer, conversation nodes and throbber read it; session.get, job-list refreshes and SSE events write it.
- **Mutable state:** `summaryTimers` (521), `usageEvidence` (520),
  `jobRefreshes` (588), `jobStartProbes` (590), `workerStatus` / `shellStatus`.
- **Async/teardown:** per-key epochs at 2781-2808; one delayed probe after a
  tool call; timers owned and cleared by `dispose()`.
- **Intended owner:** the session index owns summary freshness; a small
  `JobStatusCoordinator` owns worker/shell polling and their timers.
- **Tests:** `src/domain/execution-segment.test.ts`, `src/domain/worker.test.ts`,
  `src/app/controller.test.ts`, `test/live-multi-server.test.ts`.

### 5. Permissions and form requests (#310)

- **Current owner:** `refreshInputRequests()` at 2343 (through 2764),
  `verifyUnknownDescendants()` at 2558, `walkAncestry()` at 2724,
  `answerPermission()` at 7087 and `finishForm()` at 7434.
- **Authoritative source:** per-location `permission.list` and `form.list` plus
  verified parent links; a failed endpoint is never confirmed-empty.
- **Readers / writers:** permission/form cards and overlays read it; refreshInputRequests, answerPermission and finishForm write it.
- **Mutable state:** `formToken` (543) and `answeringForms` (544) stay in the
  controller (they belong to the reply/overlay slice). The monotonic refresh
  revision and per-key revision map are now owned by `RequestInboxCoordinator`
  in `src/app/request-inbox-coordinator.ts` (third impure #310 slice, nine
  tests), with `AppState.permissions/forms/requestErrors` written only through
  its commands. Verified child→ancestor evidence and in-flight ancestry walks
  are owned by `AncestryVerifier` in `src/app/ancestry-verifier.ts` (second
  impure #310 slice, nine tests), which exposes a read-only evidence view to the
  pure scope rule.
- **Async/teardown:** bounded ancestry verification, independent endpoint
  freshness, per-key revision cancellation on session removal or unpair. The
  attached-session/sibling scope rule and input-request event routing are pure
  in `src/app/descendant-scope.ts` and `src/app/request-targets.ts`. The first
  `RequestInbox` slice is now `src/app/request-inbox.ts` (eight tests):
  `unknownLocationChildren` selects child owners needing ancestry checks,
  `mergeLocationForms` decides which forms survive into the displayed bucket
  (global sentinel, attached session, verified descendants, no new sibling,
  confirmed-row retention during in-flight verification), and
  `shouldResetPermissionFocus` preserves deliberate focus only for an unchanged,
  successfully listed request on the same route. `AncestryVerifier` owns the
  bounded child-owner checks: lifetime-matched evidence caching, in-flight walk
  deduplication, cycle and depth caps, stale-result rejection, a global deadline
  and per-child timeouts — all through explicit injected ports (backend lookup,
  local index, session epochs, clock, timeout), so stalls and cycles are testable
  without real waits. `RequestInboxCoordinator` owns the refresh revisions and
  both publication phases: it groups the three independent endpoint reads,
  rejects stale/late responses, assembles partial errors, and yields an
  authoritative command batch before the ancestry await and a second batch
  afterward. The facade drains the generator and executes each batch in its own
  Solid transaction (#294); no read, merge or freshness decision remains in the
  controller.
- **Intended owner:** `RequestInbox` — now the pure visibility rules,
  `AncestryVerifier` and `RequestInboxCoordinator`. Immutable origin envelopes
  (server, owning session, actual form session, form ID, token) and
  `answer`/`cancel` results remain to extract. Overlay focus stays in UI state.
- **Tests:** `src/app/request-inbox-coordinator.test.ts` (9),
  `src/app/ancestry-verifier.test.ts` (9),
  `src/app/request-inbox.test.ts` (8),
  `src/app/descendant-scope.test.ts` (3), `src/app/request-targets.test.ts` (5),
  `src/app/form-routing.test.ts`, `src/app/multi-server-events.test.ts`,
  `src/domain/form.test.ts`, `src/ui/app.test.tsx`.

### 6. Composer, drafts, paste, editor, completion and history (#311)

- **Current owner:** draft/navigation methods at 3307-3550; paste/attachments at
  3562-3903; undo/redo and external editor at 3936-4122; completion at
  4123-4297; history at 4298-4489.
- **Authoritative source:** frontend-owned route/draft state; local project
  scans come from `src/app/project-files.ts`, pure text operations from
  `src/domain/composer.ts`, attachment rules from `src/domain/attachment.ts`.
- **Readers / writers:** composer-view, key-router and pickers read it; keystrokes, paste, editor results, history loads and draft saves write it.
- **Mutable state:** `killBuffer` (548), `fileCache`/`fileScans` (609/619),
  `completionRequest`/`completionGeneration` (620/623), `pasteChain` (640),
  `editorRecoverySeq` (632), `AppState.drafts/draftAttachments/stashes/composer`.
  Route keys/revisions are owned by `src/app/draft-registry.ts` (first #311 slice)
  and bounded route-scoped undo/redo by `src/app/edit-history.ts` (second #311
  slice, five tests).
- **Async/teardown:** paste and editor transactions capture origin before IO;
  serialized pastes reject stale completion scans; file scans never block paint.
- **Intended owner:** `RouteScopedComposer` with route/session identity,
  revision, text/cursor, attachments, undo/redo, completion and history scope,
  producing an immutable submission envelope but never calling the backend.
- **Tests:** `src/domain/composer.test.ts`, `src/domain/attachment.test.ts`,
  `src/app/clipboard.test.ts`, `src/ui/external-editor.test.ts`,
  `src/app/project-files.test.ts`, `src/ui/app.test.tsx`.

### 7. Submission admission and session creation (#312)

- **Current owner:** `submit()` at 4491, `steer()` at 4644, `admit()` at 4649,
  `clearComposer()` at 4710, `createSessionWithPrompt()` at 4901,
  `sendToSession()` at 5253, local/server commands at 5301-5572.
- **Authoritative source:** a successful `session.prompt` acknowledgement;
  model/agent checks from the scoped catalog; local commands are not server RPCs.
- **Readers / writers:** admission UI and CLI read it; submit, steer, createSessionWithPrompt and local command handlers write it.
- **Mutable state:** `pendingCompactions` (490), draft revision and attachment set
  at admission time. The single-flight per-session admission lock is owned by
  `src/app/admission-gate.ts` (first #312 slice). The full
  `preparing → admitted | failed | unknown` decision is now pure in
  `src/app/submission-admission.ts` (second #312 slice, ten tests):
  `admissionBlock` reports the first gate refusal, `classifySendError` separates
  an unknown transport write from a confirmed failure, `resolveAdmission`
  returns the ordered effects, and `composerClearance` preserves newer text
  while removing only sent attachments.
- **Async/teardown:** one server-qualified per-session admission lock; unknown
  write outcome means no automatic retry; route changes during await preserve a
  newer draft; created session ID is retained even when the prompt fails.
- **Owner:** `resolveAdmission` in `src/app/submission-admission.ts`; the facade
  only observes gate/route state and executes the returned commands. Still to
  extract: new-session creation recovery (`createSessionWithPrompt`) and the
  transport adapter itself; no second lock in the composer service and no direct
  backend calls in views.
- **Tests:** `src/app/submission-admission.test.ts` (10),
  `src/app/admission-gate.test.ts` (3), `src/app/controller.test.ts`,
  `src/app/async-audit-regressions.test.ts`, `test/prompt-flow.test.ts`,
  `test/session-control.test.ts`.

### 8. Model and agent catalogs, confirmation and selection (#313)

- **Current owner:** catalog loading at 1172-1343; agent switching at
  5675-5891; model/effort pickers and switching at 5995-6505.
- **Authoritative source:** per-host/per-directory server catalogs, confirmed
  switches, and transcript evidence with watermarks; user pins and defaults from
  local state.
- **Readers / writers:** pickers, footer and the submission gate read it; catalog loads, confirmed switches, transcript evidence and pin edits write it.
- **Mutable state:** `modelSwitches`/`failedModelSwitches`/`modelSwitchRevisions`
  (526-528), `agentSwitches`/`failedAgentSwitches`/`confirmedAgents` (530-539),
  `pinOperations` (634), `AppState.models/agents/pinnedModels/lastModels`. Model
  scopes and per-scope pin intent are now pure in `src/app/model-pins.ts`
  (first #313 slice); switch confirmations still live here.
- **Async/teardown:** one pending switch per server-qualified session; late
  catalog or acknowledgement results obey explicit precedence; no implicit
  fallback to another model or provider.
- **Intended owner:** `ModelSelectionCoordinator` exposing
  `resolveForSubmission`/`canDispatch` to #312; picker query/index/focus stays
  in UI state; pin persistence follows #317.
- **Tests:** `src/domain/model-resolution.test.ts`, `src/domain/model-sort.test.ts`,
  `src/domain/agent-catalog.test.ts`, `src/app/model-selection.test.ts`.

### 9. Goals, plans, tasks and interrupt intent (#314)

- **Current owner:** native goal reads and steer intent at 6909-7061; local plan
  and task operations at 8375-8683.
- **Authoritative source:** server `opencode.goal` state for native goals;
  `config/goal-store.ts` for the frontend-managed plan document.
- **Readers / writers:** tasks overlay, goal UI and footer read it; native-goal refresh, local plan edits and interrupt/steer intent write it.
- **Mutable state:** `goalStore` (641), `goalEditChains` (648),
  `AppState.goals/nativeGoals/awaitingSteer`. The monotone UI revision guard is
  now owned by `src/app/goal-revision-guard.ts` (first #314 slice, three tests).
- **Async/teardown:** serialized per-session edits, revision watermarks,
  explicit accepted/rejected/conflict/unavailable outcomes; steer intent is
  scoped to the originating session and never resumes after route invalidation.
- **Intended owner:** `GoalPlanCoordinator` separating server truth from the
  local document, with versioned read/write contracts and one task UI owner.
- **Tests:** `src/domain/goal-plan.test.ts`, `src/domain/native-goal.test.ts`,
  `src/app/controller.test.ts`.

### 10. Inspection, diff, overlays and destructive revert (#315)

- **Current owner:** permission/form cards at 7062-7480; diff and disclosure at
  7119-7256 and 7481-7771; inspector at 7772-8143; rewind/revert at
  8239-8318 and 8765-8989.
- **Authoritative source:** immutable origin IDs (server, session, message,
  tool, fetch generation) for read-only previews; explicit confirmation for
  revert/rewind mutations.
- **Readers / writers:** diff, inspector and rewind overlays read it; openDiff, loadInspector, refreshRewindPreview and explicit confirmation write it.
- **Mutable state:** `rewindPreviewSeq` (488), `diffRequestSeq` (489),
  `AppState.overlay` plus expansion/page state. The memoized inspector document
  is now owned by `src/app/inspector-document.ts` (first #315 slice, three tests).
- **Async/teardown:** a late preview cannot publish into a reopened overlay;
  revert guards against route change, session replacement, removed host and
  stale preview; exit flush is `flushRevertOnExit()` at 8974.
- **Intended owner:** read-only `InspectionService` (diff, raw tool output,
  indexed search/windowing) and a separate `RevertCommand` with
  inspect/confirm/execute/verify outcomes; overlay focus belongs to the UI.
- **Tests:** `src/domain/inspector.test.ts`, `src/domain/diff.test.ts`,
  `src/domain/rewind.test.ts`, `src/domain/edit-diff.test.ts`,
  `src/app/controller.test.ts`.

### 11. Persistence (#317)

- **Current owner (extracted in #317):** `src/app/persistence-coordinator.ts`
  owns the snapshot, save chain and last error. `AppController.flushLocalState()`
  delegates to it and feature owners call `persistence.patch(...)` through the
  facade; constructor wiring remains at 703-718.
- **Authoritative source:** `config/local-state.ts` with atomic writes,
  cross-process merge and schema versioning; credentials stay in the separate
  OS keyring path and must never enter local JSON.
- **Readers / writers:** startup, model pins, history, drafts and goals read it; feature owners write through persist() and its save chain.
- **Mutable state:** `persisted` (625), `saveChain` (636), `saveError` (637),
  `pinOperations` (634).
- **Async/teardown:** serialized writes, explicit failure reporting while the
  app is open, and a defined flush/cancellation outcome on exit.
- **Owner:** `PersistenceCoordinator` (`state`, `patch`, `flush`); feature owners
  supply typed patches, only this service writes. `dispose` is not needed: the
  coordinator owns no timers or subscriptions.
- **Tests:** `test/linux/persistence.test.ts`, `scripts/test-low-disk.sh`,
  `test/production-assembly.test.ts`, config suites.

### 12. Reactive coordination and view boundaries (#316/#318/#319)

- **Current owner:** `OverviewProjection` and the main UI at `src/ui/app.tsx`,
  `transcript-view.tsx` and `overlays.tsx`. The overloaded setter wrapper and its
  magic `overviewInputs` list are gone (third #316 slice): the controller assigns
  the raw store setter and the 32 writes that can change an overview projection
  explicitly call `setStateTouchingOverview`, which batches the write with
  `invalidate()`. All other writes use the plain setter. The three projection
  caches use the shared `src/app/revision-cache.ts` primitive (four tests); usage
  and greeting memo owners are in `src/app/usage-selector.ts` and
  `src/app/greeting-selector.ts`.
- **Authoritative source:** the owning capability's state; derived views must
  subscribe only to fields that can change them.
- **Readers / writers:** all mounted Solid views read it; AppController store updates, revision signals and UI-local view state write it.
- **Mutable state:** `inspectorCache` and disclosure/window state in
  `src/ui/transcript-view.tsx`. The overview revision clock and the three
  projection caches are now owned by `OverviewProjection` in
  `src/app/overview-projection.ts` (second #316 slice, five tests): it exposes
  `invalidate()` plus `tabCounts()/groups()/overviewRows()` selectors keyed by
  an explicit host-health scope function; the controller still computes the
  projections and batches the invalidation with its store writes. The
  usage-analytics memo and stable greeting selection are owned by
  `src/app/usage-selector.ts` and `src/app/greeting-selector.ts` (first #316/#318
  slices); the controller only supplies evidence and the time period.
  Invalidation is now visible at each call site rather than inferred from setter
  arguments; the remaining work is narrowing UI dependencies to view-models.
- **Async/teardown:** store changes and revision bumps are batched atomically
  (#293); composer keystrokes must not regroup sessions or reformat hidden rows.
- **Intended owner:** named capability write operations plus derived selectors;
  UI receives narrow view-models/action ports, not the whole controller and state.
  Pure folding/preview policy moves to domain modules without losing
  incremental projector reuse (#319).
- **Tests:** `src/app/controller.test.ts` (#288/#293/#316 invalidation parity),
  `src/app/overview-projection.test.ts` (5),
  `src/app/revision-cache.test.ts` (4), `src/ui/app.test.tsx`,
  `test/perf.test.tsx`, `scripts/bench-render.ts`, PTY smoke scripts.

## Allowed dependency graph

```text
ui  ──► app (use cases / facade / view models) ──► domain
                    │                                 ▲
                    ├────────────► adapter (wire) ────┘
                    └────────────► config  (persistence transport)
```

- `domain/` depends only on other domain modules and standard pure utilities.
- `adapter/` converts wire DTOs to domain types and may depend on
  `@opencode/client`; it never imports `app/`, `ui/`, Solid or OpenTUI.
- `config/` owns files, locks and keyring/credential storage; domain modules
  never receive file paths from it.
- `src/main.ts` and `src/app/production-assembly.ts` are composition roots and
  may depend on all layers.
- The architecture gate rejects new forbidden edges and new import cycles; the
  one pre-existing domain cycle is recorded in
  `scripts/architecture-baseline.json` and must shrink over time.

## Facade migration contract

1. Add the capability service with its own tests; inject it into the facade.
2. Forward the existing facade method to it; keep behavior and error text stable.
3. Move the relevant tests to the capability suite without deleting assertions
   or weakening fixtures; keep at least one end-to-end production-assembly path.
4. Remove the moved fields from `AppController` and re-run the gate.
5. Only after all call sites use the capability contract, delete the forwarding
   shim. Track each removal in the PR description.

## Staged order, stop/go and acceptance

1. **Protect behavior first:** #306 characterization/race fixtures and #307
   enforcement (paths + architecture gate) proceed together.
2. **Extract independent owners:** #308 host/session index and events, then
   #309 transcripts, #310 requests, #311 composer, #312 submission, #313
   models/agents, #314 goals, #315 inspection/revert, #317 persistence.
   Each is one reviewable, behavior-preserving PR.
3. **Finish boundaries:** #319 pure transcript policy, #316 reactive
   invalidation, #318 UI view-models — staged with the migrations above, never
   as a simultaneous rewrite.

**Go** only when a stage: passes `bun run verify` (which includes the
architecture gate); preserves or improves test assertions; introduces no new
cycle or forbidden edge; keeps the relevant PTY/Windows/Linux smoke green; and,
for cache/projection work, compares `bun run bench` and `bun run bench:render`
under the same Bun/terminal/commit conditions. **Stop** if a stage needs a
weakened test, a second cache, a generic state framework, a hidden persistence
or wire change, or an "exempt this cycle" edit to the baseline.

### Baseline commands to capture before the first extraction

- `bun run verify` — format, lint, strict types, architecture gate, tests.
- `bun run bench` — scenarios `projectorTailUpdate` and `livePageReconcile`;
  `bun run bench:render` — renderable reuse.
- `sh scripts/test-pty-smoke.sh <binary>` and `sh scripts/test-tmux.sh <binary>`
  on Linux; release smoke on Windows.
- `MARGARITA_LIVE=1 bun test test/live-compat-smoke.test.ts` is opt-in and must
  never target a user's real service.

### Acceptance checklist for each extraction

- [ ] Every moved field has one named owner and one invalidation action.
- [ ] Tests moved by behavior, with assertions and fixtures preserved; at
      least one end-to-end production-assembly path still green.
- [ ] `bun run verify` green; architecture baseline not grown.
- [ ] Timers, subscriptions and in-flight work have a disposal owner.
- [ ] No wire, persisted-format, keymap, navigation or startup change.
- [ ] Benchmarks/PTY compared to the baseline where the stage touches them.

Case matrix that every stage must keep covered:

- identical session/project IDs on two hosts, with no cross-host RPC;
- unpair, delete or reconnect while a read or write is in flight;
- older replies arriving after newer ones, and events arriving out of order;
- rejected transport writes and ambiguous prompt outcomes (no duplicate billable
  prompt);
- route change, paste or editor completion during an awaited operation;
- exit while a save or revert confirmation is pending.

## Consequences

Positive: one obvious owner per feature; local reasoning about state, network,
storage and rendering lifetimes; tests organized by capability; a gate that
prevents new coupling.

Costs: an explicit facade delegation layer for a period; test relocation with
duplicated fixtures in the short term; repeated benchmark comparisons for cache
and projection work. The audit's prohibited approaches remain prohibited: no
wholesale rewrite, mechanical LOC splitting, general-purpose state framework,
one interface per method, weakening tests, or replacing proven optimizations.

## Limitations

This map is a static audit of source and tests, not a runtime profile. It does
not claim a new critical runtime defect, nor does it itself change behavior.
Live compatibility remains opt-in (`MARGARITA_LIVE=1`); Windows interactive PTY
coverage and native frame timing are outside the evidence available here.
