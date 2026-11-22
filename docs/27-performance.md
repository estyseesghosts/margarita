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

`livePageReconcile` deliberately reports `pageObjectsRecreated: 120` and
`pageObjectsReused: 0`: a real page fetch allocates fresh DTO objects even when their content
is unchanged. The projector's deep-equal reuse keeps `messagesFolded` at one (the changed
tail), so unchanged rows retain their derived nodes despite new message identities (#301).

## Event-to-paint

The harness does not claim an event-to-paint number. It measures wire mapping, reconciliation,
incremental projection, grouping and composer derivation in-process; native layout, paint and
dropped-frame counts remain unavailable until a compiled PTY trace exposes them. A deliberately
inserted 100 ms stage in `src/perf/measure.test.ts` verifies that the sampling clock detects a
known stall, and every report labels the unavailable stages explicitly rather than substituting
a pure projector duration for interactive latency (#301).

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
- #301 — real page reconciliation, wire mapping and honest event-to-paint boundaries.
