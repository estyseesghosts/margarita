Current `master` is `213e7313`. I rechecked the earlier P0–P2 findings against that tree; all remain applicable. I’d work them roughly in this order.

## P0 — startup

### 1. `[P0][Performance][Startup] Measure the complete cold-start path, not only controller bootstrap`

**Problem:** current timing starts inside `AppController.bootstrap()`, after config/profile loading, service discovery, state loading, production assembly, credential restoration, and other work. The user-visible delay can therefore be much larger than `readyInMs`. [`main.ts:235-335`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/main.ts#L235-L335) [`controller.ts:1250-1272`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/app/controller.ts#L1250-L1272)

**Deliverables**
- Add monotonic timestamps for process/`execute()` entry, config load, profile load, connection discovery, state load, assembly completion, renderer creation, Solid mount, first visible frame, first usable session page, catalog-ready, and composer-ready-to-send.
- Distinguish **time to first frame**, **time to usable overview**, and **time to fully ready**.
- Benchmark cold and warm launches, local and remote launch hosts, and 0/1/5/20 paired servers.
- Record Windows separately because its credential path is different.
- Add machine-readable output to the existing performance tooling.

**Avoidables**
- Do not call an empty loading frame “ready.”
- Do not instrument with synchronous file/console writes on every frame.
- Do not log credentials, transcript content, or sensitive URLs.
- Do not use a live model response as part of the benchmark.

**Regression traps**
- `--print` remains TUI-free.
- `--resume`, `--continue`, `--remote`, `--server`, startup failure, Ctrl+C and SIGTERM all retain existing behavior.
- A deliberately injected delay must appear in the correct timing stage.

---

### 2. `[P0][Performance][Startup] Move paired-server credential restoration off the first-frame critical path`

**Problem:** `createProductionAssembly()` serially restores every saved server and awaits `credentials.get()` for each. On Windows, each lookup can spawn PowerShell to perform DPAPI decryption. This all happens before the renderer exists. [`production-assembly.ts:148-182`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/app/production-assembly.ts#L148-L182) [`credentials.ts:68-112`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/config/credentials.ts#L68-L112)

**Deliverables**
- Split launch-host assembly from restoration of unrelated saved servers.
- Register enough saved-server metadata to show them in the overview without decrypting credentials first.
- Restore authenticated paired servers after the interactive shell mounts.
- Use bounded concurrency for independent credential reads/restores instead of the current serial loop.
- Preserve truthful intermediate states such as `connecting`/`unauthorized`.
- Measure Windows PowerShell startup/decryption cost explicitly.
- Consider native/batched DPAPI later, but do not make that a prerequisite for removing it from startup.

**Avoidables**
- Do not weaken credential storage.
- Do not store plaintext secrets in config/state/profile files.
- Do not use unbounded `Promise.all()` for an arbitrary number of servers.
- Do not delay the launch host behind unrelated remotes.

**Regression traps**
- `auth: none` profiles still restore without touching the credential store.
- Duplicate launch/profile URLs remain deduplicated.
- Missing/locked/unavailable credentials remain truthful.
- Unpairing while restore is in flight cannot resurrect the removed server.
- Deferred restore must create at most one event stream per server.

---

### 3. `[P0][Performance][Startup] Move pending credential-cleanup recovery out of synchronous production assembly`

**Problem:** `createProductionAssembly()` also awaits `reconcileCredentialCleanup()` before returning. That routine obtains a file lock and may perform credential deletion for multiple stale server IDs. It is maintenance work, not a prerequisite for drawing the UI. [`production-assembly.ts:364-382`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/app/production-assembly.ts#L364-L382) [`unpair-recovery.ts:91-126`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/config/unpair-recovery.ts#L91-L126)

**Deliverables**
- Start cleanup only after the interactive shell is mounted.
- Keep cleanup bounded and independent from launch-host readiness.
- Surface malformed queue/keyring failures through the existing notice/debug path.
- Preserve the durable retry queue until deletion actually succeeds.
- Add a startup fixture with multiple queued credential deletions and a deliberately slow/unavailable credential backend.

**Avoidables**
- Do not discard or overwrite a malformed recovery queue.
- Do not claim cleanup succeeded when credential deletion failed.
- Do not make cleanup fire repeatedly during the same process lifetime.

**Regression traps**
- A queue entry remains after failed deletion.
- Successful cleanup removes only successfully handled entries.
- Exit during cleanup releases file locks.
- Concurrent unpair and recovery must not corrupt the queue.

---

### 4. `[P0][Performance][Startup] Publish session-index pages progressively instead of waiting for five sequential pages`

**Problem:** `SessionFetcher.loadServer()` can issue up to five sequential `listSessions()` requests before returning anything, then performs `activeSessionIDs()`. `bootstrap()` waits for `loadSessions(this.serverID)`. [`session-fetch.ts:44-76`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/app/session-fetch.ts#L44-L76) [`controller.ts:1250-1264`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/app/controller.ts#L1250-L1264)

**Deliverables**
- Fetch page 1 and publish it immediately.
- Preserve the continuation cursor and load subsequent pages incrementally.
- Make “page 1 available” sufficient for an interactive overview; distinguish it from “index complete.”
- Continue background pagination with cancellation/generation checks.
- Keep page count/concurrency bounded.
- Make `activeSessionIDs()` independent enough that a slow activity endpoint does not withhold already-fetched session rows.
- Benchmark 50/500/2,500-session indexes with latency injected per page.

**Avoidables**
- Do not fetch the entire server history eagerly.
- Do not mark the index complete after page 1.
- Do not let late page results overwrite a newer refresh.
- Do not allow background pagination to starve transcript RPCs.

**Regression traps**
- Duplicate sessions across page boundaries.
- Session deletion/creation during pagination.
- Refresh while older pagination remains in flight.
- Cursor exhaustion vs failed cursor lookup.
- Unpair/server replacement during page reads.
- Overview selection must remain stable as later pages arrive.

---

### 5. `[P0][Performance][Startup] Remove active-session request hydration from the session-index completion barrier`

**Problem:** after session rows are committed, `loadSessions()` collects every active session and awaits `refreshInputRequests()` for all of them. The attached session is also refreshed. A collection of running/background agents can therefore extend launch readiness even though the overview is already usable. [`controller.ts:1727-1747`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/app/controller.ts#L1727-L1747)

**Deliverables**
- Make session-index completion independent from permissions/forms/inbox hydration.
- Prioritize the attached conversation.
- Refresh other active sessions asynchronously with bounded concurrency.
- Preserve “needs input” accuracy as results arrive progressively.
- Deduplicate refresh requests generated by startup plus SSE events.
- Expose request-hydration state separately if the UI needs to distinguish unknown from empty.

**Avoidables**
- Do not represent “not loaded yet” as “no requests.”
- Do not fire one unlimited batch across hundreds of active sessions.
- Do not duplicate permission/form RPCs for the attached session.
- Do not remove the existing ancestry/ownership correctness checks.

**Regression traps**
- Child-session questions still reach the parent/location UI.
- Needs-input counts update after deferred hydration.
- Requests arriving during the initial refresh are not lost.
- Switching sessions while hydration is running cannot attach results to the wrong session.
- Failed hydration leaves previous confirmed request state intact.

---

## P1 — measurement for long sessions

### 6. `[P1][Performance][Long Sessions] Add a persistent soak benchmark for latency growth, GC and memory`

**Problem:** the pure benchmark reaches 10k messages, but `bench:render` mounts only 1,000 short messages and performs a small number of tail updates. It does not answer the important question: *does event-to-frame latency increase after hours of one session continuously growing?* [`bench.ts:200-330`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/scripts/bench.ts#L200-L330) [`bench-render.ts:25-180`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/scripts/bench-render.ts#L25-L180)

**Deliverables**
- Keep one controller + mounted renderer alive for thousands of events rather than rebuilding per fixture.
- Test at least 1k, 10k and 50k loaded messages.
- Report event→commit→render p50/p95/p99 in successive windows, not only one aggregate.
- Record heap, RSS and GC pause over time.
- Include large responses, large diffs, many tools, tool-status streaming, pagination during streaming, expansion/collapse and session switching.
- Add a 100-event burst case.
- Track the projector's `messagesFolded`, `messagesReprocessed`, `prefixNodesReused` and related counters.
- Add a controlled latency stage to validate measurements.

**Avoidables**
- Do not base conclusions on three samples.
- Do not restart the app between each measured update.
- Do not use private real transcripts.
- Do not impose hard machine-specific millisecond thresholds in CI.

**Regression traps**
- Correct rendered output must be asserted alongside timing.
- Fixture growth must not accidentally replace the whole history when testing an append.
- Compare baseline/candidate on the same Bun/OpenTUI versions and dimensions.
- Ensure benchmark instrumentation itself is disabled in production.

---

## P1 — long-session hot paths

### 7. `[P1][Performance][Transcript] Make execution-marker derivation incremental by completed segment`

**Problem:** every transcript projection currently calls `executionMarkers(messages, ...)`, which scans every loaded message and all assistant parts from the beginning. The incremental transcript projector therefore starts behind an O(total-history) pass. [`transcript-view.tsx:132-146`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/ui/transcript-view.tsx#L132-L146) [`execution-segment.ts:68-138`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/domain/execution-segment.ts#L68-L138)

**Deliverables**
- Maintain segment boundaries/indexes alongside canonical transcript state.
- Treat closed `idle`-terminated segments as reusable immutable derivations.
- Recompute only the current/open segment for ordinary streaming changes.
- Invalidate the affected suffix for canonical replacement, older-page prepend, reorder or deletion.
- Preserve marker IDs, activity, compaction status, durations and interruption outcomes.
- Expose instrumentation for number of messages/segments rescanned per event.
- Keep a pure full `executionMarkers()` implementation as a correctness reference if useful.

**Avoidables**
- Do not assume all server updates are append-only.
- Do not infer execution state from UI nodes.
- Do not cache solely by transcript length or newest ID.

**Regression traps**
- Steering while the same execution remains active.
- Compaction running/completed/failed transitions.
- Active tool → finished tool → reasoning transitions.
- Interrupted/failed executions.
- Older history prepend.
- Replacement of a message inside the recent server page.
- Same session IDs on different hosts.

---

### 8. `[P1][Performance][Transcript] Bound incremental projector bookkeeping; stop scanning/copying the unchanged prefix`

**Problem:** `createTranscriptProjector()` avoids expensive re-folding, but each projection still scans the common prefix, scans backward for segment boundaries, copies reusable `baseLists`, and rebuilds `nextFinal` with a copied prefix. Tail-update CPU/allocation therefore still scales with loaded history. [`transcript.ts:537-684`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/domain/transcript.ts#L537-L684)

**Deliverables**
- Give the projector an explicit changed-range/reconciliation boundary instead of rediscovering it from element identity every update.
- Represent stable history in segment/chunk structures that can be reused without copying thousands of array references.
- Keep finalized execution segments reusable as units.
- Restrict `Bun.deepEquals()` fallback to the latest-page region rather than allowing it to become an accidental long-history path.
- Preserve stable node identity for unchanged mounted rows.
- Add allocation counters or equivalent evidence, not only wall-clock time.
- Demonstrate bounded tail-update work between 1k and 50k loaded histories.

**Avoidables**
- Do not regress to a full fold.
- Do not key a cache by serialized whole-transcript JSON.
- Do not lose canonical replacement semantics.
- Do not introduce a complicated rope/chunk layer unless it demonstrably reduces the existing copies.

**Regression traps**
- Recent page sends fresh DTO object identities for unchanged messages.
- Open-turn marker changes without content changes.
- New `idle` closes the previous open segment.
- Tool groups split/merge at the changed boundary.
- Global detailed-mode changes remain allowed to cause a broad rebuild.
- Pagination prepend preserves scroll anchors.

This should coordinate with existing [#319](https://github.com/estyseesghosts/margarita/issues/319).

---

### 9. `[P1][Performance][Transcript] Make latest-page reconciliation proportional to the page, not total loaded history`

**Problem:** each canonical latest-page refresh calls `mergeLatest()`, which constructs a page-ID set, searches the cached transcript for the page boundary and may filter/copy the entire cached history. [`controller.ts:2968-2996`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/app/controller.ts#L2968-L2996) [`controller.ts:9357-9372`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/app/controller.ts#L9357-L9372)

**Deliverables**
- Maintain enough per-transcript indexing to locate recent page boundaries without an O(N) `findIndex`/filter.
- Reconcile a 120-message latest page by touching the recent tail plus required overlap only.
- Preserve server authority for replacements/deletions inside the page.
- Maintain a stable prefix/chunk identity that the projector can reuse directly.
- Make older-page prepend similarly avoid repeatedly rebuilding giant ID sets where feasible.
- Measure reconciliation allocations and latency at 1k/10k/50k history.

**Avoidables**
- Do not turn reconciliation into append-only union.
- Do not use timestamps as unique message identity.
- Do not keep an unbounded second full copy of every transcript just for indexing.
- Do not break paging cursor semantics.

**Regression traps**
- First latest-page message not present in cache.
- Duplicate IDs in malformed payloads.
- Same timestamps, reordered messages and deleted recent messages.
- Pagination and latest-page refresh racing.
- Old response arriving after a newer generation.
- Session eviction/reopen.

This fits naturally under the repository/coordinator work in [#309](https://github.com/estyseesghosts/margarita/issues/309).

---

### 10. `[P1][Performance][Memory] Maintain transcript retained-byte totals incrementally instead of recounting the transcript`

**Problem:** every accepted transcript touch runs eviction planning. `approximateTranscriptBytes()` caches individual message sizes, but a newly created transcript array causes it to iterate over all messages again to sum them. [`controller.ts:3151-3165`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/app/controller.ts#L3151-L3165) [`memory.ts:120-147`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/perf/memory.ts#L120-L147)

**Deliverables**
- Store approximate retained totals alongside transcript cache metadata.
- Update the total by page/replacement delta when latest messages are reconciled.
- Update it by prepend delta during older-page loading.
- Recompute from scratch only for explicit repair/debug verification.
- Keep eviction policy deterministic: current count bound, byte budget, protected active/in-flight entries.
- Add tests comparing incremental accounting to full `approximateTranscriptBytes()` across randomized updates.

**Avoidables**
- Do not make memory accounting itself reactive UI state.
- Do not measure JSON stringification on every update.
- Do not evict the active transcript merely to satisfy the nominal byte budget.
- Do not claim approximate bytes equal actual JS/native retained memory.

**Regression traps**
- Same message replaced by a much larger/smaller payload.
- Latest-page deletion.
- Older-page duplicate suppression.
- Transcript eviction and reopen.
- Active/in-flight entries temporarily exceeding budget.
- Two server-qualified sessions with the same session ID.

Coordinate this with [#309](https://github.com/estyseesghosts/margarita/issues/309).

---

### 11. `[P1][Performance][Transcript UI] Remove the controller's second full transcript-fold path`

**Problem:** the UI already owns an incremental projector, but controller presentation helpers independently call `foldTranscript()` across the entire loaded conversation. `collapsibleItems()`, tool lookup, focus navigation, child-tool lookup and `ensureTranscriptNodeVisible()` can therefore trigger expensive full folds during interaction. [`controller.ts:7955-8125`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/app/controller.ts#L7955-L8125)

**Deliverables**
- Establish one authoritative derived projection/index per attached transcript.
- Expose lightweight indexes/selectors for:
  - collapsible items in order;
  - node key → index;
  - tool ID → tool/node;
  - group → member tools;
  - focused child-bearing tool.
- Make keyboard navigation/focus use those indexes rather than calling `foldTranscript()`.
- Keep worker rows integrated without forcing canonical transcript re-folding.
- Explicitly define ownership: domain/projector produces projection; controller consumes read-only indexes; UI renders it.
- Benchmark Ctrl+Up/Down, Enter expansion and focus reveal at 10k/50k messages.

**Avoidables**
- Do not create a second independently invalidated derived cache.
- Do not move UI render objects into controller state.
- Do not make focus movement mutate canonical transcript state.
- Do not sacrifice server-qualified IDs.

**Regression traps**
- Compact vs detailed mode.
- Expanded groups, individual tools and oversized diffs.
- Focused item outside the current render window.
- Streaming while focus remains on an old tool.
- Worker rows appearing/disappearing.
- Pagination prepend must not change semantic focus identity.

This overlaps [#319](https://github.com/estyseesghosts/margarita/issues/319) and should be designed with it rather than creating another projector abstraction.

---

### 12. `[P1][Performance][Rendering] Budget transcript rendering by physical cost, not only node count`

**Problem:** the render window is currently `200` transcript nodes. A node is not a useful upper bound on layout cost: one text node, diff or expanded tool can occupy hundreds or thousands of terminal rows. [`transcript.ts:1210-1221`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/domain/transcript.ts#L1210-L1221) [`transcript-view.tsx:125-180`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/ui/transcript-view.tsx#L125-L180)

**Deliverables**
- Introduce a presentation budget that reflects expected physical layout cost: rows/cells/text budget rather than only node count.
- Keep the newest live turn visible.
- Treat expanded large diff/tool rows as materially more expensive than a one-line status node.
- Preserve semantic “earlier messages” behavior and existing history reveal controls.
- Recalculate appropriately on terminal resize.
- Expose enough metrics in the render benchmark to see mounted node count and estimated/mounted physical rows.
- Define behavior for a *single* node larger than the normal budget rather than looping or hiding it entirely.

**Avoidables**
- Do not discard canonical messages.
- Do not silently truncate source text solely to satisfy the render window.
- Do not make normal scrolling constantly mount/unmount individual physical lines.
- Do not base the budget on UTF-16 character count alone.

**Regression traps**
- Huge single assistant reply.
- Huge diff.
- Detailed mode.
- Expanded tool with many children.
- Narrow terminals causing heavy wrapping.
- Resize while scrolled in history.
- Sticky prompt, focus reveal and pagination anchors.

---

### 13. `[P1][Performance][Memory] Separate large canonical payload retention from hot reactive/render state`

**Problem:** tool output has an explicit 64k frontend cap, but assistant text and reasoning are stored directly in canonical message objects, and diff metadata is retained directly as a string. Very large responses/diffs can therefore dominate the active transcript even though most are not visible. [`wire-mapping.ts:180-270`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/adapter/wire-mapping.ts#L180-L270) [`wire-mapping.ts:420-500`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/adapter/wire-mapping.ts#L420-L500) [`wire-mapping.ts:520-540`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/adapter/wire-mapping.ts#L520-L540)

**Deliverables**
- Profile large assistant text, reasoning and diff retention separately before choosing thresholds.
- Separate the **hot presentation representation** from large source payloads where profitable.
- Lazily derive expensive previews/formatting only for visible or explicitly inspected content.
- Preserve the ability to copy/export/inspect the full available server content.
- Reuse stable source references rather than keeping multiple full prettified/split copies.
- Add fixtures for 1 MB prose, large reasoning, multi-megabyte diff metadata and repeated large outputs.
- Verify memory reclamation after leaving/deleting/evicting a session.

**Avoidables**
- Do not simply truncate assistant responses or diffs and lose data.
- Do not claim a frontend-truncated preview is the full result.
- Do not duplicate the same megabyte-scale string into raw, formatted and rendered forms.
- Do not store large data in a global permanent cache.

**Regression traps**
- `/copy last`, `/copy`, inspector and `/export` must still return the intended source.
- Server-truncated vs frontend-previewed data remains distinguishable.
- Unicode and very long lines remain exact.
- Session cache eviction releases cold payload references.
- Streaming a growing response must not create quadratic string retention.

---

## P2 — cache invalidation

### 14. `[P2][Performance][Transcript] Make expansion changes invalidate only affected transcript nodes`

**Problem:** `foldOptionSignature()` incorporates the complete sorted sets of expanded groups and diffs. Any group/diff disclosure change alters the signature, which clears `messageCache`, `mergeCache`, `baseLists`, `previousMessages`, `finalNodes` and offsets inside the projector. Opening one old diff can therefore throw away incremental reuse for the whole conversation. [`transcript.ts:455-477`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/domain/transcript.ts#L455-L477) [`transcript.ts:537-555`](https://github.com/estyseesghosts/margarita/blob/213e7313cd67fff68e6d2b3daf06ec14dc80a4fc/src/domain/transcript.ts#L537-L555)

**Deliverables**
- Separate genuinely global fold options from local disclosure state.
- Keep `detailed`/other truly global semantics as broad invalidators if required.
- Associate tool/group/diff expansion state with only the affected message/group.
- Recompute neighboring groups only where disclosure changes grouping/layout semantics.
- Preserve stable node identities outside the affected region.
- Add projector stats/tests proving expansion of one tool in a 10k-message transcript does not refold 10k messages.

**Avoidables**
- Do not bolt on a second expansion cache with independent ownership.
- Do not ignore expansion state when determining node content.
- Do not optimize by moving mutable UI state into canonical message objects.
- Do not break deterministic projection.

**Regression traps**
- Expand/collapse old and newest groups.
- Standalone tools vs grouped tools.
- Oversized diff expansion.
- Detailed-mode toggle after local expansions.
- Pagination prepending history containing already-qualified expansion keys.
- Route/session switch with colliding tool IDs.
- Expansion while the same tool is streaming.

This belongs with the cache-invalidation work already contemplated by [#319](https://github.com/estyseesghosts/margarita/issues/319).

### Order I would actually implement

`#1 → #2/#3 → #4 → #5 → #6 → #7/#9/#10 → #8 → #11 → #14 → #12/#13`.

The important architectural boundary is that **#7–#11 should converge on one transcript repository/projection pipeline**, not produce five independent caches. Existing [#309](https://github.com/estyseesghosts/margarita/issues/309) and [#319](https://github.com/estyseesghosts/margarita/issues/319) are the natural umbrellas for that work; [#316](https://github.com/estyseesghosts/margarita/issues/316) matters where explicit reactive ownership/invalidation is required.