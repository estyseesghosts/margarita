# 11 — Goals, plans, task lists and durable guidance

## Requirement

Users need to **set goals and plans**, see progress, and update them independently of scrolling through chat. The TUI must remain minimalist: a `Ctrl+T`-toggleable short task checklist, or `/goal` and `/plan` commands, not a permanent planning sidebar. The representation should support the eventual replacement of OpenCode's default agents with custom primary agents.

## Distinguish three meanings

1. **Goal:** user-owned desired outcome, acceptance criteria and constraints. Persistent UI metadata; optionally shared with the model.
2. **Plan:** ordered or dependency-linked steps toward the goal; may be authored by user or proposed by assistant, but requires user acceptance before treated as authoritative.
3. **Task progress:** checkbox/status updates. The model may discuss tasks in prose, but the UI must not silently mark tasks done by keyword-matching assistant text.

OpenCode v2 has an **experimental durable instruction entries** route; it is suitable for sending model-facing guidance, not as a replacement for our structured task data store. See [`experimental.session.instructions.entry.put/list`](https://opencode.ai/docs/api). OpenCode also has `session.context` to inspect active context after compaction. [API](https://opencode.ai/docs/api).

## Versioned sidecar schema (proposed)

```ts
type GoalPlanV1 = {
  schemaVersion: 1;
  backend: string; sessionID: string; projectID: string;
  goal?: { title: string; detail?: string; acceptance: string[]; owner: 'user'|'agent'; updatedAt: string };
  plan?: { revision: number; source: 'user'|'agent-proposal'; accepted: boolean; updatedAt: string;
    tasks: Array<{
      id: string; title: string; description?: string;
      state: 'todo'|'in-progress'|'blocked'|'done'|'cancelled';
      deps: string[]; evidence?: Array<{messageID?:string; path?:string; note?:string}>;
      owner?:string; updatedAt:string;
    }>;
  };
  modelInstructionSync?: { enabled: boolean; key: string; revision: number; lastAckAt?: string };
}
```

This schema belongs to our frontend sidecar store. Store under platform app data (`XDG_DATA_HOME/unnamed` or Windows LocalAppData) with atomic writes and migration support; never write into the user's source repo implicitly. If the frontend is connecting to a remote server from several devices, local sidecar plans do not automatically synchronize: display `Local plan` until server sharing is implemented.

## User workflows

### Set goal

`/goal` opens inline editor/modal with title, criteria and constraints; `Ctrl+Enter` saves after validation if the terminal supports it, otherwise a visible Save option. To avoid extra noise, show only `Goal set: Fix Goldenrod regression` as a transient status. Option `Sync with agent` explicitly writes a compact instruction entry, e.g. `unnamed.goal.v1`, and records revision. Saving *local goal only* must not create an agent run.

### Propose plan

`/plan` opens plan editor and may offer `Ask agent to propose plan`, which sends a visible prompt through ordinary session API. A model's freeform plan is a **proposal**, not an automatically accepted set of executable tasks. User can accept, edit, reject. If a future structured plan integration is added, version and validate it before rendering.

### Track tasks

`Ctrl+T` toggles a compact checklist, not a split-pane. Show title and `2/7 complete`, each with `todo/in progress/blocked/done`. Keyboard navigate up/down, Space toggles or opens state selector; Enter opens detail/evidence. Esc closes. A task is only 'done' by explicit user change or a future trusted tool/plugin API operation. A statement like "I fixed it" from assistant is not enough to mutate data.

### Resume/detach

Plans and goals survive Left-arrow overview transition, app restarts, and session reattach. A plan can be displayed in overview as terse `4/7 tasks` metadata but not a multi-line wall. Forked sessions may copy plans at fork point with new session identity; don't alias both to one mutable plan.

## Model-facing context sync

`PUT /api/experimental/session/{id}/instructions/entries/{key}` can maintain a concise model-visible goal and active plan summary, with updates announced at the **next step boundary**. Ensure user controls whether to sync; show latest confirmed revision and errors. Include concise constraints and task statuses, avoiding giant 100-task dumps consuming context. If instruction entry API is absent or rejects request, preserve local state and display `Not synced to agent`. Do not force a compaction or restart the agent. [OpenCode instruction API](https://opencode.ai/docs/api).

### Example instruction text

```text
User goal (revision 3): Make Goldenrod scene consistently meet 30 FPS on Old 3DS.
Constraints: preserve visual accuracy; no New 3DS-only optimizations.
Accepted plan: 1) Profile draw submission [done], 2) Check culling [active],
3) Test on hardware [todo]. Acceptance: stable 30 FPS in sampled scene.
Do not assume UI task states are proof of implementation; cite tests/logs.
```

For stronger consistency, append `referenceId/plan revision` in tool-facing metadata where supported, but never invent such server behavior. Context injection should be opt-in and scope limited to current session.

## Plan conflict handling

Sidecar state carries revision + modification timestamp; concurrent frontend processes must not last-write-wins silently. Use atomic compare-and-swap revision if local shared file; on conflict, offer merge based on task IDs. A remote client without sidecar must see plan unavailable, not a fabricated empty plan. Future server plugin storage is optional and should use supported plugin RPC, not direct database writes. [OpenCode plugin RPC](https://opencode.ai/docs/api).

## Acceptance tests

- Set goal locally while offline; reconnect, sync explicitly and receive server acknowledgement.
- Agent running; update accepted plan; next model step sees revised instruction entry (verify against instrumentation) without duplicate prompt.
- Reopen TUI after restart; revisions and task states preserved.
- Model proposes plan but user rejects; task list remains unchanged.
- Two TUI instances edit same task concurrently; merge/409 visible, no silent loss.
- Plan sync API unavailable; user can still manage local plan with clear limitation.
