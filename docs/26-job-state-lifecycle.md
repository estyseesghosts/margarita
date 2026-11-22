# 26 — Job state and background confirmation lifecycle

Two kinds of "background" state live in the frontend, and they must not be confused.

## Server-confirmed jobs (#101, #103, #136)

`state.workers` (subagents) and `state.shellJobs` (timed-out shells that keep running) are **server-authoritative projections**. They come only from `experimental.job.list`; a failed or unsupported RPC clears them rather than inventing a status. A shell message still labelled `timeout` shows `still running in background` only when a matching running `kind:'shell'` job is confirmed.

These rows are **runtime state, not history**. On any host's `reconnecting` transition — launch *or* remote — `clearRuntimeStateForServer(serverID)` drops that host's worker, shell-job and background-confirmation rows and invalidates their refresh epochs. Unaffected hosts keep their confirmed state; the launch-only stream badge and notice are untouched by a remote disconnect. Reconnect repopulates through the normal per-host resync (`onEvents(..., resync) → resync → loadConversation → refreshWorkers/refreshShellJobs`).

Deletion and unpair clear the same records: `forgetSession` removes `workers`/`shellJobs`/`backgrounded` for the deleted key, and `forgetServer` removes every map entry owned by the unpaired host. `reconcileRunning` also retires transient confirmations for sessions the host no longer reports running.

`refreshWorkers` and `refreshShellJobs` each carry **independent per-session epochs**. A response that arrives after the session was deleted, unpaired, disconnected or superseded by a newer refresh is discarded; ownership is rechecked against the server-qualified key before writing. An unsupported RPC is never treated as "job completed".

## Job request timing (#284, #297)

`experimental.job.list` is not requested for text or reasoning deltas. A tool call is a bounded probe hint: one immediate request and one deferred request 300 ms later, because a subagent job can be registered after the call event itself. Further tool starts coalesce into the pending probe, and `session.tool.progress` never adds a request. Shell/step/idle completion events still reconcile both job lists. The deferred probe is tied to the server-qualified session: deletion, unpair or teardown clears it before it can write. A live v2 disposable-service test starts a real `subagent` tool, observes a running job card before the child completes, and then releases it and observes settlement.

## Transient background confirmations (#129, #135)

Ctrl+B moves running tool calls to the background. The confirmation is rendered **inside the transcript**, not in the composer/footer, so the prompt bar never shifts (#129). It is **transient call status**, not persistent history:

- Each confirmation is an event owned by the exact `toolID` reported by `runningToolIDs()`. `attachBackgroundNotices()` inserts it immediately after the node that owns that call (`tool` or folded `tool-group`) via `nodeIndexForTool()`. There is no "last tool-looking node" fallback: a notice whose call is not in the current window is dropped rather than attached to a later, unrelated call.
- Repeated Ctrl+B updates the events for the still-running calls instead of duplicating them. Multiple concurrent calls produce individually keyed notices (`background:<toolID>`).
- Any execution transition (turn start or completion), a running-state reconciliation that drops the session, a disconnect, deletion or unpair clears the events. A later turn cannot resurrect an old notice.
- Windowing and collapse are safe because placement is derived from the folded node list itself; completion arriving right after the action leaves the confirmation until the turn actually ends.
