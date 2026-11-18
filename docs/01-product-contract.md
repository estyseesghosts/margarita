# 01 — Product contract: the terminal is enough

## The problem

OpenCode v2's standard full-screen UI is capable but structurally noisier than the Claude Code agent-session workflow. We want OpenCode's model/provider/agent backend with a Claude-like **minimal, readable, conversational terminal**. The unit of navigation is an **agent session**—not a panel, tab or split window. Avoid reproducing OpenCode's application chrome just because its source already provides it. [Sources: OpenCode v2 TUI app](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/tui/src/app.tsx), [Claude Code session workflow](https://code.claude.com/docs/en/sessions).

## Target users and jobs

A developer works across several repositories, each with one or more long-running sessions, and switches between local and remote models frequently. Typical jobs:

- From shell: `unnamed --provider openai --model gpt-6.1-sol --effort high "Analyze the renderer"`; start a new *interactive* session and submit the prompt without a secondary UI step.
- From a live session: press Left from an empty prompt to see the overview and send a different project/task prompt. The previous session still runs.
- See that another agent needs approval or finished; switch directly into it. No manual attach process.
- Follow the assistant answer without reading 15 lines of boilerplate `read`, `grep`, `ls` output; expand details when debugging.
- Inspect reasoning only when the provider actually returned it. Hidden reasoning is never approximated from token counts.
- Track running session token counts and spend in a compact, continuously accurate footer.
- Configure a goal and plan that survive UI detach/reconnect and can be explicitly revised.

## Non-goals

Do not implement terminal tabs, split panes, an embedded shell multiplexer, window management, a desktop GUI, cloud storage for conversations, a separate agent runtime, model transport, new tool execution, a plugin marketplace, a shared collaborative editor, or a full OpenCode native-TUI plugin renderer. Commands typed in `!` shell mode are intentional user operations, not an embedded PTY tab. Deep debugging consoles, floating metadata panels and persistent file trees are out.

## Design vocabulary

- **Overview**: project-grouped session list and global new-session composer.
- **Session view**: one conversation plus input and slim footer; no header.
- **Agent**: OpenCode server's named agent (initially `build`, `plan`, plus discoverable custom agents). `Shift+Tab` cycles these.
- **Model**: provider and model ID, optionally a variant. Model choice is separate from agent.
- **Task**: user-defined atomic goal step, not necessarily an OpenCode tool call.
- **Detached view**: frontend is showing something else. Server execution persists unchanged.
- **Background tool**: a *different* OpenCode action that backgrounds a blocking tool. Do not call it on ordinary navigation.
- **Idle/working/waiting/failed**: projected status, never a client-controlled claim about backend execution.

## Primary flows / acceptance stories

### A. Start from a shell and stay interactive

1. Enter `unnamed --provider openai --model gpt-6.1-sol --effort high "Inspect Goldenrod draw submission"` in project root.
2. CLI validates provider+model+variant against connected catalog; warns/fails if absent.
3. Finds or starts OpenCode background service; detects project root and working directory.
4. Creates session (no ambiguity about `--continue`), selects `build`, selects model/variant, sends prompt durably and attaches conversation view.
5. User can interrupt, switch agents, view transcript and return to overview. Exiting UI leaves session history intact.

### B. Background *the session view* and start another

1. Session A is executing. Composer empty and no modal active. Press Left once.
2. Overview appears immediately. Session A still marked Running.
3. New-session composer is focused; type prompt for current project; Enter creates B and switches into it.
4. Left again shows A and B. Select A with arrows and Enter; execution and messages are continuous.
5. If another UI instance is attached to A, both see server state; neither becomes automatically the exclusive owner.

### C. Minimal default transcript

Assistant reports findings and grouped progress. Reading three files produces `Read 3 files`, not three full file bodies. A failed build prints a clear red/error line even if grouped. Ctrl+O reveals individual calls, timestamps, inputs and outputs, and reasoning parts when available. Collapse state is a **presentation preference** and never deletes data.

### D. Goals and plans

User enters `/goal` or `/plan` and can view structured goal/tasks. A planned task can be marked pending/in progress/blocked/done, either manually or by an explicit structured adapter. Goals can be injected as **session instruction entries only by opt-in**. No silent background prompt to the model for updating UI tasks. Source: [OpenCode experimental instruction entries](https://opencode.ai/docs/api).

## Visibility requirements

**Session view**: transcript 80–90% of horizontal footprint, composer bottom, single-line footer. Show model/agent only in footer. Display current directory only in overview or terminal title; allow an optional very-short path in footer but default OFF. Never show the suggested previous header bar. If a permission/form is pending, a temporary focused modal can supersede the composer.

**Overview**: name/path of current project, sessions grouped by canonical directory, state, last activity, first-line summary/title, optional model and agent as secondary metadata. New-session prompt at bottom; shortcuts legend appears on request, not permanently.

**Controls**: `Shift+Tab` next agent; optional `Alt+Shift+Tab` previous if reliable; `Alt+P` model selection; `Ctrl+O` transcript verbosity; `Ctrl+T` goals/tasks; Left on an empty composer overview. No sequences resembling `Ctrl+X` followed by a letter; even an escape prefix command palette should not be required for normal operations.

## Layout examples (text wireframes, not terminal implementation)

Session, idle:

```text
> Investigate Goldenrod rendering. Don't edit yet.

  Read 7 files · 2 searches                    (collapsed)
  Found a likely invalidation issue in the render queue.
  ...

> _
  build · openai/gpt-6.1-sol#high   idle   37.2k tokens   $0.42
```

Overview, while sessions continue:

```text
Projects / Sessions

  kohjoh                            C:\src\kohjoh
  > Goldenrod renderer           working   2m ago
    Investigate silver bell crash waiting   9m ago

  lotus                             C:\src\lotus
    Debug renderer stall         idle      1h ago

  New session in: kohjoh
  > _
```

Do not imitate these borders if the renderer would add visual noise. Use whitespace and subtle emphasis, not heavy boxes; do not render a conversation header.

## Operating principles

- Server-owned state wins. UI preferences and drafts are local.
- Display facts only after server confirms. Optimistic UI should clearly show pending.
- Terminal failure or app close cannot cancel a running session.
- Input responsiveness precedes aesthetic animation.
- Project grouping must work when multiple repositories share a single server.
- Every keybinding has a discoverable action name, but no chords.
- A missing backend feature gets a visible graceful downgrade, never a pretend success.

## Exit criteria

A user unfamiliar with this frontend should be able to run a positional prompt, detach to overview with one Left, start a second session in overview, reattach A, see its actual token/spend counters, expand an opaque tool batch, and switch `build → plan` with Shift+Tab, all without opening a tab or palette.
