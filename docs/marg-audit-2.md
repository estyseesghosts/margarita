Pinned to current Margarita `master` at **`73bed144`**. I’d execute these in this order.

### 1. Restore a trustworthy green verification baseline

**Why:** several of the repairs below touch transcript/event/render behavior. Right now `verify` stops at formatting, so it is not telling us whether the current tree actually passes lint, typecheck, architecture checks, and tests. The Linux PTY clipboard smoke is also asserting obsolete pre-i18n wording.

**Source:** `package.json:12-20` makes `format:check` the first stage of `verify`; `src/i18n/en_us/throbber.ts:4-68` is currently rejected by `bun fmt --check`. `test/smoke/pty-smoke.py:178-195` hardcodes capitalized clipboard errors despite the new lowercase copy.

**Deliverables**
- Format `src/i18n/en_us/throbber.ts` so `format:check` passes.
- Update PTY clipboard assertions to consume the authoritative i18n strings or otherwise match the current user-facing wording without duplicating a stale copy.
- Run the entire `bun run verify`, not just the previously failing stage.
- Run the executable Linux PTY suite after the normal suite.
- Fix any real failures exposed after formatting stops masking later verification stages.
- Establish this commit as the baseline before performance changes.

**Avoidables**
- Do not change product copy merely to satisfy the PTY test.
- Do not weaken `verify`, remove `format:check`, or skip failing tests.
- Do not make the PTY clipboard check accept arbitrary output; it should still prove that paste failure gives truthful feedback.

**Regression traps**
- Lowercase/i18n wording changes must not silently break smoke tests again.
- Windows and Linux must both reach the actual test suite.
- Keep the standalone executable PTY test separate from unit-renderer tests; it catches terminal integration failures they cannot.

---

### 2. Fix intermittent loss of the newest short assistant response

This is the highest-priority runtime correctness repair.

The previous #167 bug is genuinely fixed at the folding level: `foldAssistant()` now explicitly keeps every non-empty assistant text part, regardless of length (`src/domain/transcript.ts:1066-1191`, especially `1150-1155`). So **do not reopen the old ≤80-character heuristic problem**.

The new suspicious gap is event synchronization. Margarita treats stream events as hints and refetches canonical messages, but `transcriptEvents` does not include **`session.step.streamed`** (`src/domain/backend-event.ts:35-58`). OpenCode v2.3.0, which Margarita pins in `package.json:22-26`, defines `session.step.streamed` as a durable provider response-body boundary between first-token and step-ended. [GitHub](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/session-event.ts?utm_source=chatgpt.com)

There is also a race-sensitive refetch pipeline: events feed `scheduleTranscript()`, which single-flights a read and reduces later events to one dirty follow-up (`src/app/controller.ts:3435-3520`); `fetchLatest()` then canonically reconciles the latest page (`src/app/controller.ts:3582-3669`). This needs an explicit final-output regression harness.

**Deliverables**
- Add `session.step.streamed` to normalized transcript-changing events in `src/domain/backend-event.ts`.
- Add normalization tests proving `session.step.streamed` becomes `transcript-changed`.
- Build a deterministic controller regression where:
  - an assistant message initially exists with empty/incomplete content;
  - an early `text.ended`/stream event starts a canonical read;
  - that read returns before the final text becomes visible;
  - the backend then exposes a short final answer such as `Done.`;
  - `session.step.streamed`, `step.ended`, or another final boundary arrives;
  - Margarita must perform enough reconciliation to display `Done.`.
- Test an event arriving **while the previous transcript fetch is in flight**, exercising `TranscriptFlightTracker` dirty-follow-up behavior rather than only sequential events.
- Test one-word, short single-line, multiline, multiple text-part, text-after-tool, and text-before-tool cases.
- Test both an active run and the final idle/completed state.
- Test reconnect/reopen: the final rendered transcript must match canonical history after reopening.
- Add a real UI-render test in `src/ui/app.test.tsx`, not only a `foldTranscript()` test. The current #167 UI assertion around `src/ui/app.test.tsx:3168-3192` proves earlier short prose survives folding, but it does **not** reproduce this live canonical-refetch race.
- Add diagnostic assertions around `mergeLatestIndexed()` so the test proves the final assistant object actually reached canonical state before blaming rendering.

**Avoidables**
- Do not add a timer that blindly polls until text appears.
- Do not special-case “short” strings. Length is not the cause we should encode.
- Do not optimistically append event payload text into canonical transcript state while bypassing `message.list`; Margarita's current server-authoritative model is correct.
- Do not disable the transcript single-flight/coalescing system to make the bug disappear.
- Do not treat `step.streamed` as terminal execution; it is a transcript freshness boundary.

**Regression traps**
- `mergeLatestIndexed()` must still permit same-ID assistant content replacement; its authoritative latest-page reconciliation lives at `src/app/transcript-store.ts:112-226`.
- An old fetch must not overwrite a newer accepted fetch; preserve the generation watermark in `fetchLatest()` (`src/app/controller.ts:3590-3625`).
- Streaming tool status updates must not explode into one RPC per token.
- Previously visible short assistant text from #167 must remain preserved.
- A duplicate `step.streamed`/`step.ended` burst should coalesce rather than issue redundant reads.

---

### 3. Fix stale worker rows in the presentation cache

This is a source-confirmed correctness bug.

`refreshWorkers()` replaces the authoritative worker array when job state changes (`src/app/controller.ts:3323-3353`). But `presentationFor()` and `presentationIndexFor()` cache worker-derived output using only:

`this.state.workers[key]?.length ?? 0`

at `src/app/controller.ts:8570-8628` and `8642-8682`.

Two workers can remain two workers while one moves from `running` to `completed`, changes description, gains a completion timestamp, or changes sorting position. The cache can return the old worker nodes.

**Deliverables**
- Replace `workers: number` in both presentation cache records with a reliable invalidation value.
- Prefer **worker-array identity** if `refreshWorkers()` always replaces the authoritative array; alternatively use an explicit per-session worker revision.
- Ensure both `presentationViewCache` and `presentationCache` use the same worker freshness rule.
- Add a test:
  - initial job `running`;
  - force `presentationFor()` to populate its cache;
  - backend returns the same job ID as `completed`;
  - worker count stays 1;
  - rendered presentation changes to the completed state.
- Add a same-count replacement test with two workers whose status transition changes `workerNodes()` sort order.
- Test a changed description/title with unchanged count/status too.

**Avoidables**
- Do not hash or `JSON.stringify()` the complete worker array on every render.
- Do not invalidate the entire transcript projector when only worker rows changed.
- Do not use count + first/last ID; interior jobs can change independently.

**Regression traps**
- Worker expansion state still comes from `expanded.groups`.
- Worker rows must retain deterministic sorting from `src/domain/worker.ts:35-61`.
- Failed refreshes must continue retaining stale last-known rows rather than presenting false completion (`src/app/controller.ts:3323-3353`).
- The direct `controller.workerNodes()` tests around `src/app/controller.test.ts:6881-6978` are insufficient on their own; the new regression must exercise the cached presentation path.

---

### 4. Stop background confirmations from flattening the whole transcript

The incremental projector now preserves the stable history as chunks, but background notices punch straight through that optimization.

`Transcript.nodes` calls `folded.toArray()` whenever a background confirmation exists (`src/ui/transcript-view.tsx:143-160`). `attachBackgroundNotices()` then searches the flat node array once per notice and creates another flat array (`src/domain/transcript.ts:1274-1320`).

That turns a tiny tail decoration into O(total loaded nodes) work.

**Deliverables**
- Stop passing a flattened transcript into `attachBackgroundNotices()`.
- Resolve `toolID → owning presentation node` from the existing presentation/tool metadata.
- Represent background confirmations as a small overlay/additional chunk on `TranscriptNodeView`, or add a targeted insertion primitive to the view.
- Keep unaffected chunks/object identities unchanged.
- Add projection stats proving a background confirmation in a 50k-message transcript does not copy the 50k-node prefix.
- Extend `bench:soak` with:
  - long history;
  - active shell/tool;
  - background confirmation;
  - repeated streaming updates.

**Avoidables**
- Do not solve this by lowering the transcript window.
- Do not maintain a second flat transcript permanently.
- Do not search every node for every background notice.
- Do not attach a notice to “the latest tool” if its exact tool ID is outside the loaded/rendered view.

**Regression traps**
- Preserve the exact-tool ownership rule documented in `attachBackgroundNotices()`.
- Multiple confirmations for one tool must keep order.
- A confirmation for a non-visible/nonexistent tool must not migrate to another row.
- Background state disappearing after execution finishes must continue to work.

---

### 5. Make execution-marker lookup incremental all the way into presentation

Marker **derivation** is incremental now, but presentation reconstructs a complete marker map every time it needs a new projection.

`updateExecutionMarkers()` already maintains incremental marker state (`src/app/controller.ts:2274-2303`). But `presentationFor()` does:

`new Map(this.markersFor(...).map(...))`

at `src/app/controller.ts:8595-8600`.

For a long transcript with thousands of completed turns, every tail presentation update walks all markers again.

**Deliverables**
- Extend `markerCache` to retain both:
  - ordered marker list;
  - `afterMessageId → ExecutionMarker` map.
- Have the execution projector update that lookup incrementally alongside the ordered representation.
- Pass the cached lookup directly to `createTranscriptProjector()`.
- Add counters/tests proving a tail update in 10k/50k-message history does not rebuild an N-marker map.
- Keep `markersFor()` available as the ordered public view without forcing another derivation.

**Avoidables**
- Do not create the lookup lazily by rebuilding it during every `presentationFor()`.
- Do not duplicate full marker objects unnecessarily.
- Do not combine presentation markers and canonical message state into one mutable structure.

**Regression traps**
- Marker movement after insertion/deletion must update the lookup correctly.
- Running → completed changes must replace the marker at the same owning boundary.
- Prepending older history must not corrupt existing marker ownership.
- Interruption and compaction semantics from `src/domain/execution-segment.ts:62-183` must remain unchanged.

---

### 6. Remove remaining whole-transcript indexing from scroll/navigation

There are still two places where UI interaction flattens/indexes all presentation nodes.

`nodeIndexFor()` builds:

`new Map(nodes().toArray().map(...))`

in `src/ui/transcript-view.tsx:196-202`.

`presentationIndexFor()` similarly calls `view.toArray()` before `buildPresentationIndex()` (`src/app/controller.ts:8642-8682`).

These are not normal folding costs anymore; they're secondary consumers defeating the chunked representation.

**Deliverables**
- Make the projector/presentation own stable `key → node index` metadata.
- Expose lookup/navigation operations without requiring `TranscriptNodeView.toArray()`.
- Change sticky-prompt resolution to start from the top visible node's index and walk backward through the node view.
- Build tool/group/collapsible indexes incrementally with the projection rather than making a second flat pass.
- Keep the navigation index aligned with the exact `TranscriptNodeView` revision it describes.
- Add 50k-history tests for:
  - PageUp/sticky prompt;
  - Ctrl+Up/Down collapsible navigation;
  - focus reveal;
  - old-page prepend.

**Avoidables**
- Do not make the UI maintain its own duplicate transcript.
- Do not build an N-entry `Map` during scrolling/layout callbacks.
- Do not substitute rendered-window indexes for full-history indexes; focus navigation intentionally reaches nodes outside the current window.

**Regression traps**
- Semantic scroll anchoring during prepend must remain intact.
- Sticky prompt must still find a user message outside the mounted tail.
- Tool/group focus cannot jump after grouping changes.
- Node keys remain session-qualified where required; cross-host collisions must not return another session's node.

---

### 7. Remove the full-history `hasRunningMarker()` scan

This is smaller than the previous tasks, but it belongs with the same derived-state cleanup.

`Transcript` currently computes:

`nodes().some(node => node.kind === 'execution' && node.segment.phase === 'running')`

at `src/ui/transcript-view.tsx:182-184`.

Because the running marker normally lives near the tail, `TranscriptNodeView.some()` can traverse almost the complete loaded history before finding it.

**Deliverables**
- Expose running-segment presence from execution-marker state, where Margarita already knows it.
- Have the UI read an O(1) boolean/current running marker instead of searching presentation nodes.
- Preserve the queued-message placement logic around `src/ui/transcript-view.tsx:466-508`.
- Add a long-history test asserting this query does not traverse historical nodes.

**Avoidables**
- Do not cache a UI-local boolean that can become stale.
- Do not reverse-flatten the view just to search from the tail.
- Do not infer running state solely from `state.running`; queued-preview placement needs to know whether an actual running marker exists in the presentation.

**Regression traps**
- Transcript-not-loaded fallback must still show queued input correctly.
- Execution `started` before canonical assistant content exists must not lose the preview.
- Completed/interrupted markers must immediately cease qualifying.

---

### 8. Bound host-level startup concurrency

Most internal concurrency is now bounded, but initial multi-host session loading is not.

`loadSessions()` runs every registered host through one top-level `Promise.all()` at `src/app/controller.ts:1857-1872`.

With many saved servers, that means session page + activity traffic starts across every host simultaneously.

**Deliverables**
- Run first-page host loads through the existing bounded-concurrency infrastructure.
- Choose a modest explicit host concurrency, probably 4–8.
- Preserve the current property that each host's first successful page publishes immediately.
- Do not make a slow host hold up unrelated hosts.
- Extend `bench:startup` beyond latency-only fake servers: simulate delayed hosts and count peak simultaneous host requests.
- Assert the configured concurrency ceiling directly.

**Avoidables**
- Do not serialize all hosts.
- Do not wait for pagination before admitting the next host.
- Do not put activity lookup back onto the page-1 readiness barrier.
- Do not let one failed host cancel the remaining queue.

**Regression traps**
- Launch-host failure must still propagate correctly to CLI startup.
- Remote host health remains independently reported.
- Removing a server while it is queued/in-flight must not resurrect it.
- Startup milestones must retain their current meaning.

---

### 9. Stop progressive session paging from copying the whole session index per page

Progressive loading fixed first-use latency, but each page still merges through an immutable whole-record copy.

`commitSessionPageRows()` calls `mergeCommittedSessions()` at `src/app/controller.ts:2169-2183`. `mergeCommittedSessions()` ultimately returns:

`{ ...current, ...found, ...merged }`

at `src/app/session-snapshot.ts:35-61`.

So each host/page arrival copies every previously cached session row.

**Deliverables**
- Introduce a page-commit operation that updates only keys present on the incoming page.
- Keep full snapshot reconciliation/deletion semantics separate from incremental page insertion.
- Preserve live usage evidence when replacing a row.
- Consider host-partitioned session state if it materially simplifies page updates and later complete-host reconciliation.
- Benchmark 100, 1k, 5k, and multi-host session indexes and record allocations/GC, not only elapsed time.

**Avoidables**
- Do not mutate session entries in a way Solid cannot observe.
- Do not treat a partial page as proof that an absent existing session was deleted.
- Do not lose the `usageEvidence > usageSeq` protection.
- Do not turn each individual row into a separate expensive overview invalidation.

**Regression traps**
- A session found on page 3 must not disappear when page 1 commits.
- Failed pagination must retain previous successful pages.
- Live usage events that arrive during pagination must win over stale page snapshots.
- Host removal and refresh generations must continue rejecting stale commits.

---

### 10. Turn the repaired paths into permanent long-session regression coverage

Do this after the correctness/performance changes, not before them.

`bench:soak` already covers 1k/10k/50k histories, streaming, large responses, large diffs, many tools, pagination, navigation, memory and GC. What it lacks is explicit coverage of the residual paths above and meaningful growth limits.

**Source:** `scripts/bench-soak.ts`; projector instrumentation in `src/domain/transcript.ts:700-930`; existing 50k projector tests in `src/domain/transcript-projector.test.ts`.

**Deliverables**
- Add scenarios for:
  - missing/late short final assistant reply;
  - background confirmation on 50k history;
  - thousands of execution markers + tail update;
  - sticky prompt/navigation on 50k history;
  - worker status mutation with unchanged worker count;
  - many-host startup;
  - multi-page large session index.
- Record work counters alongside timing: nodes flattened/copied, messages folded, marker entries rebuilt, indexes rebuilt, peak host concurrency.
- Add hard **structural** assertions where possible: e.g. “tail update folds ≤N messages”, “background notice copies zero prefix nodes”.
- Use loose performance budgets only for gross regressions; don't make CI depend on fragile millisecond thresholds.
- Refresh `docs/PERF-TICKETS.md`: it still describes several already-solved P0/P1 problems as outstanding.

**Avoidables**
- Do not gate CI on machine-sensitive p50 differences of a few milliseconds.
- Do not benchmark only pure domain functions; several remaining problems are controller/UI integration paths.
- Do not preserve obsolete tickets after their architecture has already landed.

**Regression traps**
- A benchmark that merely captures the final correct frame can miss large intermediate O(N) work.
- FakeBackend tests should deliberately reproduce response/event ordering races, not always make state immediately authoritative.
- Long-session tests must ensure the complete history is actually loaded before measuring.

The first three tasks are correctness gates. I would not start the optimization work until **CI is green, the missing newest-assistant-message race has a deterministic regression test, and the worker cache is fixed**. After that, Tasks 4–7 are one coherent pass over residual transcript-derived O(history) work, followed by startup/index scaling in Tasks 8–9 and permanent coverage in Task 10.
