# 09 — Session execution, queue and recovery

## Three independent state dimensions

1. **Navigation:** overview vs conversation and local modal.
2. **Execution:** idle, executing, waiting approval/form, interrupted, failed, reconnecting/unknown.
3. **Admission:** draft unsent, pending admission, enqueued, delivered (steer or queue), completed.

Don't collapse them into one `isActive` boolean. Overview navigation is independent of agent execution. A UI session can be closed, detached or unfocused while backend execution continues.

## Server session identity

Key a session by `(server identity, sessionID)` and associate it with `projectID`, directory and optional parentID. Cross-server recency requires qualification. A session title is mutable and is **never** an identity. OpenCode `Session.Info` includes session `id`, `projectID`, `parentID?`, `location`, `agent?`, `model?`, `cost`, `tokens`, `outcome`, and timestamps. [Source](https://opencode.ai/docs/api).

## Normal execution transitions

```text
CREATE → IDLE
IDLE + submit → ADMITTING → RUNNING
RUNNING + needs approval/form → WAITING_INPUT
WAITING_INPUT + reply → RUNNING
RUNNING + success → IDLE(success)
RUNNING + failure → IDLE(failed)
RUNNING + interrupt → IDLE(interrupted) / verify
ANY + transport loss → UNKNOWN (not 'stopped')
UNKNOWN + reconciled snapshot → factual state
```

Avoid treating `session.idle` as the only completion signal; include explicit execution started/succeeded/failed/interrupted events, pending permissions/forms, and on-demand state. A session may be waiting on the server while the current UI route is overview.

## Prompt semantics

- **Idle:** Enter submits a new turn, preserving attachments and model/agent snapshot. Clear composer **only after durable admission success** (optimistic pending text can be shown dim with retry affordance).
- **Running:** Enter uses **queue** semantics by default, as desired. Distinct action for **steer** must be available but not essential to ordinary use.
- **Queue list:** Read `GET /session/{id}/inbox` after posting, and show pending chips. Users can cancel queued input (server DELETE) or modify delivery mode (server PATCH) before delivery.
- **Queued edit:** backend API only explicitly guarantees delivery-mode update and cancellation, not arbitrary text editing. UX should implement `Cancel and restore to composer` instead of pretending server can edit content in place. If cancellation races with delivery, do not replace sent text; show that it was already delivered.
- **Concurrent frontend clients:** server ordering wins. A locally queued message may have been delivered while disconnected. Fetch canonical inbox and messages before showing `queued` forever.

Official semantics: [session.prompt](https://opencode.ai/docs/api), [session.inbox.list/update/cancel](https://opencode.ai/docs/api), enum `Session.Inbox.Delivery = steer | queue`.

## Source-of-truth reconciliation

### Cold attach algorithm

1. Ensure service and get connection identity.
2. Begin event buffering (or defer and always reconcile after subscription).
3. Fetch session summary, last N messages with cursor, inbox, pending permissions/forms.
4. Set initial projection and status; apply buffered events if safe by stable IDs. If an event predates fetched snapshot or changes the same entity ambiguously, **refetch**, not ad-hoc last-write-wins.
5. Mark loaded only once canonical messages and pending inputs are consistent.
6. Subscribe globally, but render only current conversation. Overview receives derived summaries for all sessions.

### Reconnect

The documented SDK event stream is **live-only**; neither replay nor auto reconnect. After network loss, show a dim status `Connection lost · retrying`. Keep displayed transcript and drafts. Reconnect with bounded exponential delay (e.g. 0.5, 1, 2, 4, 8 sec + jitter; cap 15sec), query live state and reset to authoritative snapshots. Do not autoreplay submitted prompts. [OpenCode SDK](https://opencode.ai/docs/build/client); [event API overflow](https://opencode.ai/docs/api).

An optional v2 durable `/experimental/session/{id}/log` supports `after` sequence and `follow`. Treat as experimental upgrade path. The MVP uses full recovery queries, not dependency on an unstable log. If later enabled, assert gap handling and event sequence semantics in an integration test before shipping.

## Visible row state and latency

- `working`: an execution-started event or authoritative active status.
- `needs input`: pending permission or form, even when no assistant text arrives.
- `failed`: explicit failure/outcome, not merely disconnected.
- `idle`: the current agent loop finished; background tools may remain (separate status).
- `unknown/reconnecting`: server unreachable; **never** call it idle.
- `unread`: session transitioned since last server `session.view` acknowledged, or local last-viewed time. Avoid marking it read merely because overview displays row.

Switching to overview should take less than one frame of network latency—it's local navigation. The list may display cached state while refresh proceeds. Switching back to a loaded conversation should show cached transcript at once and reconcile asynchronously. An active permission question should surface on attach.

## Historical pagination and cache

OpenCode message list is cursor-paginated with stable ordering, so fetch recent page first, then older pages on scroll. Track cursor+filter together; don't reuse cursor from a different filter. Use `messageID` stable keys. Deduplicate against streaming events and local optimistic submissions; no duplicate text after reconnect. Keep a bounded LRU of inactive session transcripts; do not memory-cache every project indefinitely.

## Parent/child sessions

A `parentID` indicates a linked child. Show child count/state in parent conversation and optionally nested in overview. Child execution should not prevent returning to overview. Do not automatically promote child sessions to top-level rows unless user chooses 'show subagents'. A parent operation's completion does not imply every child is finished; observe actual children where available. A child question or MCP elicitation belongs to the parent conversation that can see it; parent links for an uncached child are verified from `session.get` before a location-wide request is shown, and the verified owner is cached per host and session lifetime so deletion, ID reuse or a sibling with the same ID cannot leak a form. OpenCode v2.3.0 changed background subagent behavior: [release notes](https://opencode.ai/changelog/v2.3.0).

Margarita reads background workers from the server's `experimental.job.list({ sessionID, kind: 'subagent', descendants: true })`, not from tool names or client timers. Each confirmed `subagent` job becomes a worker row in the parent transcript with its agent, description and the server's own status (`running`, `completed`→"returned", `error`→"failed", `cancelled`); rows are ordered running-first, then oldest-first, then by id so two hosts render the same layout. Collapsed rows stay concise; `Ctrl+↑/↓` then `Enter` expands the child session id, timestamps and title. The worker's actual result lives in its child session transcript — the row does not invent a result payload the RPC does not provide. Worker rows are refreshed on attach, on throttled transcript refetch, and on reconnect; they are cleared at disconnect and whenever the job RPC fails or is unsupported, so a detached client never shows a ghost running worker and an unknown event degrades to the ordinary delegate tool row.

## Interrupt / exit / detach distinctions

| User gesture | Backend mutation | Notes |
| --- | --- | --- |
| Left on empty composer | **None** | View detach only |
| Ctrl+C while executing | `session.interrupt` | Confirm result, don't assume interrupted |
| Ctrl+D while idle | None | Exit TUI, service keeps running |
| Stop background tool | `session.background`? | **No**—this backgrounds tools; use proper job-stop capability if available |
| Cancel undelivered follow-up | `session.inbox.cancel` | Only if not delivered |
| Switch session | None | Attach different projection |
| Delete session | `session.remove` | Destructive; explicit confirmation, child effects shown |

## Minimal live integration suite

- A executing, Left → overview, B starts, A completes; A's answer is present on reattach.
- A requests permission, Left → B, overview marks A needs input, attach A and answer once.
- Kill TUI while A running, restart into overview, attach A; same sessionID and ongoing execution.
- Two TUIs attached to A, prompt in one and approval in other; both reconcile.
- Drop event stream for 5s, reconnect with no duplicates or phantom pending items.
- Scroll up while streaming, location remains stable; a new message indicator appears.
