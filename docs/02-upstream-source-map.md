# 02 — Verified upstream source map

**Research snapshot:** 2026-11-18. Target is **OpenCode v2.3.0**, not v1. All paths under `anomalyco/opencode` refer to the `v2.3.0` tag unless specified. The API currently labels many routes **experimental**; lock the package version and retest on upgrades.

## Canonical documentation

| ID | Exact source | Relevant claim |
| --- | --- | --- |
| OC-CLIENT | [OpenCode JavaScript network client](https://opencode.ai/docs/build/client) | `@opencode/client`, `OpenCode.make()`, headers, SSE `event.subscribe()`, service discovery |
| OC-API | [OpenCode API contract](https://opencode.ai/docs/api) | REST routes, operation IDs, `Session.Info`, event schemas, tokens/cost |
| OC-MODELS | [Models and variants](https://opencode.ai/docs/models/) | `provider/model#variant`; effort is a model variant only where supported |
| OC-AGENTS | [Agents configuration](https://opencode.ai/docs/agents/) | Build/Plan and custom agents; system prompts; permissions; visibility |
| OC-KEYS | [TUI keybinds](https://opencode.ai/docs/cli/keybinds) | Current OpenCode TUI shortcuts and agent cycle |
| OC-COMMANDS | [CLI commands](https://opencode.ai/docs/cli/commands) | CLI `run`, `--model`, `--agent`, `--session`, `--continue`, etc. |
| OC-RELEASE | [v2.3.0 changelog](https://opencode.ai/changelog/v2.3.0) | Specific 2026-11-13 baseline changes |
| CC-INTERACTIVE | [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode) | Keybindings, prompt queue, collapsed transcript, keyboard editing |
| CC-SESSIONS | [Claude Code sessions](https://code.claude.com/docs/en/sessions) | Empty-composer Left returns to agent view; background sessions |
| CC-CLI | [Claude Code CLI](https://code.claude.com/docs/en/cli-reference) | Positional prompt, `--model` and invocation conventions |

## Tagged source references (code, not marketing docs)

| Component | Repository file | Why inspect |
| --- | --- | --- |
| V2 TUI entry | [packages/tui/src/app.tsx](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/tui/src/app.tsx) | OpenTUI rendering, client/service wiring, providers, route/context setup; **reference, do not transplant layout** |
| V2 TUI composer | [packages/tui/src/component/prompt/index.tsx](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/tui/src/component/prompt/index.tsx) | Prompt assembly, paste, file attachments, slash commands, editor handoff |
| Server message projection | [packages/core/src/session/message-updater.ts](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/message-updater.ts) | Converts text/reasoning/tool lifecycle events into canonical messages; reference for reconciliation and grouping |
| V2 TUI keybind config | [packages/tui/src/config/keybind.ts](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/tui/src/config/keybind.ts) | Input/action mapping patterns and OpenCode default conflicts |
| OpenCode source root | [v2.3.0 tree](https://github.com/anomalyco/opencode/tree/v2.3.0) | Inspect exact tag for new files and APIs, not shifting `dev` |

**Evidence discipline:** the above files and OpenCode v2.3.0 tag were checked as existing source locations. Specific generated type signatures are authoritative only once compiled from the pinned `@opencode/client` dependency. Do **not** assume internal server functions are public SDK exports.

## Verified server capabilities relevant to this frontend

### Project grouping and sessions

`GET /api/session` lists sessions with `directory`, `project`, `subpath`, `search`, `parentID`, `archived`, `order`, `limit`, and cursor pagination. `Session.Info` has `id`, `parentID?`, `projectID`, `agent?`, `model?`, `cost`, `tokens`, `time`, `title?`, `location`, and more. `POST /api/session` creates a session in a chosen `location.directory`; `POST /api/session/{id}/agent` and `/model` switch subsequent turns. Sources: [OC-API sessions](https://opencode.ai/docs/api), search operation IDs `session.list`, `session.create`, `session.switchAgent`, `session.switchModel`.

### Queues and interruptions

`POST /api/session/{id}/prompt` durably admits input. `GET /api/session/{id}/inbox` lists pending user, synthetic, compaction and move items. The inbox delivery enum is `"steer" | "queue"`; `PATCH .../inbox/{id}` changes delivery mode; `DELETE .../inbox/{id}` cancels undelivered input. `POST .../interrupt` interrupts the active execution; interrupted response includes `interrupted: boolean`. **Important:** queue and steer are different backend modes. See [OC-API session inbox](https://opencode.ai/docs/api).

### Projecting a transcript

`GET /api/session/{id}/message` returns cursor-paginated projected messages, optionally filtered by type. Assistant messages carry `content` parts of types `text`, `reasoning`, `tool`; the reasoning part has `text` where supplied; tool states include `streaming`, `running`, `completed`, and `error`. Session-wide `cost` and `tokens` appear on `Session.Info`. See [OC-API Session.Message](https://opencode.ai/docs/api) and [message-updater source](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/message-updater.ts).

### Event stream and recovery

`client.event.subscribe()` is a **live-only** async iterable with neither replay nor automatic reconnection; a late listener receives `server.connected`, not missed events. The HTTP event stream is explicitly **volatile**, and a slow subscriber can overflow. The server also has **experimental** `GET /api/experimental/session/{id}/log?after=...&follow=...` for a durable event log, but do not build the MVP around the experimental log. Recover from disconnect by re-fetching canonical sessions, messages, inbox, permissions, status and usage. Sources: [OC-CLIENT streaming](https://opencode.ai/docs/build/client), [OC-API event and log](https://opencode.ai/docs/api).

### Background semantics

`POST /api/session/{id}/background` backgrounds **blocking tools** within a session; this is **not** the same as leaving the session UI. Our Left-arrow navigation is a **pure view detach**, normally with **no server mutation**. Source: [OC-API session.background](https://opencode.ai/docs/api).

### Reasoning, costs and tokens

Reasoning events exist (`session.reasoning.started/delta/ended`) and optional reasoning content is part of the assistant message. Some models provide no text, and token counts for reasoning do **not** imply readable reasoning text. `Session.Info.cost` is USD; `tokens` tracks input/output/reasoning/cache usage. Do not invent a provider trace. Sources: [OC-API](https://opencode.ai/docs/api), [message updater](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/message-updater.ts).

### Goals/plans

There is an **experimental durable instruction-entry API**: `GET /api/experimental/session/{id}/instructions/entries` and `PUT .../entries/{key}`. It can hold model-facing goals/instructions, with updates announced at the next model step. This is not a ready-made structured task plan: the UI must own a clear goals/tasks representation separately. See [OC-API experimental.session.instructions.entry](https://opencode.ai/docs/api).

### Permission/questions

`GET /api/session/{id}/permission`, `POST /api/session/{id}/permission/{requestID}/reply` and forms routes exist for pending approval/interaction. Session agents/permissions are server concepts. Never implement a plan/review safety mode solely by changing UI text. See [OC-API permissions](https://opencode.ai/docs/api) and [OC-AGENTS](https://opencode.ai/docs/agents/).

## Verified reference CLI behavior

OpenCode accepts a combined model selector `openai/gpt-6.1-sol#high` if the corresponding provider catalog contains that model/variant; `high` is not universally supported. The [OC-MODELS doc](https://opencode.ai/docs/models/) provides precisely this example. Our separate `--provider`, `--model`, `--effort` flags should resolve to its equivalent model reference and refuse unknown values, not silently downgrade reasoning effort.

Claude Code documents **Left on an empty prompt** returning to agent view when a session is backgrounded. This is the intended UX behavior, not an inference from its desktop app. Source: [CC-SESSIONS](https://code.claude.com/docs/en/sessions).

## Verification gaps before implementation

1. Generate and compile actual `@opencode/client` types at the pinned version; confirm variant propagation through `session.switchModel` and `session.prompt`.
2. Test `Service.ensure()` from a **Bun** process under Windows (native Promise service API docs describe Node); confirm the service lifecycle in a detached terminal.
3. Verify `session.list` across projects and child-session visibility with populated real storage.
4. Confirm whether session cost includes child-agent consumption and how cache tokens are represented; label UI narrowly until proven.
5. Verify `session.prompt` delivery option and default when the session is active, and whether deliberate steering/queuing is available on creation.
6. Probe whether `session.execution.*` and `session.status` cover all active/waiting states; account for late permission requests.
7. Determine backend model catalog effort aliases and variant display names per provider.
8. Confirm attachment API shapes, clipboard image path, slash command execution and permission/form reply payloads from generated types.
9. Check service RPC availability under custom servers and authentication; keep remote server pairing out of initial scope.
10. Inspect upstream source license and attribution obligations before distributing a frontend that imports/translates source code directly.
