# Upstream integration checklist — run before implementation/upgrade

Version target: OpenCode **v2.3.0** (research snapshot 2026-11-18). Record actual installed version, package lockfile and test machine.

## Public client and service

- [ ] `bun add @opencode/client` resolves the expected v2 APIs.
- [ ] Generated `OpenCode.make()` and `Service.ensure()` typecheck and work on Windows + Linux.
- [ ] TUI close/kill does NOT stop shared server or its ongoing execution.
- [ ] `--server` uses existing endpoint and never starts local service.
- [ ] `server.info()` version/connection data sufficient to detect incompatibility.

## Session and overview

- [ ] `session.list` returns paginated sessions across project folders when location omitted.
- [ ] Session location/projectID stable; duplicate basenames remain separate.
- [ ] Session.create with explicit directory valid; agent `build` present or graceful fallback.
- [ ] Agent/model switches during execution have documented boundary semantics.
- [ ] Parent/child sessions appear as expected; archived filtering and cursor correctness tested.

## Prompts and events

- [ ] `session.prompt` has a verified way to request queue vs steer; capture generated request type.
- [ ] Active-session Enter queues and does not interrupt.
- [ ] Inbox list/update/cancel distinguish pending vs delivered; concurrent delivery cancellation tested.
- [ ] Event stream interrupts/disconnects as documented; resubscription plus snapshots reconstruct state.
- [ ] Message projection includes relevant text, tool, reasoning, idle and compaction entries.
- [ ] `session.usage.updated` payload and session.cost/tokens semantics verified.

## Interaction and permissions

- [ ] Permission list/reply exact generated method/signature checked.
- [ ] Forms list/reply supported and typed.
- [ ] `session.shell` actual behavior verified before exposing `!` automatic-followup behavior.
- [ ] `session.diff` and revert boundaries validated before adding rewind.
- [ ] Instruction entries confirm updates at step boundaries, preserved after disconnect.

## Model/effort

- [ ] Provider/model catalog contains test model and supported `high` variant.
- [ ] `--model provider/model#variant` propagates exact variant.
- [ ] Invalid variants produce errors, not implicit fallback.
- [ ] Reasoning part absent when provider doesn't return readable reasoning even with tokens.

Sources: [API](https://opencode.ai/docs/api), [SDK](https://opencode.ai/docs/build/client), [Models](https://opencode.ai/docs/models/), [Agents](https://opencode.ai/docs/agents/), [v2.3.0 changelog](https://opencode.ai/changelog/v2.3.0).
