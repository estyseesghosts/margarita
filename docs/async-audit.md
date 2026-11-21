# Async controller audit (#178)

Generated from `src/app/controller.ts` at the commit that introduced this file, then triaged. **Scope of the claim:** every `async` method of `AppController` is listed with its source line, how many `await`s it contains, which backend selection it uses and which mutable route state it reads. Methods marked `safe (pattern)` were classified from those mechanical signals plus reading the origin-capture code; only rows marked `fixed` or with a test reference were verified by an executable regression test. This is an inventory with dispositions, not a proof of absence of races. Rows marked **unreviewed** read mutable route or overlay state and still need a line-by-line origin check; **#178 therefore stays open** until each is either proven safe with a test or filed as its own issue.

Legend: **origin** = value captured before the first `await` (a `SessionRef`/`serverID`); **implicit** = reads of `this.backend`, `activeServerID()`, `currentSession()`, `currentView()`, `state.overlay` or `state.route` in the method body (they may legitimately run before the first `await`).

| Line | Method | awaits | Backend selection | Implicit reads | Status |
| ---: | --- | ---: | --- | --- | --- |
| 470 | `flushLocalState` | 1 | – | – | safe (pattern): no backend selection |
| 798 | `bootstrap` | 1 | – | – | safe (pattern): no backend selection |
| 831 | `loadCatalog` | 1 | – | `activeServerID()` | **unreviewed**: reads route state without an explicit owner |
| 847 | `innerLoadCatalog` | 1 | `backendFor(serverID)` | `currentSession()` | safe (pattern): explicit owner |
| 972 | `ensureCatalog` | 2 | – | `activeServerID()` | **unreviewed**: reads route state without an explicit owner |
| 1066 | `loadSessions` | 4 | – | – | safe (pattern): no backend selection |
| 1225 | `loadServerSessions` | 2 | `backendFor(serverID)` | – | safe (pattern): explicit owner |
| 1260 | `reconcileKnownSessions` | 2 | `backendFor(ref.serverID)` | – | safe (pattern): explicit owner |
| 1340 | `loadMoreSessions` | 4 | `backendFor(serverID)` | – | fixed (#196) · test: async-audit-regressions |
| 1516 | `applyCliOverrides` | 6 | `backendFor(serverID)` | `activeServerID()` | safe (pattern): explicit owner |
| 1637 | `resync` | 3 | – | `state.route` | **unreviewed**: reads route state without an explicit owner |
| 1768 | `refreshSummary` | 1 | `backendFor(serverID)` | `activeServerID()` | safe (pattern): explicit owner |
| 1791 | `refreshInbox` | 1 | `backendFor(serverID)` | `activeServerID()` | safe (pattern): explicit owner |
| 1810 | `refreshInputRequests` | 1 | `backendFor(serverID)` | `activeServerID()`, `state.route` | **unreviewed**: explicit owner, but also reads route/overlay state |
| 1871 | `refreshWorkers` | 1 | `backendFor(serverID)` | `activeServerID()` | safe (pattern): explicit owner |
| 1892 | `refreshShellJobs` | 1 | `backendFor(serverID)` | `activeServerID()` | safe (pattern): explicit owner |
| 1945 | `fetchLatest` | 1 | `backendFor(serverID)` | `activeServerID()` | safe (pattern): explicit owner |
| 1978 | `loadOlder` | 1 | `backendFor(serverID)` | `activeServerID()` | safe (pattern): explicit owner |
| 2059 | `loadConversation` | 1 | – | `activeServerID()` | fixed (#199) · test: async-audit-regressions |
| 2297 | `pasteBytes` | 2 | – | `state.route` | **unreviewed**: reads route state without an explicit owner |
| 2449 | `attachPastedPaths` | 1 | – | – | safe (pattern): no backend selection |
| 2480 | `readLocalAttachment` | 2 | – | – | safe (pattern): no backend selection |
| 2634 | `completeMentions` | 3 | `backendFor(serverID)` | `activeServerID()` | safe (pattern): explicit owner |
| 2933 | `submit` | 12 | `backendFor(origin.serverID)` | `state.route` | **unreviewed**: explicit owner, but also reads route/overlay state |
| 3073 | `steer` | 1 | – | `state.route` | **unreviewed**: reads route state without an explicit owner |
| 3078 | `admit` | 1 | – | `state.route` | **unreviewed**: reads route state without an explicit owner |
| 3177 | `verifiedMentionIDs` | 1 | – | – | safe (pattern): no backend selection |
| 3203 | `promptFiles` | 2 | – | `activeServerID()` | **unreviewed**: reads route state without an explicit owner |
| 3225 | `resolveLocalFiles` | 1 | – | – | safe (pattern): no backend selection |
| 3259 | `resolveRemoteFiles` | 2 | `backendFor(serverID)` | `activeServerID()` | safe (pattern): explicit owner |
| 3330 | `createSessionWithPrompt` | 8 | `backendFor(serverID)`, `backendFor(sessionServerID)` | `state.route` | safe · origin captured, route re-checked (#113) · test: controller.test |
| 3508 | `findLatestSessionIn` | 1 | `backendFor(serverID)` | – | safe (pattern): explicit owner |
| 3585 | `ensureSession` | 2 | `backendFor(active)` | `activeServerID()` | safe (pattern): explicit owner |
| 3626 | `resolveCliSession` | 1 | – | `activeServerID()` | **unreviewed**: reads route state without an explicit owner |
| 3682 | `sendToSession` | 4 | `backendFor(serverID)` | `activeServerID()`, `state.route` | **unreviewed**: explicit owner, but also reads route/overlay state |
| 3730 | `runLocalCommand` | 20 | – | – | safe (pattern): no backend selection |
| 3842 | `pairCommand` | 1 | – | – | safe (pattern): no backend selection |
| 3881 | `serversCommand` | 1 | – | – | safe (pattern): no backend selection |
| 3911 | `unpairCommand` | 1 | – | – | safe (pattern): no backend selection |
| 3942 | `confirmUnpair` | 1 | – | `state.overlay` | **unreviewed**: reads route state without an explicit owner |
| 3968 | `performUnpair` | 1 | – | – | fixed (#195) · test: async-audit-regressions |
| 4066 | `cycleAgent` | 2 | – | `currentSession()` | **unreviewed**: reads route state without an explicit owner |
| 4102 | `setAgent` | 5 | `backendFor(session.serverID)` | `currentSession()` | safe (pattern): explicit owner |
| 4157 | `openAgentPicker` | 2 | – | – | safe (pattern): no backend selection |
| 4194 | `acceptAgentPicker` | 1 | – | `state.overlay` | **unreviewed**: reads route state without an explicit owner |
| 4246 | `acceptCopyPicker` | 1 | – | `state.overlay` | **unreviewed**: reads route state without an explicit owner |
| 4269 | `copyToDestination` | 2 | – | – | safe (pattern): no backend selection |
| 4279 | `openModelPicker` | 1 | – | – | safe (pattern): no backend selection |
| 4315 | `acceptModelPicker` | 1 | – | `state.overlay` | **unreviewed**: reads route state without an explicit owner |
| 4360 | `openEffortPicker` | 1 | – | – | safe (pattern): no backend selection |
| 4379 | `acceptEffortPicker` | 1 | – | `state.overlay` | **unreviewed**: reads route state without an explicit owner |
| 4388 | `setEffortChoice` | 1 | – | – | safe (pattern): no backend selection |
| 4402 | `setModelFromRef` | 2 | – | – | safe (pattern): no backend selection |
| 4412 | `setEffort` | 3 | – | – | safe (pattern): no backend selection |
| 4440 | `ensureCurrentModelCatalog` | 1 | – | `activeServerID()`, `state.route` | **unreviewed**: reads route state without an explicit owner |
| 4452 | `setModel` | 1 | – | `currentSession()` | safe · #116/#191 revision guards · test: model-selection.test |
| 4557 | `modelDefaultCommand` | 1 | – | `activeServerID()`, `currentSession()` | **unreviewed**: reads route state without an explicit owner |
| 4661 | `switchSessionModel` | 4 | `backendFor(session.serverID)` | – | safe · #116 revisions · test: model-selection.test |
| 4705 | `nextRecentModel` | 2 | – | – | safe (pattern): no backend selection |
| 4733 | `interrupt` | 2 | `backendFor(session.serverID)` | `currentSession()` | hardened (explicit owner backend) · test: async-audit-regressions |
| 4753 | `backgroundTools` | 2 | `backendFor(session.serverID)` | `currentSession()`, `state.route` | **unreviewed**: explicit owner, but also reads route/overlay state |
| 4828 | `exportChat` | 3 | `backendFor(session.serverID)` | `currentSession()` | safe (pattern): explicit owner |
| 4933 | `compactCommand` | 2 | `backendFor(session.serverID)` | `currentSession()` | safe (pattern): explicit owner |
| 4999 | `cancelQueued` | 3 | `backendFor(serverID)` | `currentView()`, `state.route` | **unreviewed**: explicit owner, but also reads route/overlay state |
| 5072 | `recallQueuedUp` | 1 | – | `state.route` | **unreviewed**: reads route state without an explicit owner |
| 5090 | `promoteQueued` | 4 | `backendFor(serverID)` | `currentView()` | safe (pattern): explicit owner |
| 5113 | `promoteNextQueued` | 3 | – | `state.route` | **unreviewed**: reads route state without an explicit owner |
| 5148 | `refreshNativeGoal` | 1 | `backendFor(serverID)` | `activeServerID()` | safe (pattern): explicit owner |
| 5245 | `captureInterruptSteerIntent` | 1 | – | `activeServerID()` | **unreviewed**: reads route state without an explicit owner |
| 5266 | `maybeResumeInterruptedGoal` | 3 | `backendFor(serverID)` | `activeServerID()` | safe (pattern): explicit owner |
| 5307 | `answerPermission` | 2 | `backendFor(session.serverID)` | `currentSession()` | safe (pattern): explicit owner |
| 5339 | `openDiff` | 2 | `backendFor(session.serverID)` | `currentSession()` | safe (pattern): explicit owner |
| 5493 | `finishForm` | 2 | `backendFor(origin.serverID)` | `state.overlay` | **unreviewed**: explicit owner, but also reads route/overlay state |
| 5831 | `refreshRewindPreview` | 1 | `backendFor(overlay.serverID)` | `state.overlay` | **unreviewed**: explicit owner, but also reads route/overlay state |
| 5856 | `acceptRewindPicker` | 1 | – | `state.overlay` | **unreviewed**: reads route state without an explicit owner |
| 5933 | `loadGoal` | 1 | – | `activeServerID()` | **unreviewed**: reads route state without an explicit owner |
| 5961 | `changeGoal` | 2 | – | `currentSession()` | **unreviewed**: reads route state without an explicit owner |
| 5997 | `applyGoalChange` | 1 | – | – | safe (pattern): no backend selection |
| 6039 | `planCommand` | 6 | – | – | safe (pattern): no backend selection |
| 6091 | `acceptPlan` | 1 | – | `currentSession()` | **unreviewed**: reads route state without an explicit owner |
| 6100 | `rejectPlan` | 1 | – | `currentSession()` | **unreviewed**: reads route state without an explicit owner |
| 6200 | `renameCurrent` | 1 | `backendFor(session.serverID)` | – | hardened (explicit owner backend, unpair guard) · test: async-audit-regressions |
| 6220 | `forkCurrent` | 2 | `backendFor(serverID)` | `currentSession()` | issue #175 (closed) · captured generation |
| 6328 | `stageRevert` | 1 | – | – | safe (pattern): no backend selection |
| 6345 | `stageRevertAt` | 1 | `backendFor(serverID)` | `state.route` | **unreviewed**: explicit owner, but also reads route/overlay state |
| 6430 | `verifyAndRunRevert` | 3 | `backendFor(overlay.serverID)` | – | fixed (#197) · test: async-audit-regressions |
| 6490 | `flushRevertOnExit` | 1 | `backendFor(overlay.serverID)` | `state.overlay` | **unreviewed**: explicit owner, but also reads route/overlay state |
| 6506 | `track` | 1 | – | – | safe (pattern): no backend selection |

## Findings from this pass

| Finding | Disposition |
| --- | --- |
| #195 unpair left cached UI state when credential cleanup failed | fixed, regression test |
| #196 post-pagination input refresh used unfiltered hosts | fixed, regression test |
| #197 stale revert completions closed or restored another overlay | fixed, regression test |
| #198 stream callbacks from a replaced subscription | fixed, regression test (`server-manager.test.ts`) |
| #199 `loadConversation` omitted the owner for the goal refresh | fixed, regression test |
| `this.backend` is a getter over the *current route's* server | intentional; every post-`await` use in the file goes through `backendFor(owner)`; `interrupt` and `rename` were made explicit as hardening |

## Ownership policy (intentional behaviour)

- Backend calls are bound to the `serverID` captured before the first `await`; `backendFor` fails closed for unknown hosts.
- A late result may update origin-scoped cached state if the host is still registered and the request epoch is current, but never takes focus, closes a different overlay or writes another route's composer.
- Client-local paths and files are never derived from a remote server's directory.

## Race tests

The deterministic harness lives in `src/app/async-audit-regressions.test.ts` (two hosts with the same session IDs, held promises, route switches, host removal). Add new races there rather than creating parallel infrastructure.
