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
| `projectUsage` | same | Footer/`/usage` analytics over loaded history |
| `overviewGroups` | 1 / 50 / 500 sessions | Project grouping, ordering and path identity across two hosts |
| `composerEdit` | 40 / 500 / 5,000 / 50,000 graphemes | End insertion plus one grapheme-left move |
| `composerBackspace` / `composerCaret` | same | One grapheme delete and cached caret paint at end |
| `composerMention` / `composerNoMention` | same | Active `@src` parsing versus ordinary prose with no `@` on the line |

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

## Reproducibility rules

- Use the same commit, machine, terminal size, Bun version and power mode for comparisons.
- Run the baseline and patch at least three times; compare p50/p95, not a single sample.
- Keep fixtures seeded/synthetic. Do not benchmark against the user's OpenCode service.
- Instrumentation must remain opt-in and cheap when disabled; ordinary `bun run verify` never
  imports the harness.
- Do not turn machine-specific p95 numbers into hard CI thresholds. CI may run `--smoke` to
  catch crashes or runaway work, not as a performance gate.

## Related work

- #282 — this harness.
- #283 — incremental folded-node derivation (`createTranscriptProjector`). The harness's
  `projectorTailUpdate` scenario reports how many messages were refolded versus reused.
- #284 — decoupled transcript/job refreshes.
- #285 — memoized usage analytics and footer facts.
- #288 — cached overview grouping/tab counts.
- #290 — animation-off timer cadence.
- #291 — composer editing under large drafts.
