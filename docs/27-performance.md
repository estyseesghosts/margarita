# 27 — Performance measurement

The performance harness is **opt-in**. It uses synthetic local fixtures and never contacts
an OpenCode service, a model or a user session.

```sh
bun run bench -- --smoke                  # smallest scenario, suitable for CI smoke
bun run bench                             # representative local run
bun run bench -- --json .bench/latest.json
```

`scripts/bench.ts` emits machine-readable JSON on stdout (and, with `--json`, to a file).
Each scenario records count, min, p50, p95, p99, max and mean wall-clock milliseconds, plus
the process heap/RSS after the scenario. Runs are single-process and warm up once unless
`--smoke` is set. Compare the same machine, Bun version and commit; absolute numbers are not
a promise.

## Scenarios

| Name | Sizes | What it exercises |
| --- | --- | --- |
| `foldTranscript` | 120 / 1,000 / 10,000 messages | Full compact derivation of transcript nodes, including groups/tool rows |
| `projectorTailUpdate` | same | Incremental projection after appending one assistant part; the JSON `detail` reports messages folded/reprocessed and prefix nodes reused |
| `livePageReconcile` | same | Fresh 120-message page objects through `mergeLatest` and the projector; `detail` separates page objects recreated from messages actually folded |
| `wireMapPage` | 40x a recorded tool turn | Real OpenCode 2.3.0 `SessionMessageInfo` DTOs through `toTranscriptMessage` |
| `projectUsage` | same | Footer/`/usage` analytics over loaded history |
| `overviewGroups` | 1 / 50 / 500 sessions | Project grouping, ordering and path identity across two hosts |
| `composerEdit` | 40 / 500 / 5,000 / 50,000 graphemes | End insertion plus one grapheme-left move |
| `composerBackspace` / `composerCaret` | same | One grapheme delete and cached caret paint at end |
| `composerMention` / `composerNoMention` | same | Active `@src` parsing versus ordinary prose with no `@` on the line |

## Recorded baseline (this machine)

One non-smoke run at `d9a7535` (Windows x64, Bun 1.4.4, `@opentui/core` 0.9.2, 30 samples)
produced these p50 values. They are a reproducibility checkpoint, not a CI threshold.

| Loaded messages | Full fold | Projector tail | Fresh-page reconcile |
| --- | --- | --- | --- |
| 120 | 0.222 ms | 0.075 ms | 0.595 ms |
| 1,000 | 0.961 ms | 0.316 ms | 1.214 ms |
| 10,000 | 14.187 ms | 1.405 ms | 2.522 ms |

At 10,000 messages the fresh-page run still reports `messagesFolded: 1`,
`messagesReused: 9,999`, `messagesReprocessed: 4`, `prefixNodesReused: 13,328`, and
`pageObjectsRecreated: 120`. The last number is the honest limit: `mergeLatest` keeps the
older prefix but the fetched page itself is freshly deserialized. Deep-equal reuse in the
projector keeps the *derived* work bounded even though message object identity is not
preserved.

## What is deliberately unavailable

The pinned `@opentui/core` 0.9.2 does not expose stable native frame/cell counters, and the
test renderer cannot report dropped frames. Event-receipt→paint and native layout time need a
compiled PTY/TUI trace; the JSON report labels those metrics as unavailable instead of
inventing values. Use `scripts/test-pty-smoke.sh` and `scripts/test-tmux.sh` for terminal
behaviour, not for numeric performance claims.

## Formatting counters (#286)

`src/perf/format-counts.ts` counts the expensive client-side derivations that the UI owns:
Markdown content revisions handed to the native renderable, diff normalization, diff
clamping and semantic tool previews. It is disabled by default (a no-op) and records no
transcript content. Tests enable it explicitly to prove that an unrelated state update or a
re-sent latest page does not re-run formatting for unchanged rows.

Native Markdown parse/reparse, layout and changed-cell counts are still unavailable for the
same renderer reason above; the counter is a revision boundary, not a claim about native
work.

## Retained transcript memory (#289)

`src/perf/memory.ts` estimates retained bytes from UTF-16 string payloads plus fixed
per-message/part/tool/child/file overhead. The estimate is deterministic and cached per
message and per message array; it is a policy input, not a heap measurement.

The controller keeps at most eight cached transcripts and additionally enforces an
approximate 32 MiB budget over *inactive* transcripts (`ControllerDeps.transcriptCacheBytes`
overrides it in tests). The active route and any in-flight transcript read are never evicted;
the most recently used transcript stays even when it alone exceeds the budget, because
evicting it would only trigger an identical refetch. Eviction deletes canonical messages and
derived data only; reopening the session refetches the latest page, and older pagination is
re-established from that page's cursor. Deleting or unpairing a session still clears every
per-session cache entry.

The JSON `memory` section reports retained estimates for 20/1,000/10,000-message fixtures,
eight 1,000-message sessions, heap/RSS before and after allocation/GC/release, and GC pause
samples. Native OpenTUI retained memory and attached heap-snapshot reports are not exposed by
the pinned renderer; they are listed as unavailable rather than approximated.

## Transcript refresh failures (#295)

`scheduleTranscript()` coalesces one canonical refetch per session. Hints that arrive while a
read is in flight are always drained, including when the read rejects; the previous code only
drained after a successful `try`, so a queued update could be lost until some unrelated event.
A transient (`transport`/`unknown`) failure keeps the last confirmed transcript, marks it
stale, and retries up to three times with 250/500/1000 ms backoff
(`ControllerDeps.transcriptRetryBaseDelayMs` shrinks it in tests). A deleted session, removed
host, `not-found`, or authorization failure clears the queued hints instead of retrying. A job
hint from the failed batch is honored immediately, independently of the transcript retry, and a
successful refresh resets the retry budget and clears staleness.

## Overview invalidation (#288, #293)

The overview cache is keyed by a **reactive** invalidation clock plus the external host
health/label/stream key. The controller wraps the Solid store setter so only `sessions`,
`sessionsComplete`, `openedAt`, `running`, `permissions`, `forms`, `stream`, tab selection and
expansion bump the clock. The store write and clock bump settle in one `batch`, so an observer
notified by the write cannot read a cache entry keyed by the previous revision. Any host's
stream-status transition bumps the clock explicitly, including a remote transition that writes
no store field. Selection, focus, composer typing and notices do not invalidate, so moving over
100 rows or typing keeps the cached projection. A mounted overview regression covers rename,
new-session, running-count and disjoint tab membership without a keypress.

## Startup before indexing (#287)

Interactive mode creates the renderer and paints the shell **before** awaiting
`controller.bootstrap()`. `bootstrap()` sets `state.startup.phase = 'loading'` synchronously,
loads the launch host's catalog and first session page, then marks `ready`, and only then
loads paired remotes. A slow or offline remote therefore cannot delay the local first frame
or the local list; each remote appears when its own `loadSessions()` applies.

`ready` is a functional milestone (launch catalog plus session page loaded), not a painted
spinner. The overview shows "Loading sessions and project catalog…" while loading instead of
a false "No sessions yet". Prompt submission is refused with a visible notice while loading,
except for frontend-local slash commands; print mode never creates a TUI and keeps awaiting
the same bootstrap before producing output.

`--debug-log` records `bootstrap` with the loaded session count and
`readyInMs = readyAt - startedAt`. That is the controller's ready-to-send time. Native
first-paint and event-receipt→paint times remain unavailable without a compiled PTY trace
(see above), so they are not inferred from this number. Destroying the renderer (Ctrl+C or
SIGTERM) during startup disposes streams and returns without resolving a target against a
dead TUI; target-resolution failures after the renderer exists also restore the terminal and
dispose the server manager exactly once.

## Complete cold-start timeline (#345)

`src/perf/startup.ts` records monotonic stages in memory and emits one
`startup-timeline` JSON record at startup completion or failure. It never writes per frame,
never touches display or network I/O, and contains only stage names and millisecond offsets.
The stages cover process entry, `execute()`, config/profile/state loads, connection
discovery, production assembly, renderer creation, Solid mount, first frame, first session
page, catalog readiness, bounded session-index completion, request hydration,
post-mount maintenance and composer readiness.

Three different numbers are reported explicitly instead of using one "ready" claim:

- **time to first frame** — `process-entry -> first-frame` (the early shell may still be
  loading);
- **time to usable overview** — `process-entry -> session-page-ready` plus catalog
  readiness (`composer-ready` consumes both);
- **time to fully ready** — `process-entry -> session-index-complete` and
  `request-hydration-ready`, whichever finishes later.

`controller.state.startup` carries the same milestones (`sessionsReadyAt`,
`catalogReadyAt`, `indexCompleteAt`, `hydrationReadyAt`, `readyAt`) using an injected
monotonic clock. Wall-clock timestamps are never substituted: a backward clock adjustment
must not look like slow startup.

`bun run bench:startup` composes the real assembly, bootstrap and mounted Solid tree over
synthetic profiles and fake backends. It covers 0/1/5/20 paired servers, local and remote
launch hosts, and cold/warm runs. The `credential` dimension compares an in-memory store with
a simulated 120 ms DPAPI read; the simulation is labelled and never touches the user's
keyring. `bun run bench:startup -- --smoke` is suitable for CI smoke, and
`--json out.json` writes the same machine-readable report shown on stdout.

```sh
bun run bench:startup
bun run bench:startup -- --smoke --json .bench/startup.json
```

A synthetic injected delay is verified by `src/perf/startup.test.ts` (stage deltas) and the
benchmark labels missing stages instead of substituting a different stage's duration.

## Deferred paired-host restore (#346)

Interactive startup registers saved paired-host metadata immediately, but does not decrypt
credentials before the shell exists. `ProductionAssembly.restoreSavedServers()` reads the
remaining secrets with **bounded concurrency (4 by default)** after the first native frame.
The launch host is never queued behind unrelated remotes: it is connected and bootstrapped
first, and `bootstrap()` marks the UI ready before remote pages load. Print mode keeps the
strict synchronous path because `--continue`/`--resume` may need the remote index.

- The overview names restoring hosts (`Restoring paired server buildbox…`) without any
  secret, session content or request. An unavailable credential becomes a truthful
  `unauthorized` host instead of a phantom online one.
- `auth: none` profiles never touch the credential store.
- Unpairing while a restore is in flight cannot resurrect the profile: the profile list is
  rechecked after the credential read, and the overview metadata is removed on unpair.
- Each credential read is logged as `credential-read` with `serverID`, frontend platform,
  store kind, duration and `found` — never the secret or blob. This makes the Windows
  PowerShell/DPAPI cost explicit alongside macOS Keychain and Linux Secret Service.
- `startup-timeline` records `post-mount-maintenance`; the benchmark reports it separately
  from `first-frame` and the composer-ready milestone.

## Deferred credential-cleanup recovery (#348)

`reconcileCredentialCleanup()` is part of the same once-per-process post-mount maintenance,
not synchronous production assembly. It runs only after a frame has painted, takes the queue
lock, and keeps every entry whose credential deletion failed (including a locked/unavailable
keyring). A malformed queue is left byte-for-byte intact and surfaced through the existing
debug/notice path. Repeated calls in one process are idempotent. Startup fixtures cover
multiple queued deletions with a delayed/unavailable backend and assert that successful
entries disappear while failed ones remain.

## Progressive session index (#347)

`SessionFetcher.loadPage()` reads and stamps one page. Interactive startup publishes page 1
immediately and starts bounded background pagination (five pages) instead of waiting for up
to five serial responses. The overview is usable after the first page; `sessionsComplete`
stays false while any host retains a cursor, and `sessionsLoading` is reserved for an explicit
"Load more" request. `settleSessionIndex()` exists for tests and benchmarks to await the
background walk without sleeping.

- Continuation cursors are preserved on failure, so "Load more" retries the same page.
- A cursor that never advances fails the page walk instead of looping or claiming
  completeness.
- Deletions are proven only after the full page walk for that host; an omitted row on page 1
  is not a deletion. Reconciliation runs asynchronously and cannot block the overview.
- Every page rechecks the refresh epoch, host registration and backend identity, so a newer
  refresh, unpair or host replacement discards late pages. Duplicate rows across page
  boundaries merge by server-qualified key.
- Activity (`activeSessionIDs`) starts independently of page 1 and never withholds rows; a
  failed activity read leaves running evidence unknown and schedules only an activity retry.
- `scripts/bench.ts` reports a `sessionPagination` section for 50/500/2,500 rows at 5 ms per
  page, separating first-page latency from complete-index latency.

## Request hydration independence (#348)

Session-index completion no longer waits for permission/form hydration. Active sessions are
queued behind a four-worker pool, deduplicated by server-qualified key. A refresh requested
while another read is in flight marks the key dirty and runs exactly one follow-up, so an
event that arrives during startup hydration is not lost and concurrent SSE/startup callers do
not issue duplicate permission/form RPCs. The attached conversation is prioritized through
`loadConversation`; other active sessions hydrate progressively.

`state.requestHydration` (and `controller.requestHydrationOf()`) distinguishes `unknown` and
`loading` from a confirmed empty request list. Failed hydration preserves the last confirmed
permissions/forms and publishes `requestErrors`; it never clears a pending card. The
`request-hydration-ready` startup milestone is recorded only after activity and the bounded
queue are idle.




## Long-session soak benchmark

`bun run bench:soak` keeps one controller and one mounted Solid/OpenTUI tree alive while
thousands of synthetic events arrive, instead of rebuilding a fixture per sample. It covers
1,000 / 10,000 / 50,000 loaded messages (`--sizes` overrides), reports p50/p95/p99 in
successive 60-event windows, and records heap, RSS, external bytes and a forced full-GC pause
after each window. Settlement polling checks the transcript tail, so waiting for an append or
burst does not itself rescan the loaded history. Absolute soak milliseconds include the test
renderer's Solid store/effect machinery; compare window-to-window trends and the projector
counters, not as a production frame budget.

The mixed stream includes appended replies, growing text, tool status transitions, 256 KiB
responses, large diffs, 24-tool turns, a 100-message single-announcement burst, expansion and
collapse of tools/diffs, session switching, and pagination interleaved with live events.
Correctness is checked alongside timing: the final frame must contain a unique appended
marker, the controller must retain exactly the backend's message count, and the mounted
projector must be reusing prefix nodes.

- The 100 ms controlled stage must appear in the same end-to-end clock (no hard timing gate
  otherwise).
- Projector counters are observed through an optional `onProjectionStats` prop. Production
  leaves it unset, so the projector performs no extra work on ordinary paths.
- `gcPauseMs` is the cost of an explicit `Bun.gc(true)` checkpoint, an upper bound rather than
  a natural incremental pause; Bun exposes no GC observer here.
- `--smoke` runs one 400-message stage with 24 events for crash/runaway checks, not as a
  performance gate.

## Incremental execution markers (#349)

Execution markers are now derived by the controller from canonical transcript state, not
recomputed by the view. `markersFor()` returns a read-only list; `updateExecutionMarkers()`
receives an explicit change boundary from the latest-page merge or older-page prepend.

- Closed `idle`-terminated segments are reused unchanged, including marker ids, durations,
  compaction/interruption outcomes and activity.
- A streamed tail update rescans only the open segment; a running-state change rewrites only
  the trailing marker.
- A canonical replacement invalidates the segment containing the change and its suffix.
- A prepend rebuilds only the junction segment(s), reuses later closed segments and re-derives
  the open tail with the current running value.
- `markerStatsOf()` exposes messages scanned, segments rebuilt and segments reused for tests
  and benchmarks. The pure `executionMarkers()` remains the correctness reference.

## Indexed transcript reconciliation (#350)

The controller keeps a per-transcript id index and retained-byte total. The index stores
positions relative to a `baseOffset`, so an older-page prepend adjusts one number instead of
rewriting every id mapping. It never stores a second copy of the messages.

- A latest page is located with an O(1) id lookup. The normal path inspects only the page and
  the messages it replaces; a disjoint/malformed page uses the defensive timestamp fallback.
- Cached page objects are reused when the server payload is deep-equal, so the projector and
  marker derivation see a stable prefix. `Bun.deepEquals` is bounded to the latest page.
- Server authority still governs replacements, reordering and deletions inside the page;
  duplicate ids in a malformed page are suppressed.
- Older-page prepends suppress already-known ids through the index and leave cached mappings
  valid. `transcriptAccountingOf()` exposes the incremental total for diagnostics.
- `bun run bench` reports a `transcriptReconcile` section for a fresh 120-message page against
  1k/10k/50k loaded histories. Alongside latency it records `reconciledMessages`,
  `pageObjectsRecreated`, `pageProportional` and the retained-byte total; the 50k case is the
  evidence that reconciliation cost follows the page rather than the loaded history.

## Incremental retained bytes (#351)

`approximateTranscriptBytes()` remains the full-recount reference. Each accepted latest-page
merge subtracts the replaced messages and adds the page; each prepend adds only the new older
rows. Eviction reads the maintained total instead of rescanning every transcript, and an
explicit repair rebuild is recorded when state was written by another owner. Tests compare the
incremental total against the full recount across randomized replacements, deletions,
prepends, duplicate suppression and 1 MB-scale payload changes.

## Bounded incremental projection (#352)

The projector accepts an explicit `changedFrom` boundary from canonical reconciliation instead
of rediscovering it by scanning every message. A false boundary is rejected by an O(1) identity
check at that position and falls back to the identity scan. Closed execution segments remain
the reuse unit.

- Final nodes are stored as shared chunks behind `TranscriptNodeView`. `at()`, `tail()` and
  `toArray()` make random access and windowing explicit; a tail update shares the stable prefix
  chunks instead of copying thousands of node references.
- Per-message base lists and final-node offsets are truncated/rebuilt in place; only the
  changed suffix is touched.
- `Bun.deepEquals` content fallback is restricted to the latest 120-message region; older
  messages must keep object identity. This prevents an accidental whole-history comparison.
- `ProjectionStats` adds `nodesCopied`, `arraysAllocated` and `changedFrom`. Tests compare
  1,000- and 50,000-message tail updates and assert zero copied prefix nodes and only the new
  turn folded, while the chunked view still matches the full reference for random access,
  iteration and appended worker/warning rows.
- The mounted transcript uses `windowNodeView` so only the visible tail is materialized; the
  scroll-anchor index is built lazily when sticky-prompt logic needs it.

## One authoritative presentation projection (#353)

The controller owns the folded-node projector for each attached transcript. The view renders
`presentationFor()` and the navigation helpers (`collapsibleItems`, `toolGroups`,
`focusedChildTool`, `inspectableTool`, `ensureTranscriptNodeVisible`) read one cached
`PresentationIndex` built from the same projection. There is no second controller-side
`foldTranscript()` path for keyboard interaction.

- The index exposes node-key → position, tool-ID → tool, group → member tools and the ordered
  collapsible rows. Worker rows are appended before the index is built, so worker navigation
  works without a canonical re-fold.
- A projection view cache keys on the message array, detailed mode, expansion signature, MCP
  catalog, changed range, worker count and running state; repeated renders and focus movement
  reuse the same view and projector counters.
- `presentationStatsOf()` exposes the last projection counters for benchmarks. Tests assert
  that collapsible-item and focus-reveal calls do not change those counters.
- `bun run bench:soak` measures Ctrl+Up/Down (`moveGroupFocus`), Enter expansion
  (`toggleFocusedGroup`) and focus reveal (`ensureTranscriptNodeVisible`) on the same live
  controller, including one rendered frame per operation. It reports `focusRefolds` and
  `revealRefolds`, which must stay at zero; the full run exercises 1k/10k/50k histories.
- Ownership stays explicit: the domain projector produces nodes; the controller owns the
  derived read-only index; the UI only attaches transient client-local notices and renders the
  visible window.

## Local disclosure invalidation (#354)

Group and diff expansion are no longer part of the global projector signature. Each assistant
message carries a disclosure key derived from the expanded diffs and groups whose first tool
belongs to it; a cached message is reused only while that key and its marker agree. Detailed
mode and the MCP catalog remain genuinely global invalidators.

`toggleGroup()` and `toggleDiffExpanded()` mark the owning message index through a tool →
message index maintained with the transcript metadata, so the projector rebuilds only that
message and its bounded suffix. A test over 10,000 messages expands one old group and asserts a
single message is folded while more than 9,000 keep their cached nodes.

## Transcript window and paint cost (#355 repair)

`transcriptWindow` has one meaning: how many folded nodes from loaded history may be mounted.
`windowNodeView()` selects the newest node window and its `hidden` count reports only loaded
nodes outside that window; server history availability is tracked separately by `olderCursor`.
There is no tail-relative physical-row slicer: a row cap made already-loaded messages impossible
to reach and was removed. Paint cost is bounded locally instead — `viewportCulling` on the
scrollbox avoids painting offscreen rows, and each expensive item keeps its own cap
(`boundedPreview`, `toolMetadataRowBudget`, diff clamping, shell/reasoning caps and Code Mode
child paging). The soak benchmark reports the same mounted/hidden/total node counts the view
uses, so a benchmark can never redefine scrollback reachability.

## Large source payload retention (#356)

Wire mapping keeps a bounded preview in canonical assistant text/reasoning and tool diffs; the
full source is stored exactly once in a `WeakMap` keyed by the canonical part/tool object.
Deleting or evicting that object releases both the preview and the full source, and there is no
global permanent payload cache or second formatted copy.

- Limits are 16 KiB for assistant text/reasoning and 32 KiB for a tool diff. The preview says
  how many characters are retained and never claims the server truncated the source.
- `retainedPayload()` is used by `/copy`, the copy picker, complete responses, inspector
  fallback and the latest-assistant helper, so full content remains available while display
  folds only the preview.
- `cachedToolResult()` returns the full diff for the inspector; a shallow copy does not inherit
  the retained source, which keeps ownership tied to the canonical object.
- Tests cover 1 MB prose, 1 MB reasoning, a multi-MB diff, Unicode/long-line exactness and the
  shallow-copy boundary. `scripts/bench.ts` reports source/preview sizes for the same fixtures.
- A controller-level GC test loads nine transcripts past the eight-entry cache bound, drops
  the fixture's canonical copy, forces collection and asserts the evicted assistant part (the
  WeakMap key) is gone. That verifies eviction releases the preview and full source together,
  without a permanent payload cache.

## Bounded reading windows under growth (slow.txt)

The transcript no longer mounts "the newest N nodes" by raising N forever. A
`TranscriptViewport` has a fixed capacity (200 folded nodes by default) and either follows the
live tail or slides a same-size window through loaded nodes anchored to a semantic node key.
Ctrl+Home moves that bounded window to the earliest loaded node; Ctrl+End resets it to tail
mode immediately. Streaming while reading history leaves both the visible key sequence and
the mounted node objects unchanged, because the window is anchored to what the reader is
looking at rather than to the tail. Rows render with item identity (`<For>`), and each row
registers its `Renderable` in a view-local map so sticky and anchor lookups stop walking the
whole render tree.

The overview applies the same discipline per project: six collapsed rows, a 24-session window
on Show more, and explicit Older/Newer controls. Expanding a project invalidates only row
presentation; tab counts and grouping are untouched. `loadMoreSessions()` commits one page's
per-key updates instead of copying the session map.

`bun run bench:soak` now reports two additional scenarios:

- **Long scroll** (1k/10k/50k messages): PageUp/PageDown, Ctrl+Home/End, scrolling after deep
  history, and streaming while in history. It records p50/p95, mounted/total node counts,
  semantic-row lookups per scroll, and a bounded sticky update count. Structural checks reject
  a mounted count above capacity, a Ctrl+Home that is not at earliest history, a Ctrl+End that
  does not return to tail, and any streaming that replaces historical rows.
- **Overview** (25/100/500/2,000 sessions in one workdir): initial render, Show more/less,
  keyboard navigation, and a live status change with the group open. It records p50/p95 and
  mounted session rows; the structural bound is six collapsed and at most thirty expanded,
  never the whole workdir.

As with the rest of this document, these numbers are for manual comparison on a pinned machine;
there are no hard millisecond CI thresholds.

## Reproducibility rules

- Use the same commit, machine, terminal size, Bun version and power mode for comparisons.
- Each JSON report pins `gitRevision`, Bun and `@opentui/core` versions, dimensions
  (`80x24`, `40x12`), target FPS (60) and fixture seed. A non-smoke scenario collects 30
  samples (20 for overview grouping), so p95 is meaningful and p99 is indicative rather than
  stable.
- Run the baseline and patch at least three times; compare p50/p95, not a single sample.
- Keep fixtures seeded/synthetic. Do not benchmark against the user's OpenCode service.
- Instrumentation must remain opt-in and cheap when disabled; ordinary `bun run verify` never
  imports the harness.
- Do not turn machine-specific p95 numbers into hard CI thresholds. CI may run `--smoke` to
  catch crashes or runaway work, not as a performance gate.

## Event-to-visible-frame (#301)

`bun run bench:render` mounts the real Solid/OpenTUI tree through `testRender` over a
deterministic controller/backend, loads 1,000 synthetic messages, then measures from a
`transcript-changed` event through canonical refetch, mapping, incremental projection and one
rendered frame. It runs 30 samples at both 80×24 and 40×12 and injects a known 100 ms stage as
a clock control.

One recorded run (Bun 1.4.4, `@opentui/core` 0.9.2, Windows x64):

| Size | p50 | p95 | p99 | 100 ms control |
| --- | --- | --- | --- | --- |
| 80×24 | 76.1 ms | 101.7 ms | 102.7 ms | 109.7 ms |
| 40×12 | 81.1 ms | 99.7 ms | 110.1 ms | 101.2 ms |

This includes `scheduleTranscript`'s intentional 80 ms coalescing window, so it is not
comparable to the pure `projectorTailUpdate` milliseconds above. It is a real component-boundary
measurement (state commit → layout → captured frame), but still not native terminal paint; a
compiled PTY trace remains the only honest source for terminal compositor latency.

`livePageReconcile` deliberately reports `pageObjectsRecreated: 120` and
`pageObjectsReused: 0`: a real page fetch allocates fresh DTO objects even when their content
is unchanged. The projector's deep-equal reuse keeps `messagesFolded` at one (the changed
tail), so unchanged rows retain their derived nodes despite new message identities (#301).

## Native terminal paint remains unavailable

`bench:render` measures the test renderer's state-commit → layout → captured-frame boundary,
not the terminal's compositor. Native terminal paint, PTY ingress latency and dropped-frame
counts remain unavailable until a compiled PTY trace exposes them. A deliberately inserted
100 ms stage in `src/perf/measure.test.ts` verifies that the sampling clock detects a known
stall, and every report labels the unavailable stages explicitly rather than substituting a
pure projector duration for interactive latency (#301).

## Related work

- #282 — this harness.
- #283 — incremental folded-node derivation (`createTranscriptProjector`). The harness's
  `projectorTailUpdate` scenario reports how many messages were refolded versus reused.
- #284 — decoupled transcript/job refreshes.
- #285 — memoized usage analytics and footer facts.
- #287 — interactive shell before catalog/session indexing.
- #288 — cached overview grouping/tab counts.
- #293 — reactive overview invalidation ordering.
- #294 — permissions/forms publish before child ancestry verification.
- #295 — failed transcript refresh drains queued hints and retries boundedly.
- #289 — retained-byte transcript cache budget and the bench memory report.
- #290 — animation-off timer cadence.
- #291 — composer editing under large drafts.
- #297 — bounded job-start probing after tool calls.
- #300 — retryable incomplete @file scans.
- #301 — real page reconciliation, recorded wire DTO mapping and an opt-in state-to-frame
  benchmark, with native terminal paint still labelled unavailable.
