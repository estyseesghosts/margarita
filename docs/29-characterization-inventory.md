# Characterization inventory and race harness (#306)

This document is the behavioral baseline for the controller decomposition in
`adr/0007-state-ownership-map.md`. It records which behavior is currently
protected by tests, which fixtures exist to control concurrency, and the gaps
that must be closed **before or during** each extraction. It does not change
product behavior.

## Current verification baseline

Captured at `4d9c6af` plus the #305/#307/#306 documentation and tooling work:

| Command | Result |
| --- | --- |
| `bun run verify` | 1374 pass, 40 skip, 0 fail (1414 tests across 118 files); includes format, Oxlint, strict typecheck, `check:architecture`, and tests |
| `bun run bench -- --smoke` | opt-in synthetic projection/network benchmark; not a native FPS measurement |
| `bun run bench:render` | opt-in renderable-reuse benchmark |
| `sh scripts/test-pty-smoke.sh`, `sh scripts/test-tmux.sh` | Linux executable smoke, run in CI, needs a compiled binary |
| `MARGARITA_LIVE=1 bun test` | opt-in compatibility against a disposable v2 service; never a user's real service |

The test suite declares roughly 1,378 explicit test cases; most are grouped in
`src/app/controller.test.ts` (about 270) and `src/ui/app.test.tsx` (about 115).
Those two files are the coupling the extraction must unravel: behavior is
protected, but the fixtures are tied to one concrete class.

## Behavior → current suite → future owner

| Behavior | Current protection | Future owner / suite (from ADR 0007) | Gap before extraction |
| --- | --- | --- | --- |
| Bootstrap, catalogs, session index, pagination | `controller.test.ts`, `production-assembly.test.ts`, `production-composition.test.ts`, `cli/*`, `src/app/refresh-generations.test.ts` (5), `src/app/session-fetch.test.ts` (4), `src/app/session-snapshot.test.ts` (9) | `HostSessionIndex` → `session-index.test.ts`; generations, paged reads/reconciliation and pure snapshot commit now in `src/app/{refresh-generations,session-fetch,session-snapshot}.ts` (#308); failed-read completeness and re-pair page teardown covered by #327 | No independent suite for event admission; paged/failing `listSessions` hooks exist in `FakeBackend` but are used ad hoc |
| Events, resync, reconnect, multi-host collisions | `multi-server-events.test.ts` (25), `multi-server-aggregation.test.ts`, `adapter/event-pump.test.ts`, `async-route-ownership.test.ts`, `test/multi-server.test.ts`, `src/app/route-server.test.ts` (2), `src/app/event-admission.test.ts` (8), `src/app/host-session-index.test.ts` (8) | `EventAdmission` → `src/app/event-admission.ts` with explicit inputs and ordered commands; `HostSessionIndex` → `src/app/host-session-index.ts` owns per-host stream status and the shared health-emission rule; route-host rules in `src/app/route-server.ts` (#308) | Event batches are built inline; no shared fixture for reorder/duplicate/missing events |
| Transcripts, retry, pagination, cache | `merge-latest.test.ts`, `transcript-projector.test.ts`, `domain/transcript.test.ts` (81), `perf/memory.test.ts`, `tool-classification.test.ts` (6), `src/app/transcript-eviction.test.ts` (9), `src/app/transcript-retry.test.ts` (4), `src/app/transcript-generations.test.ts` (3), `src/app/transcript-flight.test.ts` (6), `src/app/transcript-freshness.test.ts` (9) | `TranscriptRepository` → `transcript-repository.test.ts`; tool identity in `src/domain/tool-classification.ts` (#319), eviction, retry, generations, single-flight and stale/fresh decisions in `src/app/transcript-{eviction,retry,generations,flight,freshness}.ts` (#309); count-cap protection and flight identity/retirement covered by #331/#333 | Failure-plus-queued-hint cases live in `controller.test.ts`; benchmark conditions must be recorded before moving them |
| Summaries, worker/shell job status | `execution-segment.test.ts`, `worker.test.ts`, `shell-job.test.ts`, `controller.test.ts`, `src/app/refresh-generations.test.ts` (5) | `JobStatusCoordinator`; worker/shell job epochs now in `RefreshGenerations` (#316/#308) | Stale-after-failure assertions are scattered; no single capability fixture |
| Permissions and forms, descendant verification | `form-routing.test.ts` (28), `domain/form.test.ts` (24), `multi-server-events.test.ts`, `test/manual-pairing.test.ts`, `src/app/descendant-scope.test.ts` (3), `src/app/request-targets.test.ts` (5), `src/app/request-inbox.test.ts` (8), `src/app/ancestry-verifier.test.ts` (11), `src/app/request-inbox-coordinator.test.ts` (9) | `RequestInbox` → `src/app/request-inbox.ts` owns the pure visibility rules, `src/app/ancestry-verifier.ts` owns bounded ancestry verification and `src/app/request-inbox-coordinator.ts` owns refresh revisions and both publication batches; scope and event routing remain in `src/app/{descendant-scope,request-targets}.ts` (#310); timeout retirement/retry covered by #332 | Unknown-child/sibling-isolation cases need the shared collision fixture; controller-level ancestry timeouts still use real waits in some tests |
| Composer, drafts, paste, editor, completion, history | `domain/composer.test.ts` (30), `clipboard.test.ts`, `external-editor.test.ts`, `project-files.test.ts`, `ui/app.test.tsx`, `src/app/draft-registry.test.ts` (3), `src/app/edit-history.test.ts` (5) | `RouteScopedComposer` → `composer-service.test.ts`; route identity in `src/app/draft-registry.ts` and undo/redo in `src/app/edit-history.ts` (#311) | Draft revision/external-editor cases split across UI and controller suites; no single route-switch fixture |
| Submission admission and session creation | `async-audit-regressions.test.ts` (14), `cli/print.test.ts`, `test/writable/prompt-flow.test.ts`, `test/writable/session-control.test.ts`, `src/app/admission-gate.test.ts` (3), `src/app/submission-admission.test.ts` (10) | `SubmissionCoordinator` → `src/app/submission-admission.ts` now delivers the pure `preparing → admitted/failed/unknown` decision (`admissionBlock`, `classifySendError`, `resolveAdmission`, `composerClearance`); single-flight lock in `src/app/admission-gate.ts` (#312) | A reusable gated `prompt` fixture would let the unknown-write and duplicate-submit cases be shared instead of built inline |
| Models and agents | `model-selection.test.ts` (21), `domain/model-resolution.test.ts`, `domain/model-sort.test.ts`, `agent-catalog.test.ts`, `src/app/model-pins.test.ts` (4) | `ModelSelectionCoordinator` → `model-selection-service.test.ts`; model scopes and pin intent already in `src/app/model-pins.ts` (#313) | Confirmation-before-billable-send assertions mixed into controller tests |
| Goals, plans, tasks | `domain/goal-plan.test.ts` (17), `domain/native-goal.test.ts`, `controller.test.ts`, `src/app/goal-revision-guard.test.ts` (3) | `GoalPlanCoordinator` → `goal-coordinator.test.ts`; monotone UI revision guard already in `src/app/goal-revision-guard.ts` (#314) | No shared fixture for overlapping reads/saves or cross-host goal collisions |
| Inspection, diff, rewind, revert | `domain/inspector.test.ts`, `diff.test.ts`, `rewind.test.ts`, `edit-diff.test.ts`, `async-audit-regressions.test.ts`, `src/app/inspector-document.test.ts` (3) | `InspectionService` + `RevertCommand` → `inspection.test.ts`; memoized document already in `src/app/inspector-document.ts` (#315) | Negative "no backend mutation on preview" assertions are localized, not systematic |
| Persistence | `config/*` suites, `test/linux/persistence.test.ts` (12), `scripts/test-low-disk.sh`, `src/app/persistence-coordinator.test.ts` (4) | **`Extracted (#317)`** `src/app/persistence-coordinator.ts`; controller delegates `flushLocalState()` and patches | Save-chain conflict cases still partly in controller/production-assembly tests |
| Reactive coordination / UI | `ui/app.test.tsx` (115), `production-assembly.test.ts`, `test/perf.test.tsx`, `src/app/usage-selector.test.ts` (3), `src/app/revision-cache.test.ts` (4), `src/app/overview-projection.test.ts` (5), `src/app/controller.test.ts` (#316 parity) | explicit selectors + view-models (#316/#318); usage memo in `src/app/usage-selector.ts`, the shared memo primitive in `src/app/revision-cache.ts`, the overview cache owner in `src/app/overview-projection.ts`, and explicit `setStateTouchingOverview` at the 32 invalidating writes | Mounted-renderer tests remain the main coverage; UI view-model boundaries (#318) are still to narrow |

## Reusable fixture layer

`test/characterization/harness.ts` adds a small, deterministic layer on top of
`test/fake-backend.ts` (which already records `calls` and exposes hooks such as
`listSessionsHook`, `createSessionHook`, `listAgentsHook`, `promptError`):

- `deferred()` — a promise released explicitly by the test, so a slow response
  can resolve after a newer one; no real sleeps.
- `settle(rounds)` — bounded zero-delay turns that drain queued microtasks.
- `fakeClock()` — injectable `now()` plus explicit `advance()`; passed to the
  controller as `deps.now`.
- `createHarness()` — bootstraps an `AppController` with colliding sessions on
  several hosts, a fail-closed `backendFor` resolver, short retry delays, and a
  `serverIDs()` list the test can mutate to simulate unpair.
- `marks()` / `callsSince()` / `assertNoCalls()` — per-host call-log slicing so
  a test can assert **which backend was called, which host owns the result, and
  what was not mutated**.
- `emit()` — sends typed `BackendEvent` batches with an explicit `resync` flag.

`test/characterization/controller-characterization.test.ts` proves the harness
on five cases: deferred ordering, per-host call slicing, same-ID collision
isolation, duplicate-Enter admission, and a route change during a gated prompt.

## Regression traps: coverage status

| Trap from #306 | Status | Evidence |
| --- | --- | --- |
| Identical session IDs on two servers | Covered | `test/production-composition.test.ts`, `test/production-assembly.test.ts`, new characterization test |
| Stream reconnect without resurrecting removed sessions | Covered | `multi-server-events.test.ts`, `async-audit-regressions.test.ts` |
| Late catalog/summary/transcript replies | Covered | `model-selection.test.ts`, `async-audit-regressions.test.ts`, `controller.test.ts` |
| Lost event hints on a failed refresh | Covered | `controller.test.ts` (#295 cases) |
| Host switch during prompt / no duplicate submit | Covered | `async-audit-regressions.test.ts`, new characterization tests |
| Full draft + attachment recovery | Covered | `controller.test.ts`, `external-editor.test.ts`, writable prompt-flow |
| Unknown-child forms and sibling isolation | Covered | `form-routing.test.ts`, `multi-server-events.test.ts` |
| Model/agent confirmation before billable submission | Covered | `async-audit-regressions.test.ts`, `model-selection.test.ts` |
| Persistence conflicts and safe shutdown | Covered | `test/linux/persistence.test.ts`, `scripts/test-low-disk.sh` |
| Both UI routes and modal lifetime / Ctrl+C / Esc | Covered | `ui/app.test.tsx`, `key-router.test.ts`, PTY smoke scripts |
| Raw inspector/diff disclosure and large transcript reuse | Covered | domain suites, `perf/memory.test.ts`, `bench:render` |
| Native frame rendering and interactive PTY matrix | **Boundary** | CI smoke + opt-in manual matrix; not claimed as full verification |

"Covered" means a behavioral assertion exists today, not that it is isolated in
a capability suite. The extraction sequence in ADR 0007 relocates each set of
assertions with its owner.

## Rules for extraction PRs

- Move tests by behavior with their fixtures; never delete a red test or weaken
  an assertion to make a refactor pass.
- Keep at least one end-to-end `createProductionAssembly()` path green in every
  stage, so transport, wiring and routing stay exercised.
- Prefer `deferred()` + `settle()` over `Bun.sleep` for ordering; inject `now`
  instead of waiting for wall-clock timers.
- Assert exact calls on the **owning** backend and explicitly assert forbidden
  calls on the other hosts (`assertNoCalls`).
- Track moved/added/removed tests in the PR description; `bun run verify` plus
  the architecture gate must stay green.
