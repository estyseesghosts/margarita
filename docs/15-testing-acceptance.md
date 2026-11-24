# 15 — Testing strategy and measurable acceptance

## Test layers

1. **Pure unit tests** (`bun test`): parser, model resolver, keymap precedence, project grouping, group summaries, cost formatting, session state reducers.
2. **Fake server integration**: record deterministic typed responses/events for sessions, inbox, approvals, reasoning, models and failures. HTTP handler should implement only documented v2.3.0 shapes.
3. **Live OpenCode service contract tests**: exercise real `@opencode/client` against a locally available v2.3.0 server, with paid model calls disabled by default. Test call signatures and response shapes; make optional real model smoke separate.
4. **Terminal E2E**: spawn TUI under PTY/ConPTY; feed actual keystrokes; compare semantic view state and golden line snapshots; test resize and normal/crash cleanup.
5. **Manual UX validation**: multiple independent terminals and Windows+Unix; no code judged complete solely from snapshots.

Sources for contract assumptions: [OpenCode v2 API](https://opencode.ai/docs/api), [SDK event semantics](https://opencode.ai/docs/build/client), [Claude keyboard UX](https://code.claude.com/docs/en/interactive-mode), [Claude session overview](https://code.claude.com/docs/en/sessions).

## Writable integration suite (opt-in)

`bun run test:writable` runs `test/writable/` against a **disposable** OpenCode service. It is separate from the read-only `MARGARITA_LIVE=1` smoke test, which is unchanged.

- **Isolation.** The suite starts its own standalone `opencode serve` on a free loopback port. All four XDG roots (config, data, cache, state) and the workspace are under one temp directory, so nothing is read from or written to your OpenCode config, sessions or storage, and your background service is never contacted. Teardown kills the process listening on that port and deletes the directory.
- **No model credits.** The service is configured with one OpenAI-compatible provider pointing at an in-process mock (`test/writable/mock-model.ts`). The reply is chosen by the prompt text: `HOLD …` stays open until released, `FAIL …` answers HTTP 400, `TOOL <name> <json>` emits that tool call, anything else echoes `ok: <text>`.
- **Covered:** first prompt, queued second prompt, queue cancel, queue-to-steer, interrupt, provider failure, permission ask/reply/conflict/reject, form reply, model switching, fork and revert, event stream correlation, reconnect with resync, and per-directory sessions and file search. Assertions check message, inbox and event correlation by ID rather than UI strings.
- **Requires** `opencode` v2.3 on `PATH`. The script sets `MARGARITA_LIVE_WRITE=1`; without it the suite is skipped, so a plain `bun test` never starts a service.

Observed against OpenCode 2.3.0 (pinned by the suite and by the fixtures below):

- A prompt's inbox item ID is the ID of the user message it becomes.
- One idle marker closes a whole **run**: a queued follow-up delivered in the same run shares the final marker. Turn boundaries are therefore the next user message or the idle marker.
- A declined permission ends the run with an errored assistant reply and **no** idle marker.
- `message.list` rejects `order` together with `cursor`; the cursor already encodes the order.
- The event stream is live-only; work done while disconnected is not replayed, so reconnect must re-read canonical state.

### Recorded fixtures

`test/fixtures/opencode-2.3.0/` holds sanitized raw SDK responses (session, message pages, queued inbox, permission ask, form ask) recorded by `bun run capture:fixtures` from the same disposable service. IDs, timestamps and paths are normalized by `test/writable/sanitize-fixture.ts`. `src/adapter/fixtures.test.ts` maps them through the real wire mappers on every `bun test`. Re-record after upgrading the SDK or server, then review the diff.

### CI

`.github/workflows/verify.yml` runs `bun run verify` on Windows and Linux. The writable suite is not part of it; run it locally or in a dedicated job that has OpenCode installed.

## Clipboard and selection acceptance

The automated unit and mounted-UI tests cover the deterministic rules; real terminal/desktop behaviour is checked separately and never in the standard suite.

| Scenario | Automated coverage | Required result |
| --- | --- | --- |
| `Ctrl+V` with multiline text | mounted UI (`src/ui/app.test.tsx`) + controller | Exact insertion, no submission, one undo step |
| Right-click without selection | mounted UI + controller | One paste |
| Right-click with selection | mounted UI | One copy, no paste |
| Drag and release | mounted UI | Selection copied once |
| Autocopy disabled | mounted UI | Explicit `Ctrl+Shift+C` still copies |
| Copy 100 KB response | `test/clipboard-live.test.ts` (opt-in) | Complete native clipboard contents |
| Copy Unicode code block | `test/clipboard-live.test.ts` (opt-in) | No corrupted characters; CRLF normalized on paste |
| Copy during streaming | controller + domain | Previous completed response |
| Switch session during clipboard read | controller | No cross-session contamination |
| Paste image or PDF | controller | Existing attachment behaviour, no binary in the draft |
| Clipboard unavailable | mounted UI + controller | Clear, truthful feedback, nothing inserted |
| Exit application | PTY smoke | Terminal state restored |

`MARGARITA_CLIPBOARD_LIVE=1 bun test test/clipboard-live.test.ts` is the only test that touches the real desktop clipboard; it restores the previous plain-text clipboard. `test/smoke/pty-smoke.py clipboard` runs the acquisition path under a minimal PTY (no desktop clipboard) and asserts the app reports it instead of submitting. Manual verification is still required on Windows Terminal first, then representative Wayland/X11 terminals, macOS terminals and an SSH/tmux session; those environments cannot be proven from one machine.

## Fixtures to check in

`test-fixtures/cases/` must include synthetic but schema-valid versions of:

- `session-list-three-projects.json`: two paths with same basename, 2 running, 1 waiting, 1 archived, one child.
- `session-usage.json`: zero-cost local model, USD cost normal case, missing price/unknown case, reasoning/cache token usage.
- `assistant-tool-group.json`: 4 read calls, 2 searches, 1 failed command, assistant answer.
- `assistant-reasoning-present.json`: reasoning part with text and tokens.
- `assistant-reasoning-absent.json`: reasoning tokens with no text.
- `events-stream-disconnect.jsonl`: interleaved A/B events, dropped connection, reconciliation snapshot.
- `inbox-queued-then-delivered.json`: active execution, queued prompt, delivered message.
- `forms-approval-multiple.json`: permission plus form concurrently.
- `multiline-paste.txt`: CRLF/Unicode/emoji/ANSI control sequences, 100KB.

Do not serialize private user prompts or real credentials into fixtures.

## Pure property-based tests

### Project grouping

Given arbitrary distinct paths, no session disappears; each belongs to exactly one project group. Sort stable under a token delta; only update on meaningful activity. IDs unique even if titles and basenames match. Paginated session lists union into correct overview; no duplicate rows when cursor overlap occurs.

### Keybindings

No action map contains a two-step prefix/chord. Context-specific actions are deterministic; dialog always outranks global; Left only goes overview with exact guard; `Shift+Tab` cycles agents, never permission. Support loaded keymap override without duplicate ambiguous action in same context. Simulate paste and Unicode cursor movement on grapheme clusters.

### Folding

Grouping preserves tool order, failures, and total number of operations. Unfolding recovers exactly the original tool parts. Adding a tool preserves prior group IDs when safe. A reasoning token count without text never produces invented text. User messages and final assistant text never disappear into groups.

### CLI

No network or session mutation on invalid args. Positional prompt chooses interactive mode unless `--print`. `--model openai/m#high --effort low` is an error. Resume and continue don't create new sessions. Token formatting doesn't double-count cache/reasoning by unverified assumptions.

## Behavioral acceptance scenarios

### A — First-run prompt

**Given** a healthy registered OpenCode server, provider/model with available variant, in directory `kohjoh`, **when** user runs `unnamed --provider openai --model gpt-6.1-sol --effort high "review gpu"`, **then** one session created, `build` selected, exact variant chosen, one prompt admitted, conversation UI attached without extra confirmation, no header bar, footer shows server-reported usage when known.

### B — Overview and parallel sessions

**Given** A running, **when** user presses Left with empty composer, **then** overview appears and A keeps executing. **When** user submits overview composer, **then** B created and attached. **When** user selects A, **then** same ID and uninterrupted history shown. Verify no `session.background` or `session.interrupt` request was issued during navigation.

### C — Interrupt and queue

**Given** A running, **when** Enter submits follow-up, **then** durable inbox has one queued item and the UI shows pending chip. **When** user cancels, **then** API cancels only if not delivered. **When** user presses Ctrl+C, **then** backend interrupt called; result verified and status reconciled.

### D — Agent cycle

**Given** Build and Plan registered, **when** Shift+Tab pressed from Build, **then** server switchAgent('plan') called and footer updates after confirmation. **When** model changes in another client, **then** footer reflects server state, not stale local selection.

### E — Reasoning and grouping

**Given** four read tools with one error, **then** compact view shows small summary with error visible. **When** Ctrl+O, **then** all four calls appear with original order and output. Reasoning displays only if present in server message parts.

### F — Offline and reconnect

**Given** B displayed and A working, **when** SSE disconnects, **then** B draft stays intact, UI says disconnected, background A not assumed stopped. **When** connection resumes, **then** snapshots refresh, A complete, no duplicated messages, no accidental re-submission.

### G — Permissions

**Given** A waiting on request, **when** user switches to B and back, **then** request survives and can be answered once; a second client answering concurrently results in conflict resolution not duplicate approval.

### H — Goal/plan

**Given** goal/task sidecar, **when** restart and resume same session, **then** exact accepted revision restored. Sync explicitly with server instruction entry and verify acknowledged revision. User rejecting a proposal doesn't mutate accepted plan.

## Performance and UX evaluation

Track median/p95 input latency on 100, 1k and 10k message fixtures, memory after repeated session switches, overflow recovery, project-group sort stability, status propagation under heavy token events, terminal reflow and no lost keystrokes. UX-specific manual check: a developer can perform 10 successive `Left → overview → attach` switches without a header, tabs or modal interruption.

## Release gates

- Unit tests: 100% of critical transition rules and keybinding edge cases covered.
- Integration: all required OpenCode v2.3.0 endpoints and event types tested; known unsupported features explicitly disabled.
- Terminal: Windows Terminal + Ghostty + tmux smoke passes.
- Stress: no unbounded memory growth on streamed outputs and long sessions.
- Safety: no false approval, no unsent text loss, no session aborted on UI detach, no double-submit on uncertain POST.
- Documentation: README usage examples tested; `--help` matches actual behavior; source map updated for lockfile.
