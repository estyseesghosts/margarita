# 25 — Server compatibility matrix (v2.3.x)

Margarita pins `@opencode/client` **2.3.0** and connects to an existing OpenCode service; it never
starts, stops or reconfigures that service. This document records which server versions were
audited and what was actually verified, so a version bump cannot silently drop an event (#103).

## Decision on the SDK

**Keep the SDK pinned at 2.3.0.** The generated wire types were diffed between 2.3.0 and 2.3.2
(`@opencode/client/dist/promise/generated/types.d.ts`). None of the shapes Margarita consumes
changed:

- the streamed event names used by `normalizeEvent` (`session.*`, `permission.*`, `form.*`,
  `rpc.opencode.goal.changed`, `server.connected`);
- `SessionMessageShell` (identity `shellID`, status `running | exited | timeout | killed`, `exit`,
  truncated output) and `SessionMessageCompaction` (`started | completed | failed`/`status`);
- `TokenUsage.Info` (`input`, `output`, `reasoning`, `cache.read`, `cache.write`);
- `experimental.job.list` inputs and the `JobShell`/`JobSubagent` fields used by #101/#103.

The 2.3.2 diff only adds unrelated or safely-ignored surface: `JobCodeMode` (a new `JobInfo`
variant), automations replacing schedules, video generation, and config `compaction.background`.
Margarita's strict mappers already drop unknown job kinds instead of mislabelling them. Upgrading
the SDK is therefore optional, not required for wire compatibility.

## Version matrix

| Feature | v2.3.0 (pinned) | v2.3.1 | v2.3.2 | Evidence |
| --- | --- | --- | --- | --- |
| Prompt / queue / steer events | PASS | PASS | PASS | versioned event fixtures replayed through `normalizeEvent` |
| Tool timeout → background | PASS | PASS | PASS | `timeout` shell stays `timeout`; a running `JobShell` with matching `shellID` is shown as `still running in background` |
| Compaction start / end / failure | PASS | PASS | PASS | all three events remain `transcript-changed`, so no spinner is orphaned; explicit `/compact` uses the same path |
| Permission / form | PASS | PASS | PASS | events normalize to `input-requests-changed` |
| Background subagents / new job kinds | PASS | PASS | PASS | `subagent` → worker row; v2.3.2 `codemode` dropped |
| Reconnect | PASS | PASS | PASS | `server.connected` → `connected`; jobs cleared and resynced |
| Native-goal reads | PASS | PASS | PASS | `rpc.opencode.goal.changed` → `goal-changed` |

`test/compat-matrix.test.ts` replays `test/fixtures/compat/v2.3.{0,1,2}.json` through the real
adapters in `bun run verify` and prints one PASS row per version listing every exercised feature.
This gives CI a meaningful per-version, per-feature result and catches a silent event drop.

## Behavior changes that matter (from the v2.3.1/v2.3.2 changelog)

- **v2.3.1:** a shell still running when its timeout expires moves to the background instead of
  being killed. The transcript message still reports `status: 'timeout'`, so Margarita does **not**
  call it failed or finished; it queries `experimental.job.list({ kind: 'shell' })` and, only when
  the server reports a matching running job, appends `· still running in background`. Without that
  confirmation the row stays plainly `timeout`. A failed/unsupported job RPC never invents a
  background state.
- **v2.3.1:** compaction summaries are written in the background. No new event type was added —
  `session.compaction.started/ended/failed` still fire — so the running spinner is cleared by the
  normal transcript refetch; a failed compaction does not reset the context reading (#124).
- **v2.3.2:** GPT-6.2 prompt caching sends the system prompt as a leading developer message. Token
  categories keep the same shape, so per-step context accounting is unaffected. `webfetch`
  structured output no longer repeats `url`/`format`; Margarita renders whatever the server sends.

## What was NOT verified

This is a static wire-shape audit plus fixture replay, **not** a live run against disposable
v2.3.1/v2.3.2 servers. The opt-in live harness (`test/live-compat-smoke.test.ts`, driven by
`test/live-compat-harness.ts`) records every case as `offline fixture pass`, `live pass`,
`live failure`, or `not run` with the exact server version and a redacted detail line. By
default it records `not run` and touches nothing. To execute it, provide **disposable** isolated
services and an isolated workdir/model:

```sh
MARGARITA_LIVE=1 \
MARGARITA_COMPAT_V231_URL=http://127.0.0.1:5101 \
MARGARITA_COMPAT_V232_URL=http://127.0.0.1:5102 \
MARGARITA_COMPAT_DIRECTORY=/tmp/opencode-disposable \
MARGARITA_COMPAT_MODEL=openai/gpt-6.2-astra \
MARGARITA_COMPAT_RESULTS=./live-compat-results.jsonl \
bun run test test/live-compat-smoke.test.ts
```

The harness only connects to the explicit URLs (`connect({ server, startServer: false })`),
never calls service discovery, and refuses duplicate/default endpoints or a missing isolated
workdir/model. It must never point at the user's running service. Until a live run is recorded,
do not claim live end-to-end coverage of compaction timing or background-shell completion on
v2.3.1/v2.3.2 — only that the wire contract Margarita depends on is unchanged and the recorded
divergence is handled.
