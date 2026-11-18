# 16 — Delivery roadmap and issue-sized engineering tasks

## Implementation order

Prioritize a vertical slice over generalized abstractions. Each milestone ships a working behavior and protects it with tests. Avoid building a plugin ecosystem or complex styling engine before a user can run one prompt, detach to overview and reattach.

## Milestone 0 — Upstream contract and workspace (8 work items)

1. Create Bun workspace, package boundaries and strict TS config; pin `@opencode/client`, OpenTUI/Solid, Bun version. Exit: clean `bun install`, `bun test`, `bun run typecheck`.
2. Implement `audit-sdk.ts`: print typed signature availability for `session.list/create/get/prompt/agent/model/inbox/message`, `event.subscribe`, permission APIs, context and instructions entry.
3. Build local service connector using `Service.ensure()`, test Bun on Windows/Linux, `--server` opt-out.
4. Define all domain types, branded identifiers and error union; no imports of React/OpentUI in domain.
5. Record typed fake server fixtures for canonical session+messages+events.
6. Set CI test matrix Linux/Windows, Node/Bun compatibility check for service adapter.
7. Establish license and attribution audit for any copied upstream source; prefer own implementation.
8. Write executable API compatibility README, including verified exact version.

**Gate:** connect existing service, list session IDs, fetch full session metadata with no UI.

## Milestone 1 — Minimal real conversation (8 work items)

1. Two-route OpenTUI app shell with no header and no tabs.
2. Minimal composer, Unicode-aware editing and Enter submit.
3. Create session with `build` agent where available; render user and assistant text from canonical `Session.Message`.
4. Implement typed `event.subscribe` consumption, buffering and periodic reconciliation.
5. Add execution status and `Ctrl+C` interrupt with authoritative result.
6. Add token and USD spend footer (server-provided) and unknown states.
7. Implement `/help`, `Ctrl+L`, `Ctrl+D` safe close, clean exit.
8. Add deterministic terminal snapshots and live OpenCode smoke test.

**Gate:** start and complete a real conversation from a prompt; close and resume its exact ID; no ghost tool calls.

## Milestone 2 — Session overview (9 work items)

1. Page through cross-project `session.list`, group by project path and hide child sessions by default.
2. Implement overview session rows with statuses and sorted meaningful activity time.
3. Implement guarded Left from empty composer to overview.
4. Overview `Enter` / Right attach to selected existing session.
5. Implement overview composer creates new session for selected project.
6. Maintain global event watcher and overview status updates while in other sessions.
7. Cache inactive transcripts and persist selected project/session.
8. Add `--continue`, `--resume`, `/sessions`, archived visibility.
9. Multi-client attach/detach and reconnect regression suite.

**Gate:** A runs, user leaves it, creates B, returns A while execution remains live.

## Milestone 3 — Composer and shell-first UX (10 work items)

1. CLI parser: positional interactive prompt and `--print` split.
2. Model/provider/effort resolver with catalog validation and conflict errors.
3. `Shift+Tab` agent cycle and server switch; `Alt+P` model picker; F2 recents.
4. Reverse history, stash, editor, multiline, key normalization and keymap precedence.
5. File references and image/file attachment support.
6. Slash commands, server commands and help overlay.
7. Queue/steer integration (Enter queues running session; explicit steering action).
8. Pending queue chips, cancel/retry behavior and uncertain POST reconciliation.
9. Shell `!` mode once exact server semantics verified.
10. Test full keyboard matrix on Windows Terminal and Ghostty.

**Gate:** supplied example launch command works; shortcut use feels natural; no key chords.

## Milestone 4 — Transcript intelligence and approval UX (9 work items)

1. Semantic transcript model and safe deterministic tool categorizer.
2. Default grouped tool activity; failure visibility invariant.
3. `Ctrl+O` detailed transcript with exact tool outputs and timestamps.
4. Reasoning text when supplied, no synthesized hidden reasoning.
5. Virtualized transcript, scroll anchor, lazy historical pagination.
6. Pending permission modal, server reply and second-client conflict resolution.
7. Forms/question UI and overview `needs input` state.
8. Diff viewer from structured `session.diff`, scoped to turn ranges.
9. Performance suite for 10k-message transcript, long stdout and reconnect.

**Gate:** ordinary sessions read cleanly; advanced traces and errors remain inspectable.

## Milestone 5 — Goals/plans and release hardening (8 work items)

1. Goal plan schema, migrations and atomic sidecar writes.
2. `/goal` and `/plan` editing; acceptance workflow for proposed plans.
3. `Ctrl+T` checklist; manual task state and evidence linkage.
4. Optional durable instruction entry sync, explicit consent and revision tracking.
5. Restore/fork/rename/revert workflows with server API validation.
6. Config schema, single-action keybinding overrides, themes and accessibility.
7. Packaging and install instructions for Bun binary or npm (decide after Bun compile tests).
8. Release candidate smoke checklist, performance and security reviews.

**Gate:** all acceptance scenarios in [15-testing-acceptance](15-testing-acceptance.md) pass.

## Future milestones, not blockers

- Alternative scrollback renderer; reduce alt-screen restrictions without breaking session abstraction.
- Custom default agents / tuned read-only research agent, integrated via OpenCode config (not forked server).
- Multiple server endpoints in one overview, explicit key namespace and auth.
- A narrow optional plugin UI surface; avoid copying OpenCode's entire GUI/TUI plugin slot system.
- More sophisticated task plans, server-side collaborative task storage and durable synchronization.
- Explainable context-window occupancy, per-model spend attribution, rate limit status.
- Optional session-to-session message notifications, never a multiplexer.

## Suggested PR boundaries

Keep changes reviewable, roughly one feature plus tests per PR. For risky areas use small RFC/probe PR first: session inbox queue semantics, model variant selection and event replay/reconnection. Each PR updates the source map or adds a fixture. Pull requests that add a UI feature without a state-machine test should not pass review.

## Definition of complete

A first public release requires no header, Build-default agent cycling, overview project grouping, safe attach/detach, positional prompt, grouped transcript, Ctrl+O details, visible actual token+USD spend, working permission/questions, goals/plans, and reconnect correctness—not merely screenshots resembling Claude Code.
