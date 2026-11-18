# 03 — Architecture and process ownership

## Guiding decision

Use **Bun + TypeScript + OpenTUI Core/Solid** for the TUI and the official **network** `@opencode/client` for OpenCode v2. **Do not use** the embedded `@opencode/sdk` as the frontend's primary integration: it hosts the server inside the application's process, the opposite of persistent independent execution. Official docs distinguish the network client and embedded SDK: [network client](https://opencode.ai/docs/build/client), [embedded SDK](https://opencode.ai/docs/build/sdk).

```text
  terminal emulator / shell
           │
           ▼
  unnamed CLI (Bun argv/config parser)
           │
       UI controller
           │
     ┌─────┴───────────────────────────┐
     ▼                                 ▼
 OpenTUI/Solid                         client state
 session renderer/overview             local drafts, keymap, fold state
     │                                 │
     └─────────► typed adapter ◄───────┘
                    │
            @opencode/client
                    │
             HTTP + event stream
                    │
           OpenCode v2 service
          sessions / providers /
        model, tools, approvals / logs
```

## Suggested monorepo

```text
package.json / bun.lock
packages/
  cli/              bin entry, args/env, print mode
  app/              Solid/OpenTUI views, local UI state
  adapter/          typed server actions, event buffer, reconciliation
  domain/           pure state machines, view models, selectors
  config/           schema, defaults, migrations, keymap parser
  test-fixtures/    fake server responses, event recordings
  terminal/         keys, paste, clipboard, terminal capabilities
scripts/
  smoke-live.ts     requires explicitly opted-in local OpenCode service
  audit-sdk.ts      prints API compatibility matrix
```

Avoid importing the OpenCode internal `packages/core/*` modules into domain/UI. The public API and generated client are the contract. Source: [client docs](https://opencode.ai/docs/build/client), [OpenCode TUI app source](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/tui/src/app.tsx).

## Package responsibilities

### `cli`

Parse argv before launching renderer. Support `--provider`, `--model`, `--effort`, `--agent`, `--cwd`, `--server`, `--resume`, `--continue`, `--print`, `--json`, `--config`, `--version`, `--help`, `--no-start-server`. Validate contradictory flag combinations. Return friendly errors before making server mutations. Restore terminal state in `finally`/signal handling.

### `adapter`

Expose typed, narrow operations: `ensureService`, `listProjects`, `listSessions`, `createSession`, `switchAgent`, `switchModel`, `prompt`, `listInbox`, `updateInboxDelivery`, `cancelInboxItem`, `listMessages`, `getSession`, `listApprovals`, `answerApproval`, `subscribe`, `interrupt`, `readUsage`, `readContext`, `getDiff`, `revert`, `setInstructionEntry`. Normalize SDK errors. Never conceal a 409, 401 or missing feature behind an invented success.

### `domain`

Define `ServerKey`, `ProjectKey`, `SessionKey`, `SessionSummary`, `ConversationProjection`, `EventCursor`, `InboxEntry`, `ExecutionState`, `UiRoute`, `Selection`, `Draft`, `GoalPlan` types. Keep pure reducers and selectors separate from rendering. Use versioned local persistence for drafts, fold state, project last selection, goal plans and keymap overrides.

### `app`

Two top-level routes only: `overview`, `conversation(sessionKey)`. Dialogs are overlays, not routes (model picker, permission request, goal/plan editor, transcript details, diff review, help). No multi-pane layout. An `unmount` of conversation does not call any server stop API. On route change, keep relevant global event watcher alive.

### `terminal`

Normalize keyboard events from Windows Terminal, Ghostty, WezTerm, Unix terminal, tmux. Handle bracketed paste, multiline Unicode, image clipboard strategy, resize, suspend and Ctrl+C. Detect feature support at launch; show fallback keys in help, not as permanent UI noise.

## Service ownership

Official OpenCode supports `Service.ensure()` from `@opencode/client/service`, which discovers or starts a compatible shared server. Example from upstream:

```ts
import { OpenCode } from '@opencode/client'
import { Service } from '@opencode/client/service'
const endpoint = await Service.ensure()
const client = OpenCode.make({
  baseUrl: endpoint.url,
  headers: Service.headers(endpoint),
})
```

This is **reference code from documentation**, not claimed typechecked inside this package. The service supports default registered shared `opencode serve --service`, and `Service.ensure({ version: ... })` takes a pinned exact version or compatibility predicate. For initial development require exact v2.3.0 or an explicitly validated compatible version. [Source](https://opencode.ai/docs/build/client).

An attached remote `--server` connects without spawning a local server, and must show a confirmation of destination and authentication errors. For local `--no-start-server`, connect if registered, otherwise report no server and an explicit actionable command. Do not stop the service when the TUI exits. Never start multiple services on the same project merely for a new UI window.

## Process state vs session state

| Data | Owner | Lifetime |
| --- | --- | --- |
| Session messages, execution, model, agent, approvals, queues, usage | OpenCode server | Survives UI close |
| Current UI route and focus | Frontend memory | Current process |
| Draft text, cursor, paste attachments, history, fold state | Frontend local cache | Restart-safe optionally |
| Goal/task UI tracking | Frontend local store (versioned) | Restart-safe |
| Model-facing goal instructions | OpenCode server if opted-in | Session lifetime |
| Process stderr/logs | Frontend logging | Process/session diagnostics only |

## State synchronization strategy

- On boot: ensure/connect; fetch catalog; list sessions, choose route; fetch target session/messages/inbox/approvals/usage; establish event consumption.
- Avoid snapshot/event race: subscribe/buffer early, snapshot, then reconcile buffered events by server IDs and re-fetch on any uncertainty. Simple MVP may subscribe then fetch and prefer complete re-fetch after transition.
- On reconnect: display `Reconnecting…` without covering existing transcript, reconnect, refresh authoritative state; no auto-submit of unsent draft or retry of ambiguous successful writes.
- Cache `sessionID` and `projectID`; never infer session identity from a title or path alone.
- Block unknown API versions until probed; degrade optional features one at a time.

## Security boundary

The UI must not implement alternative tool execution as a shortcut around server permissions. In `!` shell mode, label the action as **user-run**, show cwd/command before execution, and avoid presenting it as a server-approved agent action. Use the documented session shell endpoint if compatible. Do not log auth headers, raw environment secrets, private reasoning in debug logs, or full tool outputs by default. Apply log redaction before exporting diagnostics.

## Dependency rule

Pin versions of Bun, `@opencode/client`, OpenTUI and Solid at first green build; monitor upstream release notes. Do not clone `dev` source and assume stable APIs. Run `bun run check:api` on upgrades before updating the lockfile. `v2.3.0` is a **baseline**, not a guarantee of backward compatibility.
